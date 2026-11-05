/** R3.4 offline synthetic acceptance: pinned telemetry + existing crash/load paths. */
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {initFleetIdentity,createFleetSnapshot,signFleetSnapshot} from '../templates/deploy/fleet-agent.mjs';
import {validateFleetEnvelope} from '../src/studio/fleet.mjs';
import {runLocalLoadAcceptance} from './r33_load_acceptance.mjs';
import {runCrashAcceptance} from './r33_crash_acceptance.mjs';

const root=resolve(import.meta.dirname,'..');
const project=(type,id)=>({id,name:'R34 Synthetic',type,industry:type==='crm'?'restaurant':'business',
 modules:type==='crm'?['auth','clients','tasks']:['auth','cms','leads'],
 settings:{accent:'#a48565',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]});
export async function runR34Acceptance({load=true,crash=true}={}){
 const temp=await mkdtemp(join(tmpdir(),'ox-r34-accept-'));
 try{
  const snapshots=[];
  for(const type of ['crm','site']){
   const id=randomUUID(),install=join(temp,type);await mkdir(install);
   const entries=parseStoredZip(await exportDeploymentBundle(project(type,id),root,'sample.example.org'),{maxFiles:450,maxBytes:90e6});
   for(const [name,buf] of entries){const file=join(install,name);await mkdir(dirname(file),{recursive:true});await writeFile(file,buf)}
   const identity=await initFleetIdentity(install);
   const packet=await signFleetSnapshot({root:install,payload:await createFleetSnapshot({root:install})});
   const verified=validateFleetEnvelope(packet,identity.publicKeyPem,id);
   if(verified.checks.inventory!=='pass'||verified.offlineOnly!==true||verified.service!==type)throw Error('Offline signed fleet snapshot failed for '+type);
   snapshots.push({service:type,signatureVerified:true,installedFilesVerified:true,
    noPublicNetwork:true,privateKeyExported:false,releaseSequence:verified.releaseSequence});
  }
  const traffic=load?await runLocalLoadAcceptance():null;
  const interruptions=crash?await runCrashAcceptance():null;
  if(traffic&&!traffic.ok||interruptions&&!interruptions.ok)throw Error('R3.3 resilience acceptance failed');
  const report={format:'osmanx-r34-offline-acceptance',version:1,at:new Date().toISOString(),
   ok:true,syntheticOnly:true,realDocker:false,publicHttpsVerified:false,continuousMonitoring:false,
   signedFleet:snapshots,parallelTraffic:traffic?.results||[],abruptRecovery:interruptions?.results||[],
   limitations:['Fleet snapshots are manually imported and do not monitor installations continuously',
    'Docker tests require Linux with a Docker daemon and have not run in this acceptance',
    'Only synthetic customer records were used']};
  report.sha256=createHash('sha256').update(JSON.stringify(report)).digest('hex');
  return report;
 }finally{await rm(temp,{recursive:true,force:true})}
}
const main=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(main){
 process.umask(0o077);
 const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6);
 runR34Acceptance().then(async r=>{
  if(out)await writeFile(resolve(out),JSON.stringify(r,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({ok:r.ok,syntheticOnly:true,signedFleet:r.signedFleet.length,
   committed:r.parallelTraffic.reduce((n,x)=>n+x.committed,0),abruptReleases:r.abruptRecovery.length,
   realDocker:false,publicHttpsVerified:false},null,2));
 }).catch(e=>{console.error('R3.4 ACCEPTANCE FAILED: '+e.message);process.exitCode=1});
}
