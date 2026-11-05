import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseStoredZip } from '../src/common/archive.mjs';
import { normalizeDeploymentDomain, normalizeServerIpv4, deploymentPreflight, isPublicIPv4, isPublicIPv6 } from '../src/studio/deployment.mjs';

const projectRoot=resolve(import.meta.dirname,'..');
const sha=data=>createHash('sha256').update(data).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const n=server.address().port;await new Promise(r=>server.close(r));return n;}
async function boot(script,cwd,env,port){
 const proc=spawn(process.execPath,[script],{cwd,env:{...process.env,NODE_NO_WARNINGS:'1',...env,PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let log='';proc.stdout.on('data',b=>log+=b);proc.stderr.on('data',b=>log+=b);
 for(let i=0;i<90;i++){
  if(proc.exitCode!==null)throw Error('Exited before ready: '+log);
  try{const r=await fetch(`http://127.0.0.1:${port}/api/health`);if(r.ok)return proc;}catch{}
  await sleep(100);
 }
 proc.kill('SIGTERM');throw Error('Timed out starting server: '+log);
}
async function call(origin,path,{method='GET',cookie,csrf,body}={}){
 const headers={};if(cookie)headers.cookie=cookie;if(csrf)headers['x-csrf-token']=csrf;if(body!==undefined)headers['content-type']='application/json';
 const r=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 const type=r.headers.get('content-type')||'';
 return {status:r.status,headers:r.headers,cookie:r.headers.get('set-cookie')?.split(';')[0],data:type.includes('zip')?Buffer.from(await r.arrayBuffer()):await r.json()};
}
async function extract(entries,dest){
 for(const [name,data] of entries){
  if(name.startsWith('/')||name.split('/').includes('..'))throw Error('zip-slip');
  await mkdir(dirname(join(dest,name)),{recursive:true});await writeFile(join(dest,name),data);
 }
}
const pass='Z9_secure_R24_password';

test('R2.4: domain and server address validation rejects non-public or unsafe input',()=>{
 assert.equal(normalizeDeploymentDomain('CRM.Acme.Co'), 'crm.acme.co');
 assert.equal(normalizeDeploymentDomain('b\u00fccher.de'),'xn--bcher-kva.de');
 for(const input of ['localhost','site.local','example.test','foo.example','ftp://abc.ru','abc.ru:8080','abc.ru/path','abc..ru','-x.ru','1.1.1.1','a.ru\n'])assert.throws(()=>normalizeDeploymentDomain(input),undefined,input);
 assert.equal(isPublicIPv4('8.8.8.8'),true);
 assert.equal(isPublicIPv4('1.1.1.1'),true);
 for(const ip of ['127.0.0.1','10.0.0.2','192.168.1.2','172.16.0.1','100.64.0.1','169.254.0.1','192.0.2.2','203.0.113.7','224.0.0.1']){
  assert.equal(isPublicIPv4(ip),false,ip);assert.throws(()=>normalizeServerIpv4(ip));
 }
 assert.equal(isPublicIPv6('2001:4860:4860::8888'),true);
 assert.equal(isPublicIPv6('::1'),false);
 assert.equal(isPublicIPv6('fd00::1'),false);
});

test('R2.4: DNS diagnostics are explicit and do not perform HTTP calls',async()=>{
 let calls=0;
 const lookup=async (_domain,type)=>{calls++;return type==='A'?['8.8.8.8']:[]};
 let p=await deploymentPreflight({domain:'crm.acme.co',serverIp:'8.8.8.8',lookup,checkDns:false});
 assert.equal(calls,0);assert.equal(p.bundleReady,true);assert.equal(p.publishReady,false);assert.equal(p.dnsChecked,false);
 p=await deploymentPreflight({domain:'crm.acme.co',serverIp:'8.8.8.8',lookup});
 assert.equal(calls,2);assert.equal(p.publishReady,true);
 p=await deploymentPreflight({domain:'crm.acme.co',serverIp:'9.9.9.9',lookup});
 assert.equal(p.publishReady,false);assert.ok(p.checks.some(c=>c.id==='server-match'));
 p=await deploymentPreflight({domain:'crm.acme.co',lookup:async(_d,type)=>type==='A'?['10.0.0.5']:[]});
 assert.equal(p.publishReady,false);assert.ok(p.checks.some(c=>c.id==='dns-private'&&c.status==='error'));
 p=await deploymentPreflight({domain:'crm.acme.co',lookup:async()=>{throw Object.assign(Error('blocked'),{code:'ETIMEOUT'});}});
 assert.equal(p.publishReady,false);assert.ok(p.checks.some(c=>c.id==='dns'));
});

test('R2.4: owner-only deployment bundle preserves application manifest and both apps boot independently', {timeout:120000},async t=>{
 const temp=await mkdtemp(join(tmpdir(),'osmanx-r24-'));
 const port=await freePort(), origin=`http://127.0.0.1:${port}`;
 const factory=await boot('server.mjs',projectRoot,{DATA_DIR:join(temp,'factory-data'),HOST:'127.0.0.1'},port);
 t.after(()=>factory.kill('SIGTERM'));
 let r=await call(origin,'/api/studio/setup',{method:'POST',body:{email:'owner-r24@test.example',name:'Owner',password:pass}});
 assert.equal(r.status,201,JSON.stringify(r.data));
 const ownerCookie=r.cookie,csrf=r.data.csrf;
 for(const type of ['crm','site']){
  r=await call(origin,'/api/studio/projects',{method:'POST',cookie:ownerCookie,csrf,body:type==='crm'?{
   type:'crm',industry:'restaurant',name:'Demo CRM',modules:['auth','clients','tasks','analytics','payments'],settings:{accent:'#386f61',primaryAction:'new_client',currency:'RUB'}
  }:{type:'site',name:'Demo website',industry:'business',modules:['auth','cms','leads']}});
  assert.equal(r.status,201,JSON.stringify(r.data));
  const id=r.data.project.id;
  let unauth=await call(origin,`/api/studio/projects/${id}/deployment/preflight?domain=crm.acme.co&dns=0`);
  assert.equal(unauth.status,401);
  unauth=await call(origin,`/api/studio/projects/${id}/deployment/export?domain=crm.acme.co`);
  assert.equal(unauth.status,401);
  let bad=await call(origin,`/api/studio/projects/${id}/deployment/export?domain=127.0.0.1`,{cookie:ownerCookie});
  assert.equal(bad.status,400);
  const status=await call(origin,`/api/studio/projects/${id}/deployment/preflight?domain=crm.acme.co&dns=0`,{cookie:ownerCookie});
  assert.equal(status.status,200,JSON.stringify(status.data));assert.equal(status.data.deployment.bundleReady,true);
  r=await call(origin,`/api/studio/projects/${id}/deployment/export?domain=crm.acme.co`,{cookie:ownerCookie});
  assert.equal(r.status,200,JSON.stringify(r.data));assert.match(r.headers.get('content-type'),/zip/);
  const entries=parseStoredZip(r.data,{maxFiles:350,maxBytes:60*1024*1024});
  const originalManifest=JSON.parse(entries.get('manifest.json').toString());
  const deploymentManifest=JSON.parse(entries.get('deploy/manifest.json').toString());
  assert.equal(deploymentManifest.projectId,id);assert.equal(deploymentManifest.domain,'crm.acme.co');
  assert.equal(sha(entries.get('manifest.json')),deploymentManifest.applicationManifestSha256);
  assert.ok(!('deploy/Caddyfile' in originalManifest.files),'old backup/update engine must not see new deployment assets');
  assert.equal(entries.get('run.mjs')!==undefined,true);
  for(const [name,digest] of Object.entries(originalManifest.files))assert.equal(sha(entries.get(name)),digest,`Original hash: ${name}`);
  for(const [name,digest] of Object.entries(deploymentManifest.files))assert.equal(sha(entries.get(name)),digest,`Deployment hash: ${name}`);
  for(const name of ['compose.yaml','Dockerfile','.dockerignore','deploy/Caddyfile','deploy/prepare.mjs','deploy/preflight.mjs','deploy/verify.mjs','deploy/healthcheck.mjs'])assert.ok(entries.has(name));
  assert.match(entries.get('compose.yaml').toString(),/caddy_data:/);
  assert.doesNotMatch(entries.get('compose.yaml').toString(),/ports:\s*\n\s*- "418[01]:/,'Application must not expose its HTTP port to the internet');
  assert.match(entries.get('deploy/.env.example').toString(),/SETUP_TOKEN=REPLACE_WITH_RANDOM/);
  assert.doesNotMatch(entries.get('deploy/.env.example').toString(),new RegExp(pass));
  assert.match(entries.get('deploy/Caddyfile').toString(),/reverse_proxy app:418[01]/);
  const out=join(temp,type);await extract(entries,out);
  const integrity=spawnSync(process.execPath,['deploy/verify.mjs'],{cwd:out,encoding:'utf8'});
  assert.equal(integrity.status,0,integrity.stderr);
  const originalCaddy=await readFile(join(out,'deploy/Caddyfile'));
  await writeFile(join(out,'deploy/Caddyfile'),Buffer.concat([originalCaddy,Buffer.from('\n# unexpected change\n')]));
  const altered=spawnSync(process.execPath,['deploy/verify.mjs'],{cwd:out,encoding:'utf8'});
  assert.notEqual(altered.status,0,'modified deployment config must fail hash verification');
  await writeFile(join(out,'deploy/Caddyfile'),originalCaddy);
  const prepare=spawnSync(process.execPath,['deploy/prepare.mjs'],{cwd:out,encoding:'utf8'});
  assert.equal(prepare.status,0,prepare.stderr);
  const createdEnv=await readFile(join(out,'.env'),'utf8');
  assert.match(createdEnv,/SETUP_TOKEN=[0-9a-f]{64}/);
  assert.doesNotMatch(createdEnv,/REPLACE_WITH_RANDOM/);
  if(process.platform!=='win32')assert.equal((await stat(join(out,'.env'))).mode&0o077,0);
  const again=spawnSync(process.execPath,['deploy/prepare.mjs'],{cwd:out,encoding:'utf8'});
  assert.notEqual(again.status,0,'must never overwrite live secrets');
  assert.equal(await readFile(join(out,'.env'),'utf8'),createdEnv);
  const verify=spawnSync(process.execPath,['deploy/preflight.mjs'],{cwd:out,encoding:'utf8'});
  assert.equal(verify.status,0,verify.stderr);
  const appPort=await freePort();
  const standalone=await boot('run.mjs',out,{DATA_DIR:join(out,'data'),HOST:'127.0.0.1',SETUP_TOKEN:createdEnv.match(/SETUP_TOKEN=(.+)/)[1],COOKIE_SECURE:'0'},appPort);
  const health=await call(`http://127.0.0.1:${appPort}`,'/api/health');
  assert.equal(health.status,200);assert.ok(health.data.ok);
  standalone.kill('SIGTERM');
 }
});
