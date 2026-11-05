import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const password='V5_secure_backup_2026';
async function freePort(){const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const p=socket.address().port;await new Promise(r=>socket.close(r));return p;}
async function start(dir){const port=await freePort();const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dir,NODE_NO_WARNINGS:'1'},stdio:'ignore'});
  for(let i=0;i<80;i++){if(child.exitCode!==null)throw Error('Factory exited');try{const r=await fetch(`http://127.0.0.1:${port}/api/health`);if(r.ok)return {child,url:`http://127.0.0.1:${port}`};}catch{}await new Promise(r=>setTimeout(r,80));}throw Error('Factory failed startup');}
async function stop(child){child.kill('SIGTERM');await once(child,'exit');}
async function api(origin,path,method='GET',body,auth={},extra={}){
  const headers={...extra};if(body)headers['Content-Type']='application/json';if(auth.cookie)headers.cookie=auth.cookie;if(auth.csrf)headers['x-csrf-token']=auth.csrf;
  const res=await fetch(origin+path,{method,headers,body:body?JSON.stringify(body):undefined});return {status:res.status,json:await res.json(),cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
function run(data,...args){return spawnSync(process.execPath,['scripts/factory_maintenance.mjs',...args],{cwd:root,env:{...process.env,DATA_DIR:data,NODE_NO_WARNINGS:'1'},encoding:'utf8',timeout:20000});}
function newProject(n){return {name:n,type:'crm',industry:'restaurant',modules:['auth','clients','analytics','tasks','payments'],settings:{accent:'#91aaff',currency:'RUB',primaryAction:'new_client'}};}
test('offline factory backup and guarded database restoration',{timeout:60000},async t=>{
  const tmp=await mkdtemp(join(tmpdir(),'osmanx-factory-r04-'));t.after(()=>rm(tmp,{recursive:true,force:true}));
  const data=join(tmp,'data');let app=await start(data);
  let r=await api(app.url,'/api/studio/setup','POST',{name:'Owner',email:'test@example.com',password});assert.equal(r.status,201);
  const auth={cookie:r.cookie,csrf:r.json.csrf};
  r=await api(app.url,'/api/studio/projects','POST',newProject('Before backup'),auth);assert.equal(r.status,201);const first=r.json.project.id;
  // Initialize and populate the project database, not just the studio database.
  const crmPath=`/workspace/${first}`;
  r=await api(app.url,crmPath+'/api/setup','POST',{name:'CRM admin',email:'admin@resto.example',password},auth,{'x-studio-csrf-token':auth.csrf});
  assert.equal(r.status,201,JSON.stringify(r.json));const crmAuth={cookie:r.cookie,csrf:r.json.csrf};
  r=await api(app.url,crmPath+'/api/clients','POST',{full_name:'Guest before backup'},crmAuth);assert.equal(r.status,201);
  const forbidden=run(data,'backup');assert.notEqual(forbidden.status,0,'Factory must be stopped');
  await stop(app.child);
  const created=run(data,'backup');assert.equal(created.status,0,created.stderr);const backupId=JSON.parse(created.stdout).backupId;
  assert.equal(run(data,'verify',backupId).status,0);
  app=await start(data);
  r=await api(app.url,crmPath+'/api/clients','POST',{full_name:'Guest after backup'},crmAuth);assert.equal(r.status,201);
  r=await api(app.url,'/api/studio/projects','POST',newProject('After backup'),auth);assert.equal(r.status,201);
  r=await api(app.url,'/api/studio/projects','GET',undefined,auth);assert.equal(r.json.projects.length,2);
  await stop(app.child);
  assert.notEqual(run(data,'restore',backupId).status,0,'Restore must need explicit confirmation');
  const restore=run(data,'restore',backupId,'--confirm');assert.equal(restore.status,0,restore.stderr);
  app=await start(data);
  r=await api(app.url,'/api/studio/projects','GET',undefined,auth);
  assert.equal(r.status,200,JSON.stringify(r.json));assert.equal(r.json.projects.length,1);assert.equal(r.json.projects[0].id,first);
  r=await api(app.url,crmPath+'/api/login','POST',{email:'admin@resto.example',password});assert.equal(r.status,200);
  r=await api(app.url,crmPath+'/api/clients','GET',undefined,{cookie:r.cookie,csrf:r.json.csrf});
  assert.equal(r.status,200);assert.equal(r.json.clients.length,1);assert.equal(r.json.clients[0].full_name,'Guest before backup');

  await stop(app.child);
});
