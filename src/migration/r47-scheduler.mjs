// R4.7: deterministic, HMAC-protected schedule checkpoints and crash retry.
// The scheduler runs only for explicitly configured synthetic tenant IDs.
import {createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import {mkdir,open,readFile,rename,unlink,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const FORMAT='osmanx-r47-schedule-v1',UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
function guard(ok,msg){if(!ok)throw Error('R4.7 scheduler refused: '+msg);}
function signature(key,data){return createHmac('sha256',key)
  .update('OSMANX-R47-SCHEDULE-v1\0').update(data).digest('hex');}
function safeEqual(a,b){return typeof a==='string'&&HEX.test(a)&&
  timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
export function assessR47BackupHealth(state,{now=Date.now(),maxAgeMinutes=180}={}){
  guard(Number.isFinite(now)&&Number.isSafeInteger(maxAgeMinutes)&&maxAgeMinutes>=2&&maxAgeMinutes<=10080,
    'invalid health threshold');
  const last=state?.lastSuccessAt?Date.parse(state.lastSuccessAt):NaN;
  const ageMinutes=Number.isFinite(last)?Math.max(0,Math.floor((now-last)/60000)):null;
  const healthy=state?.status==='ok'&&ageMinutes!==null&&ageMinutes<=maxAgeMinutes;
  return {healthy,status:!state?'never-backed-up':healthy?'healthy':
    state.status==='running'?'running':state.status==='failed'?'degraded':'stale',
    ageMinutes,lastSuccessAt:state?.lastSuccessAt||null,
    lastAttemptAt:state?.lastAttemptAt||null,failures:state?.failedAttempts||0,
    productionCutoverAllowed:false};
}
async function location(input){
  guard(typeof input?.directory==='string'&&input.directory.length>0&&
    UUID.test(input.projectId||'')&&Buffer.isBuffer(input.catalogKey)&&
    input.catalogKey.length===32,'private per-project schedule scope required');
  const folder=resolve(input.directory);
  await mkdir(folder,{recursive:true,mode:0o700});
  const st=await lstat(folder);
  guard(st.isDirectory()&&!st.isSymbolicLink(),'unsafe scheduler directory');
  if(process.platform!=='win32')guard((st.mode&0o077)===0,'schedule directory must be mode 0700');
  return folder;
}
async function readState(folder,input){
  let s;try{s=await readFile(join(folder,'state.json'),'utf8');}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
  guard(Buffer.byteLength(s)<=8192,'schedule state too large');
  let record;try{record=JSON.parse(s);}catch{throw Error('R4.7 scheduler refused: corrupted schedule JSON');}
  const {mac,...data}=record;
  guard(data.format===FORMAT&&data.projectId===input.projectId&&
    Number.isSafeInteger(data.sequence)&&data.sequence>0&&
    ['running','ok','failed'].includes(data.status)&&
    typeof data.lastAttemptAt==='string'&&
    (data.lastSuccessAt===null||typeof data.lastSuccessAt==='string')&&
    Number.isSafeInteger(data.failedAttempts)&&data.failedAttempts>=0&&
    safeEqual(mac,signature(input.catalogKey,JSON.stringify(data))),
    'schedule checkpoint authentication failed');
  return data;
}
async function persist(folder,input,data){
  const record={...data,mac:signature(input.catalogKey,JSON.stringify(data))};
  const stage=join(folder,'.pending-'+randomBytes(12).toString('hex'));
  let f;
  try{
    f=await open(stage,'wx',0o600);await f.writeFile(JSON.stringify(record)+'\n');
    await f.sync();await f.close();f=null;
    await rename(stage,join(folder,'state.json'));
    if(process.platform!=='win32'){
      const d=await open(folder,'r');try{await d.sync();}finally{await d.close();}
    }
  }finally{await f?.close();await unlink(stage).catch(()=>{});}
}
export async function readR47Schedule(input){
  const folder=await location(input);
  return readState(folder,input);
}
export async function runR47DueTick(input,{
  now=Date.now(),intervalMinutes=60,minRetryMinutes=1,execute
}={}){
  guard(typeof execute==='function'&&Number.isFinite(now)&&
    Number.isSafeInteger(intervalMinutes)&&intervalMinutes>=1&&intervalMinutes<=1440&&
    Number.isSafeInteger(minRetryMinutes)&&minRetryMinutes>=1&&minRetryMinutes<=60,
    'schedule interval or executor invalid');
  const folder=await location(input);
  const file=join(folder,'.run.lock');
  const lock=await open(file,'wx',0o600); // stale lock requires operator review
  try{
    let state=await readState(folder,input);
    if(state&&Date.parse(state.lastAttemptAt)>now+60000)
      throw Error('R4.7 scheduler refused: time moved backwards');
    const since=state?now-Date.parse(state.lastAttemptAt):Infinity;
    const last=state?.lastSuccessAt?Date.parse(state.lastSuccessAt):NaN;
    if(state?.status==='running'&&since<minRetryMinutes*60000)
      return {ran:false,reason:'prior-run-pending',state};
    if(state?.status==='failed'&&since<minRetryMinutes*60000)
      return {ran:false,reason:'retry-backoff',state};
    if(state?.status==='ok'&&Number.isFinite(last)&&now-last<intervalMinutes*60000)
      return {ran:false,reason:'not-due',state};
    const interrupted=state?.status==='running';
    state={format:FORMAT,projectId:input.projectId,sequence:(state?.sequence||0)+1,
      status:'running',lastAttemptAt:new Date(now).toISOString(),
      lastSuccessAt:state?.lastSuccessAt||null,failedAttempts:state?.failedAttempts||0};
    await persist(folder,input,state);
    try{
      const value=await execute({interrupted,projectId:input.projectId});
      guard(value?.remoteReadbackVerified===true&&
        value?.restoredIntegrityVerified===true&&
        value?.productionCutoverAllowed===false,'remote restore proof not accepted');
      state={...state,sequence:state.sequence+1,status:'ok',
        lastSuccessAt:new Date(now).toISOString(),failedAttempts:0};
      await persist(folder,input,state);
      return {ran:true,recoveredInterruptedRun:interrupted,state,proof:value};
    }catch(error){
      state={...state,sequence:state.sequence+1,status:'failed',
        failedAttempts:state.failedAttempts+1};
      await persist(folder,input,state);
      throw error;
    }
  }finally{await lock.close();await unlink(file);}
}
export function startR47Scheduler({projects=[],run,periodMs=60000,onError=()=>{}}={}){
  guard(Array.isArray(projects)&&projects.length<=20&&
    projects.every(p=>UUID.test(p))&&new Set(projects).size===projects.length&&
    typeof run==='function'&&Number.isSafeInteger(periodMs)&&periodMs>=1000,
    'invalid scheduled project registry');
  let busy=false,stopped=false;
  const tick=async()=>{
    if(busy||stopped)return;
    busy=true;
    try{for(const id of projects){if(stopped)break;try{await run(id);}catch(err){onError(id,err);}}}
    finally{busy=false;}
  };
  const timer=setInterval(()=>{void tick();},periodMs);
  timer.unref?.();
  return {tick,stop(){stopped=true;clearInterval(timer);}};
}
