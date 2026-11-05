/** R3.5: isolated, fail-closed local verification with an auditable JSON result. */
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runRegression} from './r35_regression.mjs';
import {runR34Acceptance} from './r34_release_acceptance.mjs';

export async function runR35Acceptance({regression=true,load=true,crash=true}={}){
 const evidence={format:'osmanx-r35-local-acceptance',version:1,at:new Date().toISOString(),
  syntheticOnly:true,realDocker:false,publicHttpsVerified:false,continuousMonitoring:false,
  originalR23Merged:false,regression:null,resilience:null,ok:false};
 if(regression){
  evidence.regression=await runRegression();
  if(!evidence.regression.ok)throw Error('Isolated regression failed; refusing release acceptance');
 }
 evidence.resilience=await runR34Acceptance({load,crash});
 if(!evidence.resilience.ok)throw Error('Local load/crash acceptance failed');
 evidence.ok=true;
 evidence.limitations=[
  'No actual Docker daemon or remote GitHub Actions job was executed by this script',
  'HTTPS verification requires an explicitly requested check on a configured public VPS',
  'Only synthetic customer records and test installations were used'
 ];
 evidence.sha256=createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
 return evidence;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 process.umask(0o077);
 const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6);
 runR35Acceptance({regression:!process.argv.includes('--skip-regression')}).then(async report=>{
  if(out){const path=resolve(out);if(!path.endsWith('.json'))throw Error('Output must end in .json');
   await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});}
  console.log(JSON.stringify({ok:report.ok,tests:report.regression?.tests||null,signedClients:report.resilience.signedFleet.length,
   concurrentWrites:report.resilience.parallelTraffic.reduce((n,r)=>n+r.committed,0),
   crashRecoveries:report.resilience.abruptRecovery.length,realDocker:false}));
 }).catch(e=>{console.error('R3.5 ACCEPTANCE: '+e.message);process.exitCode=1});
}
