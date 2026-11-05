/**
 * Docker runner-only, isolated synthetic client installation smoke test.
 * No external ports published; no real customer data; all temporary volumes removed.
 */
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {initFleetIdentity,signFleetSnapshot,createFleetSnapshot} from '../templates/deploy/fleet-agent.mjs';
import {validateFleetEnvelope} from '../src/studio/fleet.mjs';
const src=resolve(import.meta.dirname,'..');
const run=(args,cwd,timeout=300000)=>{
 const result=spawnSync(args[0],args.slice(1),{cwd,encoding:'utf8',timeout,maxBuffer:2*1024*1024});
 if(result.status!==0||result.error)throw Error(args.join(' ')+' failed: '+String(result.stderr||result.error?.message||result.stdout).slice(-600));
 return result.stdout;
};
export async function scenario(type,{runCommand=run}={}){
 const exec=(...args)=>runCommand(...args);
 const root=await mkdtemp(join(tmpdir(),'ox-r34-docker-'));
 const id=randomUUID(),project={id,name:'R34 Synthetic Docker',type,industry:type==='site'?'business':'restaurant',
  modules:type==='site'?['auth','cms','leads']:['auth','clients','tasks'],
  settings:{accent:'#829b84',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]};
 let composeAttempted=false,cleanupFailed=null,primaryError=null,result=null;
 try{
  const entries=parseStoredZip(await exportDeploymentBundle(project,src,'local.example.org'),{maxFiles:450,maxBytes:90e6});
  for(const [name,bytes] of entries){const target=join(root,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes)}
  exec([process.execPath,'deploy/prepare.mjs'],root,30000);
  exec([process.execPath,'deploy/verify.mjs'],root,30000);
  exec([process.execPath,'deploy/preflight.mjs'],root,30000);
  const {publicKeyPem}=await initFleetIdentity(root);
  const payload=await createFleetSnapshot({root});
  const signed=await signFleetSnapshot({root,payload});
  validateFleetEnvelope(signed,publicKeyPem,id);
  const compose=await readFile(join(root,'compose.yaml'),'utf8');
  if(/\n\s*ports:\s*\n\s*-\s*["']?418[01]:/.test(compose))throw Error('Application port unexpectedly published');
  composeAttempted=true;
  exec(['docker','compose','config','--quiet'],root);
  exec(['docker','compose','up','-d','--build','--wait','app'],root);
  exec(['docker','compose','exec','-T','app','node','deploy/healthcheck.mjs'],root,30000);
  const running=exec(['docker','compose','ps','-q','app'],root).trim();
  if(!/^[a-f\d]{12,64}$/i.test(running))throw Error('No running synthetic app');
  result={type,isolated:true,containerRunning:true,healthcheckPassed:true,
    signatureVerified:true,customerDataUsed:false,externalPortsPublished:false};
 }catch(e){primaryError=e}
 finally{
  if(composeAttempted){
   try{exec(['docker','compose','down','--volumes','--remove-orphans'],root,120000)}
   catch(e){cleanupFailed=e}
  }
  if(!cleanupFailed)await rm(root,{recursive:true,force:true});
 }
 if(cleanupFailed)throw new AggregateError([...(primaryError?[primaryError]:[]),cleanupFailed],
   'Synthetic Docker cleanup failed; inspect temporary Compose project at '+root+' before manual removal');
 if(primaryError)throw primaryError;
 return result;
}
export async function runR34DockerE2E(){
 run(['docker','info'],src,15000);
 run(['docker','compose','version'],src,15000);
 const results=[];for(const type of ['crm','site'])results.push(await scenario(type));
 return {format:'osmanx-r34-docker-e2e',version:1,ok:true,syntheticOnly:true,results,
  publicHttpsVerified:false,productionCertified:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv.includes('--confirm-isolated-test')){console.error('Pass --confirm-isolated-test');process.exitCode=2}
 else runR34DockerE2E().then(x=>console.log(JSON.stringify(x,null,2))).catch(e=>{console.error('R3.4 DOCKER E2E FAILED: '+e.message);process.exitCode=1});
}
