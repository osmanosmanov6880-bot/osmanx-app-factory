import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {parseStoredZip} from '../src/common/archive.mjs';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {validateFleetEnvelope} from '../src/studio/fleet.mjs';
const factory=resolve(import.meta.dirname,'..');
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const result=server.address().port;await new Promise(resolve=>server.close(resolve));return result;}
async function run(type){
 const temp=await mkdtemp(join(tmpdir(),'ox-r36-real-'));const installation=join(temp,'install');const id=randomUUID();
 const project={id,name:'Synthetic '+type,type,industry:type==='site'?'business':'restaurant',modules:type==='site'?['auth','cms','leads']:['auth','clients'],settings:{accent:'#536678',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]};
 let child;
 try{
  await mkdir(installation);
  const entries=parseStoredZip(await exportDeploymentBundle(project,factory,'synthetic.example.org'),{maxFiles:450,maxBytes:90e6});
  for(const [name,bytes] of entries){const path=join(installation,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes)}
  const port=await freePort(),dataDir=join(installation,'data');
  child=spawn(process.execPath,['run.mjs'],{cwd:installation,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dataDir,COOKIE_SECURE:'0'},stdio:'ignore'});
  let success=false;
  for(let tries=0;tries<100;tries++){
   if(child.exitCode!==null)throw Error('Exported application crashed on startup');
   try{const response=await fetch('http://127.0.0.1:'+port+'/api/health');if(response.status===200){success=true;break}}catch{}
   await new Promise(resolve=>setTimeout(resolve,75));
  }
  assert.equal(success,true);
  const responses=await Promise.all(Array.from({length:12},()=>fetch('http://127.0.0.1:'+port+'/api/health')));
  assert.ok(responses.every(x=>x.status===200));
  await fetch('http://127.0.0.1:'+port+'/r36-intentional-not-found');
  child.kill('SIGTERM');await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Drain hung')),10000);child.once('exit',(code)=>{clearTimeout(t);code===0?resolve():reject(Error('Nonzero exit '+code))})});child=null;
  const cmd=(args)=>{const result=spawnSync(process.execPath,args,{cwd:installation,encoding:'utf8',timeout:10000});if(result.status!==0)throw Error(result.stderr);return JSON.parse(result.stdout.trim())};
  const metrics=cmd(['deploy/telemetry-read.mjs']);
  assert.equal(metrics.status,'observed');assert.ok(metrics.requests>=13);
  cmd(['deploy/fleet-agent.mjs','init','--confirm']);
  const pub=cmd(['deploy/fleet-agent.mjs','public']);
  const output=join(temp,'signed.json');
  const saved=cmd(['deploy/fleet-agent.mjs','snapshot','--out='+output,'--telemetry']);
  assert.equal(saved.telemetryIncluded,true);
  const packet=JSON.parse(await readFile(output,'utf8'));
  const payload=validateFleetEnvelope(packet,pub.publicKeyPem,id);
  assert.equal(payload.version,3);assert.equal(payload.telemetry.status,'observed');
  assert.ok(!JSON.stringify(packet).includes('intentional-not-found'));
  return {type,requests:metrics.requests,serverErrors:metrics.serverErrors,verifiedSignature:true};
 }finally{
  if(child){child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const t=setTimeout(()=>{child.kill('SIGKILL');resolve()},3000);child.once('exit',()=>{clearTimeout(t);resolve()})})}
  await rm(temp,{recursive:true,force:true});
 }
}
for(const type of ['crm','site'])test('R3.6 independent '+type+' HTTP -> private counters -> signed offline telemetry', {timeout:60000},async()=>{
 const result=await run(type);assert.equal(result.verifiedSignature,true);
});
