import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createServer } from 'node:net';
import { parseStoredZip } from '../src/common/archive.mjs';
import { createZip } from '../src/common/zip.mjs';

const root=resolve(import.meta.dirname,'..');
const pass='S5_test_password_2026';
async function port(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const p=server.address().port;await new Promise(r=>server.close(r));return p;}
async function launch(cwd,script,dataDir){
  const p=await port();const env={...process.env,PORT:String(p),HOST:'127.0.0.1',DATA_DIR:dataDir,NODE_NO_WARNINGS:'1'};
  const child=spawn(process.execPath,[script],{cwd,env,stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw Error('Process exited: '+logs);
    try{const r=await fetch(`http://127.0.0.1:${p}/api/health`);if(r.ok)return {child,base:`http://127.0.0.1:${p}`};}catch{}
    await new Promise(r=>setTimeout(r,70));
  }
  child.kill('SIGTERM');throw Error('Server not ready: '+logs);
}
async function stop(child){if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}}
async function api(origin,path,{method='GET',data,auth={},extra={}}={}){
  const headers={...extra};if(data!==undefined)headers['content-type']='application/json';if(auth.cookie)headers.cookie=auth.cookie;if(auth.csrf)headers['x-csrf-token']=auth.csrf;
  const r=await fetch(origin+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
  const b=await r.json().catch(()=>({}));return {status:r.status,body:b,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
async function extract(buf,dir){for(const [name,bytes] of parseStoredZip(buf)){const f=join(dir,name);await mkdir(dirname(f),{recursive:true});await writeFile(f,bytes);}}
function cli(cwd,dataDir,...args){
  return spawnSync(process.execPath,['ops.mjs',...args],{cwd,env:{...process.env,DATA_DIR:dataDir,NODE_NO_WARNINGS:'1'},encoding:'utf8',timeout:25000});
}
const supplier={slug:'suppliers',title:'Suppliers',description:'Restaurant vendors',access:{read:['admin','manager','staff'],write:['admin','manager']},fields:[{key:'company',label:'Company',type:'text',required:true},{key:'phone',label:'Phone',type:'text',required:false}]};
test('release snapshots, safe update, stop gate, local edit gate, DB backup and full restore',{timeout:120000},async t=>{
  const tmp=await mkdtemp(join(tmpdir(),'osmanx-r04-'));
  t.after(async()=>{await rm(tmp,{recursive:true,force:true});});
  const factory=await launch(root,'server.mjs',join(tmp,'factory-data'));
  t.after(()=>factory.child.kill('SIGTERM'));
  let r=await api(factory.base,'/api/studio/setup',{method:'POST',data:{name:'Owner',email:'owner@demo.example',password:pass}});
  assert.equal(r.status,201,JSON.stringify(r.body));const owner={cookie:r.cookie,csrf:r.body.csrf};
  r=await api(factory.base,'/api/studio/projects',{method:'POST',auth:owner,data:{name:'OSMANX Restaurant',type:'crm',industry:'restaurant',modules:['auth','clients','tasks','analytics','payments'],settings:{accent:'#91aaff',primaryAction:'new_client',currency:'RUB'}}});
  assert.equal(r.status,201,JSON.stringify(r.body));const project=r.body.project.id;
  const base=`/api/studio/projects/${project}`;
  r=await api(factory.base,base+'/releases',{method:'POST',data:{notes:'Initial customer release'}});assert.equal(r.status,401);
  r=await api(factory.base,base+'/releases',{method:'POST',auth:owner,data:{notes:'Initial customer release'}});
  assert.equal(r.status,201,JSON.stringify(r.body));const release1=r.body.release;
  assert.equal(release1.sequence,1);
  r=await api(factory.base,base+'/releases',{method:'POST',auth:owner,data:{notes:'Same snapshot should fail'}});assert.equal(r.status,409);
  const first=await fetch(factory.base+base+'/releases/'+release1.id+'/export',{headers:{cookie:owner.cookie}});
  assert.equal(first.status,200);
  const standalone=join(tmp,'independent');await extract(Buffer.from(await first.arrayBuffer()),standalone);
  const manifest1=JSON.parse(await readFile(join(standalone,'manifest.json')));
  assert.equal(manifest1.release.sequence,1);
  const dataDir=join(tmp,'crm-data');
  let crm=await launch(standalone,'run.mjs',dataDir);
  r=await api(crm.base,'/api/setup',{method:'POST',data:{name:'Admin',email:'admin@demo.example',password:pass}});
  assert.equal(r.status,201,JSON.stringify(r.body));const admin={cookie:r.cookie,csrf:r.body.csrf};
  r=await api(crm.base,'/api/clients',{method:'POST',data:{full_name:'Persistent Guest',phone:'777'},auth:admin});
  assert.equal(r.status,201,JSON.stringify(r.body));const guest=r.body.client.id;
  const during=cli(standalone,dataDir,'backup');assert.notEqual(during.status,0,'offline maintenance is forbidden while CRM runs');
  await stop(crm.child);
  const backup=cli(standalone,dataDir,'backup');assert.equal(backup.status,0,backup.stderr);
  const backupId=JSON.parse(backup.stdout).backupId;
  assert.equal(cli(standalone,dataDir,'verify',backupId).status,0);
  // Add an entity to the live factory project, then publish an independent immutable release.
  r=await api(factory.base,base+'/entities',{method:'POST',auth:owner,data:supplier});assert.equal(r.status,201,JSON.stringify(r.body));
  r=await api(factory.base,base+'/releases',{method:'POST',auth:owner,data:{notes:'Add suppliers data module'}});
  assert.equal(r.status,201,JSON.stringify(r.body));const release2=r.body.release;assert.equal(release2.sequence,2);
  r=await api(factory.base,base+'/releases',{auth:owner});assert.deepEqual(r.body.releases.map(x=>x.sequence),[2,1]);
  // v1 download must still contain no Suppliers entity.
  const frozen=await fetch(factory.base+base+'/releases/'+release1.id+'/export',{headers:{cookie:owner.cookie}});
  assert.equal(frozen.status,200);
  const frozenConf=JSON.parse(parseStoredZip(Buffer.from(await frozen.arrayBuffer())).get('config/project.json').toString());
  assert.equal(frozenConf.entities.length,0);
  const newer=await fetch(factory.base+base+'/releases/'+release2.id+'/export',{headers:{cookie:owner.cookie}});
  const updateZip=join(tmp,'release-v2.zip');await writeFile(updateZip,Buffer.from(await newer.arrayBuffer()));
  let result=cli(standalone,dataDir,'plan',updateZip);
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).to,2);
  const original=await readFile(join(standalone,'public/crm/app.css'));
  await writeFile(join(standalone,'public/crm/app.css'),Buffer.concat([original,Buffer.from(' /* custom edit */')]));
  result=cli(standalone,dataDir,'plan',updateZip);assert.notEqual(result.status,0,'manual code changes must block updates');
  await writeFile(join(standalone,'public/crm/app.css'),original);
  result=cli(standalone,dataDir,'update',updateZip);assert.notEqual(result.status,0,'explicit confirmation required');
  result=cli(standalone,dataDir,'update',updateZip,'--confirm');assert.equal(result.status,0,result.stderr);
  const updated=JSON.parse(result.stdout);assert.equal(updated.to,2);
  assert.equal(JSON.parse(await readFile(join(standalone,'manifest.json'))).release.sequence,2);
  assert.equal(cli(standalone,dataDir,'verify',updated.backupId).status,0);
  crm=await launch(standalone,'run.mjs',dataDir);
  r=await api(crm.base,'/api/login',{method:'POST',data:{email:'admin@demo.example',password:pass}});
  assert.equal(r.status,200,JSON.stringify(r.body));const resumed={cookie:r.cookie,csrf:r.body.csrf};
  r=await api(crm.base,'/api/clients',{auth:resumed});assert.equal(r.status,200);assert.equal(r.body.clients.length,1);assert.equal(r.body.clients[0].id,guest);
  r=await api(crm.base,'/api/entities',{auth:resumed});assert.ok(r.body.entities.some(x=>x.slug==='suppliers'));
  r=await api(crm.base,'/api/entities/suppliers/rows',{method:'POST',auth:resumed,data:{values:{company:'Vendor new'}}});assert.equal(r.status,201,JSON.stringify(r.body));
  await stop(crm.child);
  // Full pre-upgrade snapshot restores the original code, release and CRM rows.
  result=cli(standalone,dataDir,'restore',updated.backupId,'--confirm');assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(await readFile(join(standalone,'manifest.json'))).release.sequence,1);
  crm=await launch(standalone,'run.mjs',dataDir);
  r=await api(crm.base,'/api/login',{method:'POST',data:{email:'admin@demo.example',password:pass}});
  const returned={cookie:r.cookie,csrf:r.body.csrf};
  r=await api(crm.base,'/api/clients',{auth:returned});assert.equal(r.body.clients.length,1);
  r=await api(crm.base,'/api/entities',{auth:returned});assert.equal(r.body.entities.length,0);
  await stop(crm.child);
  // Simulate a power interruption marker and a damaged managed file.
  const activeCss=join(standalone,'public/crm/app.css');
  const expectedCss=await readFile(activeCss);
  await writeFile(join(dataDir,'update-in-progress.json'),JSON.stringify({backupId:updated.backupId}));
  await writeFile(activeCss,'corrupted generated source');
  const blocked=spawnSync(process.execPath,['run.mjs'],{cwd:standalone,env:{...process.env,DATA_DIR:dataDir,NODE_NO_WARNINGS:'1'},encoding:'utf8',timeout:8000});
  assert.notEqual(blocked.status,0,'interrupted upgrade must block standalone startup');
  const recovered=cli(standalone,dataDir,'recover','--confirm');assert.equal(recovered.status,0,recovered.stderr);
  assert.deepEqual(await readFile(activeCss),expectedCss);
  assert.equal(JSON.parse(await readFile(join(standalone,'manifest.json'))).release.sequence,1);
});
test('stored ZIP parser rejects CRC tampering and traversal',async()=>{
  const zip=createZip([{name:'config/project.json',data:'{}'}]);
  assert.equal(parseStoredZip(zip).size,1);
  const broken=Buffer.from(zip);const p=broken.indexOf(Buffer.from('{}'));broken[p]=0x61;
  assert.throws(()=>parseStoredZip(broken),/CRC/);
  assert.throws(()=>createZip([{name:'../evil',data:'x'}]),/Unsafe/);
});
