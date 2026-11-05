import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {parseStoredZip} from '../src/common/archive.mjs';
import {initFleetIdentity,createFleetSnapshot,signFleetSnapshot} from '../templates/deploy/fleet-agent.mjs';
const root=resolve(import.meta.dirname,'..');
const sleep=n=>new Promise(r=>setTimeout(r,n));
async function port(){const server=createServer();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const p=server.address().port;await new Promise(ok=>server.close(ok));return p;}
async function http(base,path,{cookie,csrf,method='GET',body}={}){
 const headers={};if(cookie)headers.cookie=cookie;if(csrf)headers['x-csrf-token']=csrf;if(body)headers['content-type']='application/json';
 const r=await fetch(base+path,{method,headers,body:body?JSON.stringify(body):undefined});
 const ct=r.headers.get('content-type')||'';
 return {status:r.status,cookie:r.headers.get('set-cookie')?.split(';')[0],data:ct.includes('zip')?Buffer.from(await r.arrayBuffer()):await r.json()};
}
test('R3.4 real Studio HTTP: project ownership, CSRF, signed offline import, replay, key rotation',{timeout:90000},async()=>{
 const temp=await mkdtemp(join(tmpdir(),'ox-r34-api-')),p=await port(),base=`http://127.0.0.1:${p}`;
 const proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,DATA_DIR:join(temp,'factory-data'),HOST:'127.0.0.1',PORT:String(p),NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
 let log='';proc.stdout.on('data',x=>log+=x);proc.stderr.on('data',x=>log+=x);
 try{
  let ready=false;
  for(let n=0;n<90;n++){try{const r=await fetch(base+'/api/studio/session');if(r.ok){ready=true;break}}catch{}await sleep(100)}
  assert.equal(ready,true,log);
  let response=await http(base,'/api/studio/setup',{method:'POST',body:{email:'owner34@test.example',password:'R34_TestPassword_Strong_129',name:'Test Owner'}});
  assert.equal(response.status,201,JSON.stringify(response.data));const cookie=response.cookie,csrf=response.data.csrf;
  response=await http(base,'/api/studio/projects',{cookie,csrf,method:'POST',body:{type:'crm',industry:'restaurant',name:'Fleet Demo',modules:['auth','clients','tasks'],settings:{accent:'#456789',primaryAction:'navigate_overview',currency:'RUB'}}});
  assert.equal(response.status,201,JSON.stringify(response.data));const projectId=response.data.project.id;
  const fleet=`/api/studio/projects/${projectId}/fleet`;
  assert.equal((await http(base,fleet)).status,401);
  assert.equal((await http(base,'/api/studio/fleet')).status,401);
  assert.equal((await http(base,`/api/studio/projects/${randomUUID()}/fleet`,{cookie})).status,404);
  assert.equal((await http(base,fleet+'/trust',{cookie,method:'POST',body:{publicKeyPem:'bad'}})).status,403);
  response=await http(base,`/api/studio/projects/${projectId}/deployment/export?domain=fleet.example.org`,{cookie});
  assert.equal(response.status,200);
  const entries=parseStoredZip(response.data,{maxFiles:450,maxBytes:90e6}),install=join(temp,'install');
  await mkdir(install);
  for(const [name,data] of entries){await mkdir(dirname(join(install,name)),{recursive:true});await writeFile(join(install,name),data)}
  const identity=await initFleetIdentity(install);
  response=await http(base,fleet+'/trust',{method:'POST',cookie,csrf,body:{publicKeyPem:identity.publicKeyPem}});
  assert.equal(response.status,200,JSON.stringify(response.data));
  assert.equal((await http(base,fleet+'/trust',{method:'POST',cookie,csrf,body:{publicKeyPem:identity.publicKeyPem}})).status,409);
  const payload=await createFleetSnapshot({root:install});
  const packet=await signFleetSnapshot({root:install,payload});
  assert.equal((await http(base,fleet+'/import',{method:'POST',cookie,csrf,body:{packet:{...packet,signature:packet.signature.slice(0,-3)+'BAD'}}})).status,422);
  response=await http(base,fleet+'/import',{method:'POST',cookie,csrf,body:{packet}});
  assert.equal(response.status,200,JSON.stringify(response.data));
  assert.equal(response.data.fleet.latest.service,'crm');
  assert.equal(response.data.fleet.latest.checks.inventory,'pass');
  assert.equal((await http(base,fleet+'/import',{method:'POST',cookie,csrf,body:{packet}})).status,409);
  const view=await http(base,fleet,{cookie});
  assert.equal(view.status,200);assert.equal(view.data.fleet.history.length,1);
  const overview=await http(base,'/api/studio/fleet',{cookie});
  assert.equal(overview.status,200);assert.equal(overview.data.fleet.total,1);
  assert.equal(overview.data.fleet.rows[0].projectId,projectId);
  assert.equal(overview.data.fleet.counts.reported,1);
  assert.equal(view.data.fleet.latest.releaseSequence,0);
  assert.equal(view.data.fleet.health,'critical'); // missing .env means protected deployment is not ready
  assert.ok(!JSON.stringify(view.data).includes('SETUP_TOKEN'));
  const rotated=generateKeyPairSync('ed25519');
  const publicKeyPem=rotated.publicKey.export({format:'pem',type:'spki'}).toString();
  assert.equal((await http(base,fleet+'/trust',{method:'POST',cookie,csrf,body:{publicKeyPem,rotate:true}})).status,200);
  const fresh=await http(base,fleet,{cookie});assert.equal(fresh.data.fleet.history.length,0);
  assert.equal((await http(base,fleet+'/import',{method:'POST',cookie,csrf,body:{packet}})).status,422);
 }finally{proc.kill('SIGTERM');await Promise.race([new Promise(ok=>proc.once('exit',ok)),sleep(1500)]);await rm(temp,{force:true,recursive:true})}
});
