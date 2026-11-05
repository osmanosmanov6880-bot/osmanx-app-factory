/** R3.3 synthetic-only acceptance: signature+drill, concurrent writes, real SIGKILL. */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {runLocalLoadAcceptance} from './r33_load_acceptance.mjs';
import {runCrashAcceptance} from './r33_crash_acceptance.mjs';
const root=resolve(import.meta.dirname,'..');
export async function runR33ReleaseAcceptance(){
 const temp=await mkdtemp(join(tmpdir(),'osmanx-r33-acceptance-'));
 try{
  const out=join(temp,'signed-r32.json');
  const child=spawnSync(process.execPath,['scripts/r32_offline_acceptance.mjs','--out='+out],{
   cwd:root,encoding:'utf8',timeout:60000,env:{...process.env,NODE_NO_WARNINGS:'1'}});
  if(child.status!==0)throw Error('Signed release and restore drill failed: '+String(child.stderr||child.stdout).slice(-500));
  const signature=JSON.parse(await readFile(out,'utf8'));
  if(signature.checks.some(x=>x.status==='fail')||signature.checks.find(x=>x.id==='publisher')?.status!=='pass')
   throw Error('Signed release is not authenticated');
  const [load,crash]=await Promise.all([runLocalLoadAcceptance(),runCrashAcceptance()]);
  if(!load.ok||!crash.ok)throw Error('Synthetic acceptance incomplete');
  const result={format:'osmanx-r33-release-acceptance',version:1,createdAt:new Date().toISOString(),
   ok:true,syntheticOnly:true,realDocker:false,publicHttpsVerified:false,productionCertified:false,
   blocks:{signedReleaseAndRestoreDrill:{ok:true,publisherVerified:true,disposableRestore:true},
    concurrentTraffic:load,abruptRecovery:crash},
   limitations:['No real Docker Engine or VPS test in this local acceptance',
    'No public DNS/TLS or browser E2E was executed','Customer-data retention and business workload must be validated separately']};
  result.sha256=createHash('sha256').update(JSON.stringify(result)).digest('hex');
  return result;
 }finally{await rm(temp,{recursive:true,force:true})}
}
const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6);
runR33ReleaseAcceptance().then(async report=>{
 if(out){process.umask(0o077);await writeFile(resolve(out),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600})}
 console.log(JSON.stringify({ok:report.ok,syntheticOnly:true,signed:true,
  concurrentCommitted:report.blocks.concurrentTraffic.results.reduce((sum,r)=>sum+r.committed,0),
  actualKilledProcesses:report.blocks.abruptRecovery.results.length,
  dockerExecuted:false,publicHttpsVerified:false},null,2));
}).catch(error=>{console.error('R3.3 RELEASE ACCEPTANCE FAILED: '+error.message);process.exitCode=1});
