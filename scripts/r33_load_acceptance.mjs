/**
 * R3.3 local synthetic concurrency acceptance. Starts independent CRM and site
 * with real SQLite and real HTTP; never contacts public domains or Docker.
 * Commits are checked AFTER SIGTERM / graceful shutdown against on-disk DB.
 */
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {makeSitePages} from '../src/site/model.mjs';
const src=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const password='SyntheticLocalAcceptance_123!';
const setupToken='R33_TEST_ONLY_'+randomUUID()+randomUUID();
const timeout=(promise,ms)=>{let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Timed out after '+ms+'ms')),ms)})]).finally(()=>clearTimeout(timer))};
async function freePort(){const sock=createServer();sock.listen(0,'127.0.0.1');await once(sock,'listening');const p=sock.address().port;await new Promise(resolve=>sock.close(resolve));return p}
async function http(origin,path,{method='GET',body,cookie,csrf}={}){
  const headers={connection:'close'};
  if(body!==undefined)headers['content-type']='application/json';
  if(cookie)headers.cookie=cookie;if(csrf)headers['x-csrf-token']=csrf;
  const response=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(10000)});
  const data=await response.json().catch(()=>null);
  return {status:response.status,data,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
async function boot(root,type){
  const app=join(root,type),data=join(app,'data');await mkdir(app,{recursive:true});await mkdir(data,{mode:0o700});
  const project={id:randomUUID(),name:'R33 synthetic '+type,type,industry:type==='site'?'business':'restaurant',
    modules:type==='site'?['auth','cms','leads']:['auth','clients','tasks'],
    settings:{accent:'#b1a183',currency:'RUB',primaryAction:'navigate_overview'},
    pages:type==='site'?makeSitePages('R33 synthetic'):[],entities:[],automationPresets:[]};
  for(const [name,content] of parseStoredZip(await exportDeploymentBundle(project,src,'test.osmanx.co'),{maxFiles:400,maxBytes:80e6})){
    const target=join(app,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,content);
  }
  const port=await freePort(),origin='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,['run.mjs'],{cwd:app,env:{...process.env,DATA_DIR:data,PORT:String(port),HOST:'127.0.0.1',COOKIE_SECURE:'0',SETUP_TOKEN:setupToken,NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',b=>log+=b.toString().slice(0,300));child.stderr.on('data',b=>log+=b.toString().slice(0,300));
  for(let i=0;i<150;i++){
    if(child.exitCode!==null)throw Error('Standalone '+type+' failed to boot: '+log.slice(-500));
    try{const r=await http(origin,'/api/health');if(r.status===200)return {app,data,child,origin,project,log:()=>log}}catch{}
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  child.kill();throw Error('Standalone '+type+' was not ready: '+log.slice(-500));
}
async function stop(service){
  if(service.child.exitCode!==null)return;
  const exit=once(service.child,'exit');service.child.kill('SIGTERM');
  const [code,signal]=await timeout(exit,25000);
  if(code!==0)throw Error('Unclean '+service.project.type+' shutdown code='+code+' signal='+signal+'; '+service.log().slice(-400));
  const lock=join(service.data,'server.lock');
  try{await stat(lock);throw Error('Server lock remained after clean stop')}catch(error){if(error.code!=='ENOENT')throw error}
}
function countRows(service){
  const file=join(service.data,service.project.type==='site'?'site.sqlite':'crm.sqlite');
  const db=new DatabaseSync(file,{readOnly:true});
  try{return {count:db.prepare('SELECT COUNT(*) AS n FROM '+(service.project.type==='site'?'leads':'clients')).get().n,
    integrity:db.prepare('PRAGMA integrity_check').get().integrity_check}}
  finally{db.close()}
}
async function runOne(base,type,crmWrites,siteWrites){
  const s=await boot(base,type);
  try{
    const endpoint=type==='site'?'/api/site/setup':'/api/setup';
    const setup=await http(s.origin,endpoint,{method:'POST',body:{name:'Synthetic Owner',email:'owner@r33.local',password,setup_token:setupToken}});
    if(setup.status!==201)throw Error('Cannot prepare '+type+' identity: '+JSON.stringify(setup.data));
    const submissions=type==='site'?siteWrites:crmWrites;
    const create=type==='site'?'/api/site/leads':'/api/clients';
    const promises=Array.from({length:submissions},(_,i)=>http(s.origin,create,{
      method:'POST',cookie:type==='crm'?setup.cookie:undefined,csrf:type==='crm'?setup.data.csrf:undefined,
      body:type==='site'?{page:'contacts',name:'Synthetic '+i,email:'r33-'+i+'@example.org',message:'test data only'}:{full_name:'Synthetic '+i,source:'other'}
    }).then(r=>({status:r.status})).catch(e=>({status:0})));
    // Concurrent reads also contend for the one server while writes are committed.
    const probes=Array.from({length:40},()=>http(s.origin,'/api/health').then(r=>r.status).catch(()=>0));
    const [writes,reads]=await Promise.all([Promise.all(promises),Promise.all(probes)]);
    if(writes.some(x=>x.status!==201))throw Error(type+' rejected synthetic write(s): '+writes.map(x=>x.status).join(','));
    if(reads.some(x=>x!==200))throw Error(type+' failed a concurrent health request');
    await stop(s);
    const db=countRows(s);
    if(db.integrity!=='ok'||db.count!==submissions)throw Error(type+' lost committed records or corrupted SQLite: '+JSON.stringify(db));
    return {type,concurrentWrites:submissions,healthChecks:reads.length,committed:db.count,integrity:db.integrity,gracefulExit:true};
  }finally{
    if(s.child.exitCode===null){s.child.kill('SIGTERM');await timeout(once(s.child,'exit'),25000).catch(()=>s.child.kill('SIGKILL'))}
  }
}
export async function runLocalLoadAcceptance({crmWrites=36,siteWrites=6}={}){
  if(!Number.isInteger(crmWrites)||crmWrites<2||crmWrites>120||!Number.isInteger(siteWrites)||siteWrites<2||siteWrites>6)
    throw Error('Synthetic load limits exceeded');
  const base=await mkdtemp(join(tmpdir(),'osmanx-r33-load-'));
  try{
    const results=[];
    for(const type of ['crm','site'])results.push(await runOne(base,type,crmWrites,siteWrites));
    return {format:'osmanx-r33-local-load-acceptance',version:1,ok:true,syntheticOnly:true,publicNetworkUsed:false,
      realHttp:true,realSqlite:true,realDocker:false,results};
  }finally{await rm(base,{recursive:true,force:true})}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const file=process.argv.find(s=>s.startsWith('--out='))?.slice(6);
  runLocalLoadAcceptance().then(async result=>{
    if(file){process.umask(0o077);await writeFile(resolve(file),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600})}
    console.log(JSON.stringify(result,null,2));
  }).catch(error=>{console.error('R3.3 LOAD ACCEPTANCE FAILED: '+error.message);process.exitCode=1});
}
