/**
 * R3.6: bounded, privacy-safe HTTP status counters for standalone installations.
 * NEVER stores URLs, query strings, user IDs, IPs, payloads, or stack traces.
 * Counters are best-effort and not a substitute for an audit log or alerting.
 */
import {randomBytes} from 'node:crypto';
import {mkdir, lstat, readFile, open, rename, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';

const ensure=(yes,reason)=>{if(!yes)throw Error(reason)};
const period=3600_000;
const integer=n=>Number.isSafeInteger(n)&&n>=0&&n<=1_000_000_000;
const hour=ms=>Math.floor(ms/period)*period;
const within=ms=>Number.isFinite(ms)&&ms>=Date.UTC(2020,0,1)&&ms<=Date.now()+period;
function validBucket(b){return b&&typeof b==='object'&&!Array.isArray(b)&&
 Object.keys(b).sort().join(',')==='clientErrors,hour,maintenanceUnavailable,requests,serverErrors'&&
 Number.isSafeInteger(b.hour)&&b.hour>=Date.UTC(2020,0,1)&&b.hour%period===0&&['requests','clientErrors','serverErrors','maintenanceUnavailable'].every(k=>integer(b[k]))&&
 b.serverErrors+b.clientErrors<=b.requests&&b.maintenanceUnavailable<=b.serverErrors;}
async function assertPrivate(path,directory){
 const st=await lstat(path);
 ensure(!st.isSymbolicLink()&&(directory?st.isDirectory():st.isFile()),'Unsafe observability storage path');
 if(process.platform!=='win32')ensure((st.mode&0o077)===0,'Observability storage must be private');
 return st;
}
export function summarizeRuntimeCounters(state,{now=Date.now()}={}){
 ensure(state?.format==='osmanx-runtime-counters'&&state.version===1&&Array.isArray(state.buckets),'Invalid runtime counters');
 const cutoff=hour(now)-23*period;
 const buckets=state.buckets.filter(b=>validBucket(b)&&b.hour>=cutoff&&b.hour<=hour(now));
 const totals={requests:0,clientErrors:0,serverErrors:0,maintenanceUnavailable:0};
 for(const b of buckets)for(const key of Object.keys(totals))totals[key]+=b[key];
 const updatedAt=state.updatedAt||null;
 const recent=updatedAt&&Number.isFinite(Date.parse(updatedAt))&&now-Date.parse(updatedAt)>=0&&now-Date.parse(updatedAt)<=24*period;
 return {status:recent?'observed':updatedAt?'stale':'unavailable',windowHours:24,
  capturedAt:updatedAt,...totals};
}
export async function loadRuntimeSummary({dataDir,projectId,service,releaseSequence,now=Date.now()}={}){
 const path=join(resolve(dataDir),'.osmanx-observability','summary.json');
 try{
  const folder=await assertPrivate(join(resolve(dataDir),'.osmanx-observability'),true);
  const st=await assertPrivate(path,false);ensure(st.size<=16384,'Oversized observability summary');
  const value=JSON.parse(await readFile(path,'utf8'));
  ensure(value?.format==='osmanx-runtime-counters'&&value.version===1&&
   value.projectId===projectId&&value.service===service&&value.releaseSequence===releaseSequence&&
   Array.isArray(value.buckets)&&value.buckets.length<=24&&value.buckets.every(validBucket)&&
   value.buckets.every(b=>b.hour<=hour(now))&&
   (value.updatedAt===null||typeof value.updatedAt==='string'&&Number.isFinite(Date.parse(value.updatedAt))),
   'Runtime counter installation identity or data invalid');
  return summarizeRuntimeCounters(value,{now});
 }catch(error){
  if(error.code==='ENOENT')return {status:'unavailable',windowHours:24,capturedAt:null,requests:0,clientErrors:0,serverErrors:0,maintenanceUnavailable:0};
  throw error;
 }
}
export async function createRuntimeCounters({dataDir,projectId,service,releaseSequence,clock=()=>Date.now(),flushDelayMs=2000}={}){
 ensure(typeof dataDir==='string'&&/^[a-f\d-]{36}$/i.test(projectId||'')&&['crm','site'].includes(service)&&
  Number.isSafeInteger(releaseSequence)&&releaseSequence>=0&&Number.isInteger(flushDelayMs)&&flushDelayMs>=0&&flushDelayMs<=60000,
  'Invalid runtime observability configuration');
 const dir=join(resolve(dataDir),'.osmanx-observability');
 await mkdir(dir,{recursive:true,mode:0o700});await assertPrivate(dir,true);
 const file=join(dir,'summary.json');
 const state={format:'osmanx-runtime-counters',version:1,projectId,service,releaseSequence,updatedAt:null,buckets:[]};
 try{
  const stat=await assertPrivate(file,false);ensure(stat.size<=16384,'Oversized observability summary');
  const old=JSON.parse(await readFile(file,'utf8'));
  ensure(old?.format===state.format&&old.version===1&&old.projectId===projectId&&old.service===service&&
   Array.isArray(old.buckets)&&old.buckets.length<=24&&old.buckets.every(validBucket),
   'Unsafe runtime counter identity or values');
  // Across releases, counters intentionally start fresh; never mix release data.
  if(old.releaseSequence===releaseSequence){state.buckets=old.buckets;state.updatedAt=old.updatedAt;}
 }catch(error){if(error.code!=='ENOENT')throw error;}
 let timer=null,writer=Promise.resolve(),error=null,dirty=false;
 const flush=async()=>{
  if(timer){clearTimeout(timer);timer=null;}
  if(!dirty){await writer;if(error)throw error;return}
  dirty=false;state.updatedAt=new Date(clock()).toISOString();
  const buffer=Buffer.from(JSON.stringify(state)+'\n');
  ensure(buffer.length<=16384,'Runtime counters exceed size budget');
  const tmp=file+'.tmp-'+randomBytes(8).toString('hex');
  const write=async()=>{
   await assertPrivate(dir,true);
   try{await assertPrivate(file,false)}catch(e){if(e.code!=='ENOENT')throw e}
   const f=await open(tmp,'wx',0o600);
   try{await f.writeFile(buffer);await f.sync()}finally{await f.close()}
   await rename(tmp,file);
   if(process.platform!=='win32'){const d=await open(dir,'r');try{await d.sync()}finally{await d.close()}}
  };
  writer=writer.then(write).catch(e=>{error=e}).finally(()=>rm(tmp,{force:true}));
  await writer;if(error)throw error;
 };
 const record=status=>{
  if(!Number.isInteger(status)||status<100||status>599)return;
  const time=clock(),h=hour(time);
  if(!within(time))return;
  let b=state.buckets.find(x=>x.hour===h);
  if(!b){b={hour:h,requests:0,clientErrors:0,serverErrors:0,maintenanceUnavailable:0};state.buckets.push(b);}
  b.requests++;if(status>=500)b.serverErrors++;else if(status>=400)b.clientErrors++;
  if(status===503)b.maintenanceUnavailable++;
  state.buckets=state.buckets.filter(x=>x.hour>=h-23*period&&x.hour<=h).slice(-24);
  dirty=true;
  if(!timer){timer=setTimeout(()=>{flush().catch(e=>{error=e})},flushDelayMs);timer.unref?.()}
 };
 return {record,flush,summary:()=>summarizeRuntimeCounters(state,{now:clock()}),get failure(){return error}};
}
