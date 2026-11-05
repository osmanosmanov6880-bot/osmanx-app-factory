import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { parseStoredZip } from '../src/common/archive.mjs';

const root=resolve(import.meta.dirname,'..');
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function start(root,dataDir,port){
 const p=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,DATA_DIR:dataDir,HOST:'127.0.0.1',PORT:String(port),NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
 let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);
 for(let i=0;i<90;i++){if(p.exitCode!==null)throw Error('Factory stopped early: '+output);
  try{const r=await fetch('http://127.0.0.1:'+port+'/api/studio/session');if(r.ok)return p}catch{}await wait(100)}
 p.kill('SIGTERM');throw Error('Factory startup timeout: '+output);
}
async function call(origin,path,{method='GET',cookie,csrf,body}={}){
 const headers={};if(cookie)headers.cookie=cookie;if(csrf)headers['x-csrf-token']=csrf;
 if(body!==undefined)headers['content-type']='application/json';
 const response=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 const mime=response.headers.get('content-type')||'';
 return {status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers,
  data:mime.includes('application/zip')?Buffer.from(await response.arrayBuffer()):await response.json()};
}

test('R2.6: saved releases export independently versioned Docker kits; ownership checked through HTTP API',{timeout:100000},async t=>{
 const tmp=await mkdtemp(join(tmpdir(),'osmanx-r26-release-'));
 const port=await freePort(),origin='http://127.0.0.1:'+port;
 const proc=await start(root,join(tmp,'db'),port);
 t.after(async()=>{proc.kill('SIGTERM');await wait(150);await rm(tmp,{recursive:true,force:true})});
 let r=await call(origin,'/api/studio/setup',{method:'POST',body:{name:'Release owner',email:'r26-release-owner@sample.com',password:'Secure-R26-Owner-Password#9'}});
 assert.equal(r.status,201,JSON.stringify(r.data));const cookie=r.cookie,csrf=r.data.csrf;
 for(const type of ['crm','site']){
  const name='Release '+type;
  r=await call(origin,'/api/studio/projects',{method:'POST',cookie,csrf,body:type==='crm'?{name,type,industry:'restaurant',modules:['auth','clients','tasks'],settings:{accent:'#386f61',primaryAction:'navigate_overview',currency:'RUB'}}:{name,type,industry:'business',modules:['auth','cms','leads']}});
  assert.equal(r.status,201,JSON.stringify(r.data));const id=r.data.project.id;
  const release=await call(origin,`/api/studio/projects/${id}/releases`,{method:'POST',cookie,csrf,body:{notes:'Safe deployment stage'}});
  assert.equal(release.status,201,JSON.stringify(release.data));assert.equal(release.data.release.sequence,1);
  const releaseId=release.data.release.id;
  const unauth=await call(origin,`/api/studio/projects/${id}/deployment/export?domain=crm.osmanx.co&releaseId=${releaseId}`);
  assert.equal(unauth.status,401);
  const bad=await call(origin,`/api/studio/projects/${id}/deployment/export?domain=crm.osmanx.co&releaseId=ffffffff-ffff-4fff-8fff-ffffffffffff`,{cookie});
  assert.equal(bad.status,404);
  const invalid=await call(origin,`/api/studio/projects/${id}/deployment/export?domain=crm.osmanx.co&releaseId=../oops`,{cookie});
  assert.notEqual(invalid.status,200);
  const latest=await call(origin,`/api/studio/projects/${id}/deployment/export?domain=crm.osmanx.co`,{cookie});
  assert.equal(latest.status,200,JSON.stringify(latest.data));
  const zero=parseStoredZip(latest.data,{maxFiles:400,maxBytes:80*1024*1024});
  assert.equal(JSON.parse(zero.get('manifest.json')).release.sequence,0);
  const versioned=await call(origin,`/api/studio/projects/${id}/deployment/export?domain=crm.osmanx.co&releaseId=${releaseId}`,{cookie});
  assert.equal(versioned.status,200,JSON.stringify(versioned.data));
  assert.match(versioned.headers.get('content-disposition'),/-v1\.zip/);
  const files=parseStoredZip(versioned.data,{maxFiles:400,maxBytes:80*1024*1024});
  const manifest=JSON.parse(files.get('manifest.json')),deployment=JSON.parse(files.get('deploy/manifest.json'));
  assert.equal(manifest.release.sequence,1);assert.equal(manifest.projectId,id);
  assert.equal(deployment.projectId,id);assert.equal(deployment.version,2);
  assert.ok(files.has('deploy/upgrade.mjs'));assert.ok(!files.has('.env'));
 }
});
