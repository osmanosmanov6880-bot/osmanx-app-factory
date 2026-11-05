/** Verify all six R3.6 ZIPs by extracting and starting independent Node HTTP servers. */
import { spawn,spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join,dirname } from 'node:path';
import { parseStoredZip } from '../src/common/archive.mjs';
const input=resolve(process.argv[2]||'../../r36_client_exports');
const codes=['RESTAURANT','DENTAL','AUTO','BEAUTY','RETAIL','SITE'];
const temp=await mkdtemp(join(tmpdir(),'osmanx-r35-validation-'));
const port=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 for(const kind of codes){
  const file=join(input,`OSMANX_${kind}_R36_PREVIEW_DEPLOY.zip`);
  const bytes=await readFile(file),entries=parseStoredZip(bytes,{maxFiles:400,maxBytes:80*1024*1024});
  const out=join(temp,kind);await mkdir(out);
  for(const [name,data] of entries){await mkdir(dirname(join(out,name)),{recursive:true});await writeFile(join(out,name),data)}
  for(const tool of [['deploy/verify.mjs'],['deploy/volume-migrate.mjs','status'],['deploy/upgrade.mjs','status'],['deploy/rollout-observe.mjs','history'],['deploy/trust-policy.mjs','status']]){
    const r=spawnSync(process.execPath,tool,{cwd:out,encoding:'utf8'});
    if(r.status!==0)throw Error(kind+' local CLI failed: '+tool.join(' ')+' '+r.stderr);
  }
  const d=JSON.parse(entries.get('deploy/manifest.json'));
  if(!entries.has('deploy/fleet-agent.mjs')||!entries.has('deploy/telemetry-read.mjs')||!entries.has('src/common/runtime-health.mjs')||!entries.get('.dockerignore').toString().includes('.osmanx-fleet')||!entries.get('.gitignore').toString().includes('.osmanx-fleet')||!entries.has('src/common/request-drain.mjs')||!entries.has('deploy/volume-migrate.mjs')||!entries.has('deploy/rollout-observe.mjs')||!entries.has('deploy/signature.mjs')||!entries.has('deploy/trust-policy.mjs')||!entries.has('deploy/doctor.mjs')||d.version!==2)throw Error('Missing R3.6 deployment features in '+kind);
  if(!['deploy/signature.mjs','deploy/trust-policy.mjs','deploy/doctor.mjs','deploy/fleet-agent.mjs','deploy/telemetry-read.mjs'].every(n=>/^[0-9a-f]{64}$/.test(d.files[n]||'')))throw Error('Unsigned verifier file hash missing: '+kind);
  const p=await port();const proc=spawn(process.execPath,['run.mjs'],{cwd:out,env:{...process.env,PORT:String(p),HOST:'127.0.0.1',DATA_DIR:join(out,'data'),COOKIE_SECURE:'0',NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
  let log='';proc.stdout.on('data',b=>log+=b);proc.stderr.on('data',b=>log+=b);
  try{
   let result;
   for(let i=0;i<100;i++){
    if(proc.exitCode!==null)throw Error(kind+' exited unexpectedly: '+log);
    try{const r=await fetch('http://127.0.0.1:'+p+'/api/health');if(r.status===200){result=await r.json();break}}catch{}
    await wait(100);
   }
   if(result?.ok!==true)throw Error(kind+' health check failed: '+log);
   const identity=JSON.parse(entries.get('manifest.json'));
   if(result.deployment?.projectId!==identity.projectId || result.deployment?.releaseSequence!==identity.release.sequence)
     throw Error(kind+' does not return its own release identity');
   if(!/reclaimDeadLock/.test(entries.get('deploy/upgrade.mjs').toString('utf8'))||!/createRequestDrain/.test(entries.get('run.mjs').toString('utf8'))||!/createRuntimeCounters/.test(entries.get('run.mjs').toString('utf8')))
     throw Error(kind+' missing R3.6 forward-recovery implementation');
   console.log(kind+' : HTTP 200 /api/health, package verified, migration CLI present');
  }finally{proc.kill('SIGTERM');await Promise.race([new Promise(ok=>proc.once('exit',ok)),wait(2000)])}
 }
 console.log('R3.6 SAMPLES: 6/6 PASS (Node HTTP + release identity; Docker and public HTTPS not run)');
}finally{await rm(temp,{recursive:true,force:true})}
