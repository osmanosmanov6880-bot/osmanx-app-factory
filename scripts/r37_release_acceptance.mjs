/** R3.7 reproducible LOCAL acceptance with hard bounded process lifetime.
 * One aggregate TAP subprocess avoids the known intermittent orphan-handle
 * problem in per-file runners; the process exit code and TAP are BOTH checked.
 * This is NOT evidence of real Docker or public HTTPS. */
import {createHash} from 'node:crypto';
import {writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runIsolated,tapSummary} from './r35_regression.mjs';
import {runR34Acceptance} from './r34_release_acceptance.mjs';
const source=resolve(import.meta.dirname,'..');
export async function runBoundedRegression({root=source,timeoutMs=120000}={}){
 const names=(await readdir(join(root,'tests'))).filter(s=>/^[a-z0-9_]+\.test\.mjs$/i.test(s)).sort();
 if(names.length<35)throw Error('Incomplete regression test inventory');
 const command=['--test','--test-concurrency=4',...names.map(x=>join(root,'tests',x))];
 const result=await runIsolated(process.execPath,command,{cwd:root,timeoutMs});
 const tap=tapSummary(result.outputTail);
 const ok=!result.timedOut&&!result.error&&result.exitCode===0&&tap.tests>0&&
   tap.passed===tap.tests&&tap.failed===0&&tap.cancelled===0;
 if(!ok)throw Error('Bounded Node regression failed; exit='+result.exitCode+
   ', timeout='+result.timedOut+', TAP='+JSON.stringify(tap)+', tail='+result.outputTail.slice(-500));
 return {ok,files:names.length,tests:tap.tests,passed:tap.passed,
   exitCode:result.exitCode,timedOut:false,durationMs:result.durationMs};
}
export async function runR37LocalAcceptance({regression=true,load=true,crash=true}={}){
 const baseline=regression?await runBoundedRegression():null;
 const resilience=await runR34Acceptance({load,crash});
 if(resilience.ok!==true)throw Error('Signed, load and crash resilience check incomplete');
 const result={format:'osmanx-r37-local-acceptance',version:1,at:new Date().toISOString(),
   ok:true,sourceBase:'R1.3 plus local R2.4-R3.7 previews',syntheticOnly:true,
   nodeRegression:baseline,
   resilience:{signedInstallations:resilience.signedFleet?.length??0,
     load:resilience.parallelTraffic?.map(x=>({type:x.type,committed:x.committed}))??[],
     forcedRecoveries:resilience.abruptRecovery?.length??0},
   preparedDockerTest:'scripts/r37_docker_e2e.mjs',dockerExecuted:false,
   publicHttpsVerified:false,remoteGitHubCiVerified:false,productionCertified:false,
   note:'Local-only evidence. Execute real Docker acceptance separately on a Linux runner.'};
 result.sha256=createHash('sha256').update(JSON.stringify(result)).digest('hex');
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 process.umask(0o077);
 const out=process.argv.find(x=>x.startsWith('--out='))?.slice(6);
 runR37LocalAcceptance({regression:!process.argv.includes('--skip-regression')}).then(async r=>{
   if(out){const path=resolve(out);if(!path.endsWith('.json'))throw Error('Expected JSON output');
     await writeFile(path,JSON.stringify(r,null,2)+'\n',{flag:'wx',mode:0o600});}
   console.log(JSON.stringify({ok:r.ok,tests:r.nodeRegression?.tests??null,
     signedInstallations:r.resilience.signedInstallations,
     committed:r.resilience.load.reduce((n,x)=>n+x.committed,0),
     forcedRecoveries:r.resilience.forcedRecoveries,dockerExecuted:false,publicHttpsVerified:false}));
 }).catch(e=>{console.error('R3.7 local acceptance FAILED: '+e.message);process.exitCode=1});
}
