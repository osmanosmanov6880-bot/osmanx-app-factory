/** R3.5: isolate Node test files so an orphaned handle cannot silently pass CI. */
import {spawn} from 'node:child_process';
import {readdir,writeFile,stat} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';

const source=resolve(import.meta.dirname,'..');
const TAIL_LIMIT=10000;
const seconds=ms=>Number((ms/1000).toFixed(3));
export function tapSummary(output){
 const value=k=>{const m=output.match(new RegExp('^# '+k+' (\\d+)$','m'));return m?Number(m[1]):null};
 return {tests:value('tests'),passed:value('pass'),failed:value('fail'),skipped:value('skipped'),cancelled:value('cancelled')};
}
export async function runIsolated(executable,args,{cwd=source,timeoutMs=90000,env=process.env}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>180000)throw Error('Invalid bounded test timeout');
 return new Promise((resolvePromise)=>{
  const started=Date.now(),child=spawn(executable,args,{cwd,env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true});
  let output='',error=null,timedOut=false,finished=false;
  let stopTimer=null,killTimer=null;
  const append=x=>{output=(output+x.toString()).slice(-TAIL_LIMIT);};
  child.stdout.on('data',append);child.stderr.on('data',append);
  const killGroup=signal=>{try{process.kill(process.platform==='win32'?child.pid:-child.pid,signal)}catch{try{child.kill(signal)}catch{}}};
  const timer=setTimeout(()=>{
   timedOut=true;killGroup('SIGTERM');
   killTimer=setTimeout(()=>killGroup('SIGKILL'),1000);
  },timeoutMs);
  child.on('error',e=>{error=e.message});
  child.on('close',(code,signal)=>{
   if(finished)return;finished=true;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);
   resolvePromise({exitCode:code,signal,error,timedOut,durationMs:Date.now()-started,outputTail:output});
  });
 });
}
export async function runRegression({focus=null,timeoutMs=90000,root=source}={}){
 const testDir=join(root,'tests');
 let names=(await readdir(testDir)).filter(x=>/^[a-z0-9_]+\.test\.mjs$/i.test(x)).sort();
 if(focus){if(!/^[a-z0-9_]+(?:\.test\.mjs)?$/i.test(focus))throw Error('Unsafe test filter');names=names.filter(x=>x===focus||x===focus+'.test.mjs');}
 if(!names.length)throw Error('No matching test files');
 let total=0,passed=0;const results=[];
 for(const name of names){
  const path=join(testDir,name);if(!(await stat(path)).isFile())throw Error('Unexpected test path');
  const run=await runIsolated(process.execPath,['--test','--test-concurrency=1',path],{cwd:root,timeoutMs});
  const tap=tapSummary(run.outputTail);const ok=!run.timedOut&&!run.error&&run.exitCode===0&&tap.tests!==null&&tap.tests>0&&tap.passed===tap.tests&&tap.failed===0&&tap.cancelled===0;
  results.push({file:name,ok,timedOut:run.timedOut,exitCode:run.exitCode,signal:run.signal,durationSeconds:seconds(run.durationMs),...tap,diagnostic:ok?null:run.outputTail.slice(-3000)});
  total+=tap.tests||0;passed+=tap.passed||0;
  console.log(`${ok?'PASS':'FAIL'} ${name}: ${tap.passed??'?'} / ${tap.tests??'?'} in ${seconds(run.durationMs)}s`);
  if(!ok)break; // preserve clear first failure and avoid cascading on a broken baseline
 }
 const report={format:'osmanx-r35-isolated-regression',version:1,at:new Date().toISOString(),ok:results.every(x=>x.ok)&&results.length===names.length,
  testFiles:results.length,expectedTestFiles:names.length,tests:total,passed,realDocker:false,results};
 return report;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 process.umask(0o077);
 const args=process.argv.slice(2),val=k=>args.find(x=>x.startsWith('--'+k+'='))?.slice(k.length+3);
 const ms=val('timeout-ms')?Number(val('timeout-ms')):90000;
 runRegression({focus:val('focus')||null,timeoutMs:ms}).then(async report=>{
  if(val('out')){const path=resolve(val('out'));if(!path.endsWith('.json'))throw Error('Report output must be JSON');await writeFile(path,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});}
  console.log(JSON.stringify({ok:report.ok,files:report.testFiles,tests:report.tests,passed:report.passed,realDocker:false}));
  if(!report.ok)process.exitCode=1;
 }).catch(e=>{console.error('R3.5 REGRESSION: '+e.message);process.exitCode=1});
}
