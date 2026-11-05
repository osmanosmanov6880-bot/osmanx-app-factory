/**
 * OSMANX R2.9: bounded local Docker rollout observation.
 * Read-only Docker checks; never sends network requests or reads client records.
 * Records only container-state counters and release identifiers in private local files.
 */
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, lstat, rename, rm, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECK_DIR='.osmanx-rollout';
const assert=(condition, message)=>{if(!condition)throw Error(message)};
const idPattern=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const safeId=/^[a-f\d]{12,64}$/i;
const sha=buffer=>createHash('sha256').update(buffer).digest('hex');
const wait=ms=>new Promise(done=>setTimeout(done,ms));

async function nonLink(path,kind) {
 const s=await lstat(path);
 assert(!s.isSymbolicLink() && (kind==='dir'?s.isDirectory():s.isFile()),'Unsafe rollout '+kind+' path: '+path);
 return s;
}
async function trustedDirectory(path,{create=false}={}) {
 if(create && !existsSync(path))await mkdir(path,{mode:0o700});
 const s=await nonLink(path,'dir');
 if(process.platform!=='win32')assert((s.mode&0o077)===0,'Rollout history directory must be private');
}
async function readIdentity(root) {
 await nonLink(root,'dir');
 const appPath=join(root,'manifest.json'),depPath=join(root,'deploy','manifest.json');
 await nonLink(appPath,'file');await nonLink(depPath,'file');
 const [app,dep]=await Promise.all([readFile(appPath,'utf8').then(JSON.parse),readFile(depPath,'utf8').then(JSON.parse)]);
 assert(app.manifestVersion===1&&idPattern.test(app.projectId)&&dep.format==='osmanx-deployment-kit'&&dep.version===2&&dep.projectId===app.projectId,'Invalid local deployment identity');
 const expected='osmanx_'+app.projectId.replaceAll('-','').slice(0,12);
 assert(dep.composeProject===expected,'Unexpected Compose project name');
 assert(Number.isSafeInteger(app.release?.sequence)&&app.release.sequence>=0,'Missing release sequence');
 assert(dep.applicationManifestSha256===sha(await readFile(appPath)),'Release identity hash mismatch');
 return {projectId:app.projectId,composeProject:dep.composeProject,sequence:app.release.sequence,domain:dep.domain};
}
function docker(root,args,timeout=15000) {
 const r=spawnSync('docker',args,{cwd:root,encoding:'utf8',timeout,maxBuffer:65536});
 if(r.error||r.status!==0)throw Error('Docker observation failed: '+String(r.error?.message||r.stderr||r.stdout).slice(0,300));
 return String(r.stdout||'').trim();
}
export function localDockerObserver() {
 return {
  async inspect(root) {
   const id=docker(root,['compose','ps','-q','app']);
   assert(safeId.test(id),'Expected exactly one valid app container ID');
   const raw=docker(root,['inspect','--format','{{json .State}}',id]);
   let state;try{state=JSON.parse(raw)}catch{throw Error('Docker returned invalid container state')}
   const restart=Number(docker(root,['inspect','--format','{{.RestartCount}}',id]));
   const project=docker(root,['inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',id]);
   assert(Number.isSafeInteger(restart)&&restart>=0,'Invalid Docker restart count');
   return {id,project,status:state?.Status,health:state?.Health?.Status||'unknown',restartCount:restart};
  },
  async health(root) {docker(root,['compose','exec','-T','app','node','deploy/healthcheck.mjs'],20000);}
 };
}
export async function getRolloutReports({root,limit=10}) {
 root=resolve(root);assert(Number.isInteger(limit)&&limit>=1&&limit<=30,'Invalid history limit');
 const dir=join(root,CHECK_DIR);
 if(!existsSync(dir))return [];
 await trustedDirectory(dir);
 const names=(await readdir(dir)).filter(n=>/^\d{8}T\d{6}-[a-f\d]{12}\.json$/.test(n)).sort().reverse().slice(0,limit);
 const reports=[];
 for(const name of names){const file=join(dir,name);await nonLink(file,'file');reports.push(JSON.parse(await readFile(file,'utf8')))}
 return reports;
}
async function persist(root,result) {
 const directory=join(root,CHECK_DIR);
 await trustedDirectory(directory,{create:true});
 const id=new Date().toISOString().replace(/[-:]/g,'').replace(/\..*/, '')+'-'+randomBytes(6).toString('hex');
 const target=join(directory,id+'.json');
 const temp=target+'.tmp';
 try{
  await writeFile(temp,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
  const handle=await open(temp,'r');try{await handle.sync()}finally{await handle.close()}
  await rename(temp,target);
 }finally{await rm(temp,{force:true})}
 return target;
}
/** Fail closed on unhealthy state, container replacement, or restarts during the observation. */
export async function observeRollout({root,samples=3,intervalMs=3000,adapter=localDockerObserver(),sleep=wait,record=false}={}) {
 root=resolve(root);
 assert(Number.isInteger(samples)&&samples>=2&&samples<=12,'Samples must be between 2 and 12');
 assert(Number.isInteger(intervalMs)&&intervalMs>=0&&intervalMs<=30000&&intervalMs*(samples-1)<=120000,'Observation interval exceeds allowed window');
 const identity=await readIdentity(root);
 const events=[];let baseline=null;let failed=null;
 for(let i=0;i<samples;i++){
  if(i>0)await sleep(intervalMs);
  try{
   const value=await adapter.inspect(root);
   assert(value&&safeId.test(value.id),'Invalid app container ID');
   assert(value.project===identity.composeProject,'Wrong Compose project container');
   assert(value.status==='running'&&value.health==='healthy','App is not running and healthy');
   assert(Number.isSafeInteger(value.restartCount)&&value.restartCount>=0,'Invalid restart count');
   if(baseline){assert(value.id===baseline.id,'App container replaced during observation');
    assert(value.restartCount===baseline.restartCount,'App restarted during observation');}
   else {assert(value.restartCount===0,'App restarted before observation');baseline=value;}
   await adapter.health(root);
   events.push({sample:i+1,status:'healthy',restartCount:value.restartCount});
  }catch(e){failed=e.message.slice(0,250);events.push({sample:i+1,status:'failed'});break;}
 }
 const report={format:'osmanx-rollout-report',version:1,projectId:identity.projectId,
  releaseSequence:identity.sequence,composeProject:identity.composeProject,
  checkedAt:new Date().toISOString(),samplesRequested:samples,samplesCompleted:events.length,
  observedStable:failed===null&&events.length===samples,publicHttpsVerified:false,
  records:events,error:failed};
 if(record)await persist(root,report);
 if(failed)throw Error('Rollout stability gate failed: '+failed);
 return report;
}

const main=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(main){
 const args=process.argv.slice(2),command=args[0];
 const installed=args.find(x=>x.startsWith('--installed='));
 const root=resolve(installed?installed.slice('--installed='.length):dirname(dirname(fileURLToPath(import.meta.url))));
 process.umask(0o077);
 const action=async()=>{
  if(command==='observe') {
   const count=args.find(x=>x.startsWith('--samples=')),delay=args.find(x=>x.startsWith('--interval-ms='));
   const samples=count?Number(count.slice(10)):3,intervalMs=delay?Number(delay.slice(14)):3000;
   return observeRollout({root,samples,intervalMs,record:true});
  }
  if(command==='history')return getRolloutReports({root});
  throw Error('Usage: node deploy/rollout-observe.mjs observe [--samples=3 --interval-ms=3000] | history [--installed=/absolute/path]');
 };
 action().then(out=>console.log(JSON.stringify(out,null,2))).catch(e=>{console.error('OSMANX ROLLOUT: '+e.message);process.exitCode=1});
}
