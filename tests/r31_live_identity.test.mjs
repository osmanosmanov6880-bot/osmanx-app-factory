import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {createServer as tlsServer,request as httpsRequest} from 'node:https';
import {createServer as tcpServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {verifyPublicHttps,isAllowedPublicV4} from '../templates/deploy/verify-live.mjs';
const source=resolve(import.meta.dirname,'..');
const hash=b=>createHash('sha256').update(b).digest('hex');
const id='1c513902-a617-4138-ad70-b979de83cb54';
const project=type=>({id,type,name:'R31 readiness test',industry:type==='crm'?'restaurant':'business',
 modules:type==='crm'?['auth','clients','tasks']:['auth','cms','leads'],
 settings:{accent:'#5b777a',primaryAction:'navigate_overview',currency:'RUB'},pages:[],entities:[],automationPresets:[]});
async function freePort(){const s=tcpServer();await new Promise(done=>s.listen(0,'127.0.0.1',done));const port=s.address().port;await new Promise(done=>s.close(done));return port;}
async function boot(type){
 const base=await mkdtemp(join(tmpdir(),'osmanx-r31-identity-')),app=join(base,'app'),data=join(base,'data');
 await mkdir(app);await mkdir(data);
 const p=project(type),rel={id:randomUUID(),sequence:3,snapshotSha256:hash(JSON.stringify(p)),createdAt:new Date().toISOString()};
 const zip=await exportDeploymentBundle(p,source,'staging.osmanx.co',rel);
 for(const [name,buf] of parseStoredZip(zip,{maxFiles:400,maxBytes:80*1024*1024})){
  await mkdir(dirname(join(app,name)),{recursive:true});await writeFile(join(app,name),buf);
 }
 const port=await freePort();
 const child=spawn(process.execPath,['run.mjs'],{cwd:app,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:data,COOKIE_SECURE:'0',NODE_NO_WARNINGS:'1'},stdio:'ignore'});
 const stop=async()=>{if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(done=>child.once('exit',done)),new Promise(done=>setTimeout(done,1000))]);if(child.exitCode===null)child.kill('SIGKILL')}await rm(base,{recursive:true,force:true})};
 try{
  for(let i=0;i<65;i++){
   if(child.exitCode!==null)throw Error('Standalone app exited unexpectedly: '+child.exitCode);
   try{const response=await fetch('http://127.0.0.1:'+port+'/api/health');if(response.ok)return {json:await response.json(),stop};}
   catch{}
   await new Promise(done=>setTimeout(done,75));
  }
  throw Error('Standalone app health did not become available');
 }catch(e){await stop();throw e}
}
test('R3.1: independently exported CRM and website expose only deployment identity on health',{timeout:30000},async()=>{
 for(const type of ['crm','site']){
  const {json,stop}=await boot(type);try{
   assert.equal(json.ok,true);
   assert.equal(json.service,type==='crm'?'osmanx-business-crm':'osmanx-website');
   assert.deepEqual(json.deployment,{projectId:id,releaseSequence:3});
   assert.equal(JSON.stringify(json).includes('SETUP_TOKEN'),false);
  }finally{await stop()}
 }
});
const openssl=spawnSync('openssl',['version'],{encoding:'utf8'});
test('R3.1: real local TLS validates the expected CRM/website project and release, refusing wrong backend',{timeout:25000,skip:openssl.status!==0?'openssl missing':false},async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'osmanx-r31-tls-'));
 const cert=join(tmp,'local.crt'),key=join(tmp,'local.key'),domain='r31.osmanx.test';
 const created=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN='+domain,'-addext','subjectAltName=DNS:'+domain],{encoding:'utf8',timeout:12000});
 assert.equal(created.status,0,created.stderr);
 const ca=await readFile(cert),pem=await readFile(key);
 const expected={service:'osmanx-business-crm',projectId:id,releaseSequence:3};
 let actual={ok:true,service:expected.service,deployment:{projectId:id,releaseSequence:3}};
 const server=tlsServer({key:pem,cert:ca},(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(actual))});
 try{
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done)});
  const port=server.address().port;
  const request=(opts,fn)=>httpsRequest({...opts,port,ca,lookup:(_name,opts,cb)=>opts?.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4)},fn);
  const probe=()=>verifyPublicHttps(domain,{expected,resolveA:async()=>['8.8.8.8'],request});
  const result=await probe();assert.equal(result.identityVerified,true);assert.equal(result.releaseSequence,3);
  actual.deployment.releaseSequence=2;await assert.rejects(probe(),/does not match expected application/);
  actual.deployment.releaseSequence=3;actual.deployment.projectId=randomUUID();await assert.rejects(probe(),/does not match expected application/);
  actual.deployment.projectId=id;actual.service='osmanx-website';await assert.rejects(probe(),/does not match expected application/);
  delete actual.deployment;await assert.rejects(probe(),/does not match expected application/);
  await assert.rejects(verifyPublicHttps(domain,{expected,resolveA:async()=>['127.0.0.1'],request}),/private|reserved|invalid/i);
 }finally{await new Promise(done=>server.close(done));await rm(tmp,{recursive:true,force:true})}
});
test('R3.1: refusal when expected HTTPS deployment identity is malformed',{timeout:10000},async()=>{
 const expected={service:'osmanx-website',projectId:id,releaseSequence:-1};
 // Before network I/O, we reject malformed expectations.
 await assert.rejects(verifyPublicHttps('test.osmanx.co',{expected,resolveA:async()=>['8.8.8.8'],request:()=>({})}),/Invalid expected deployment identity/);
});

test('R3.1: public HTTPS probe refuses reserved IPv4 ranges and malformed domain labels',async()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','192.0.2.5','192.0.0.5','198.51.100.2','203.0.113.9','169.254.1.3','100.64.2.3'])
   assert.equal(isAllowedPublicV4(ip),false,ip);
 assert.equal(isAllowedPublicV4('8.8.8.8'),true);
 for(const domain of ['-evil.example.com','good.-bad.com','example..com','good.bad-.com'])
   await assert.rejects(verifyPublicHttps(domain,{resolveA:async()=>['8.8.8.8']}),/Invalid domain/,domain);
});
