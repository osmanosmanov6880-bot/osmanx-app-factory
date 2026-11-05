import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { parseStoredZip } from '../src/common/archive.mjs';
import { studioDb } from '../src/studio/db.mjs';
import { hashPassword, id, issueSession, now } from '../src/common/security.mjs';
const root=resolve(import.meta.dirname,'..');
const pass='Super_Strong_2026_Pass!';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const srv=createServer();await new Promise(r=>srv.listen(0,'127.0.0.1',r));const port=srv.address().port;await new Promise(r=>srv.close(r));return port;}
async function startServer(data,port){
 const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);
 for(let i=0;i<80;i++){
   if(child.exitCode!==null)throw Error('Server exited: '+logs);
   try{if((await fetch(`http://127.0.0.1:${port}/api/health`)).ok)return child;}catch{}
   await sleep(100);
 }
 child.kill();throw Error('Server timeout: '+logs);
}
async function api(base,path,{method='GET',data,csrf,cookie,headers={}}={}){
 const h={...headers};if(data!==undefined)h['content-type']='application/json';if(csrf)h['x-csrf-token']=csrf;if(cookie)h.cookie=cookie;
 const r=await fetch(base+path,{method,headers:h,body:data===undefined?undefined:JSON.stringify(data)});
 const result=await r.json().catch(()=>null);
 return {status:r.status,data:result,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
const auth=(base,cookie,csrf,path,method='GET',data)=>api(base,path,{method,data,cookie,csrf});
test('R0.8: reusable templates, portable import, duplication, diagnostics, and owner isolation', {timeout:120000}, async t=>{
 const data=await mkdtemp(join(tmpdir(),'osmanx-r08-template-'));
 const port=await freePort(),base=`http://127.0.0.1:${port}`;
 const proc=await startServer(data,port);t.after(()=>proc.kill('SIGTERM'));
 let r=await api(base,'/api/studio/setup',{method:'POST',data:{name:'Owner One',email:'owner-one@demo.test',password:pass}});
 assert.equal(r.status,201,JSON.stringify(r.data));
 const ownerCookie=r.cookie,ownerCsrf=r.data.csrf,ownerId=r.data.user.id;
 const created=await auth(base,ownerCookie,ownerCsrf,'/api/studio/projects','POST',{
  type:'crm',name:'Restaurant Master',industry:'restaurant',modules:['auth','clients','tasks','analytics','payments'],
  settings:{accent:'#ad9774',primaryAction:'new_client',currency:'RUB'}});
 assert.equal(created.status,201,JSON.stringify(created.data));const project=created.data.project;
 const sourcePath=`/workspace/${project.id}`;
 // Add a real custom entity to prove schema portability.
 const supplier={slug:'suppliers',title:'Suppliers',description:'Vendor registry',access:{read:['admin','manager','staff'],write:['admin','manager']},fields:[{key:'legal_name',label:'Company name',type:'text',required:true}]};
 r=await auth(base,ownerCookie,ownerCsrf,`/api/studio/projects/${project.id}/entities`,'POST',supplier);
 assert.equal(r.status,201,JSON.stringify(r.data));
 // Bootstrap real CRM and put a customer in its SQLite DB, which MUST NOT be cloned.
 r=await api(base,sourcePath+'/api/setup',{method:'POST',cookie:ownerCookie,headers:{'x-studio-csrf-token':ownerCsrf},data:{name:'CRM Admin',email:'crm@demo.test',password:pass}});
 assert.equal(r.status,201,JSON.stringify(r.data));const crmCookie=r.cookie,crmCsrf=r.data.csrf;
 r=await auth(base,crmCookie,crmCsrf,sourcePath+'/api/clients','POST',{full_name:'SENSITIVE GUEST RECORD',source:'walkin'});
 assert.equal(r.status,201,JSON.stringify(r.data));
 // Create a reusable private blueprint and verify it is stored without credentials/customer data.
 r=await auth(base,ownerCookie,ownerCsrf,'/api/studio/templates','POST', {projectId:project.id,name:'Restaurant Gold',description:'Config only'});
 assert.equal(r.status,201,JSON.stringify(r.data));const templateId=r.data.template.id;
 r=await auth(base,ownerCookie,ownerCsrf,'/api/studio/templates');assert.equal(r.status,200);assert.equal(r.data.templates.length,1);
 r=await auth(base,ownerCookie,ownerCsrf,`/api/studio/templates/${templateId}/download`);
 assert.equal(r.status,200);const portable=r.data;
 assert.equal(portable.format,'osmanx-factory-template');
 assert.equal(portable.snapshot.entities.length,1);
 assert.ok(!JSON.stringify(portable).includes('SENSITIVE GUEST RECORD'));
 assert.ok(!JSON.stringify(portable).includes('password_hash'));
 assert.ok(!JSON.stringify(portable).includes(ownerId));
 // Template instance retains entity definitions and pages but has a new project identity.
 r=await auth(base,ownerCookie,ownerCsrf,`/api/studio/templates/${templateId}/projects`,'POST',{name:'Restaurant Branch Two'});
 assert.equal(r.status,201,JSON.stringify(r.data));
 const instance=r.data.project;assert.notEqual(instance.id,project.id);assert.equal(instance.entities[0].slug,'suppliers');
 assert.equal(instance.entities[0].revision,1);assert.equal(instance.pages.length,project.pages.length);
 assert.notEqual(instance.pages[0].id,project.pages[0].id);
 const secondPath=`/workspace/${instance.id}`;
 r=await api(base,secondPath+'/api/session');assert.equal(r.status,200);assert.equal(r.data.initialized,false);
 r=await api(base,secondPath+'/api/setup',{method:'POST',cookie:ownerCookie,headers:{'x-studio-csrf-token':ownerCsrf},data:{name:'Second CRM Admin',email:'second@demo.test',password:pass}});
 assert.equal(r.status,201,JSON.stringify(r.data));
 r=await auth(base,r.cookie,r.data.csrf,secondPath+'/api/clients');assert.equal(r.status,200);assert.equal(r.data.clients.length,0);
 // Clone directly, then export independently and verify no guest data leaks.
 r=await auth(base,ownerCookie,ownerCsrf,`/api/studio/projects/${project.id}/clone`,'POST',{name:'Restaurant Copy Three'});
 assert.equal(r.status,201,JSON.stringify(r.data));const clone=r.data.project;
 assert.equal(clone.entities.length,1);assert.notEqual(clone.id,project.id);
 const exportResponse=await fetch(base+`/api/studio/projects/${clone.id}/export`,{headers:{cookie:ownerCookie}});
 assert.equal(exportResponse.status,200);
 const zip=parseStoredZip(Buffer.from(await exportResponse.arrayBuffer()));
 const config=JSON.parse(zip.get('config/project.json').toString('utf8'));
 assert.equal(config.name,'Restaurant Copy Three');
 assert.equal(config.entities[0].slug,'suppliers');
 assert.ok(!JSON.stringify(config).includes('SENSITIVE GUEST RECORD'));
 // Portable import is checksum-verified, and a corrupted schema is rejected.
 const tampered=structuredClone(portable);tampered.snapshot.name='TAMPERED';
 r=await auth(base,ownerCookie,ownerCsrf,'/api/studio/templates/import','POST',tampered);
 assert.equal(r.status,400);
 r=await auth(base,ownerCookie,ownerCsrf,'/api/studio/templates/import','POST',portable);
 assert.equal(r.status,201);const importedId=r.data.template.id;
 r=await auth(base,ownerCookie,ownerCsrf,`/api/studio/projects/${project.id}/diagnostics`);
 assert.equal(r.status,200);assert.equal(r.data.summary.exportReady,true);
 assert.ok(r.data.checks.some(x=>x.key==='payments'&&x.level==='warning'));
 // Owner isolation: a second owner cannot see, create from, or delete first owner's template.
 const otherId=id(),db=studioDb(join(data,'studio.sqlite'));
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)').run(otherId,'other@demo.test','Other Owner',hashPassword(pass),'owner',now());db.close();
 r=await api(base,'/api/studio/login',{method:'POST',data:{email:'other@demo.test',password:pass}});
 assert.equal(r.status,200);const otherCookie=r.cookie,otherCsrf=r.data.csrf;
 r=await auth(base,otherCookie,otherCsrf,'/api/studio/templates');assert.equal(r.status,200);assert.equal(r.data.templates.length,0);
 r=await auth(base,otherCookie,otherCsrf,`/api/studio/templates/${templateId}/download`);assert.equal(r.status,404);
 r=await auth(base,otherCookie,otherCsrf,`/api/studio/templates/${templateId}/projects`,'POST',{name:'Stolen'});assert.equal(r.status,404);
 r=await auth(base,otherCookie,otherCsrf,`/api/studio/templates/${templateId}`,'DELETE');assert.equal(r.status,404);
 r=await auth(base,otherCookie,otherCsrf,`/api/studio/projects/${project.id}/clone`,'POST',{name:'Stolen'});assert.equal(r.status,404);
 r=await auth(base,ownerCookie,ownerCsrf,`/api/studio/templates/${templateId}`,'DELETE');assert.equal(r.status,200);
 r=await auth(base,ownerCookie,ownerCsrf,'/api/studio/templates');assert.equal(r.data.templates.length,1);
 assert.equal(r.data.templates[0].id,importedId);
 r=await auth(base,ownerCookie,ownerCsrf,`/api/studio/projects/${instance.id}`);
 assert.equal(r.status,200,'Deleting template must not affect created projects');
});
test('R0.8: website templates retain published pages and valid lead module', {timeout:120000}, async t=>{
 const data=await mkdtemp(join(tmpdir(),'osmanx-r08-site-')),port=await freePort(),base=`http://127.0.0.1:${port}`;
 const proc=await startServer(data,port);t.after(()=>proc.kill('SIGTERM'));
 let r=await api(base,'/api/studio/setup',{method:'POST',data:{name:'Owner Site',email:'site@demo.test',password:pass}});
 assert.equal(r.status,201);const cookie=r.cookie,csrf=r.data.csrf;
 r=await auth(base,cookie,csrf,'/api/studio/projects','POST',{type:'site',name:'Premium Company',industry:'business',modules:['auth','cms','leads'],settings:{accent:'#d0a976',tagline:'Service',contactEmail:'hi@demo.test'}});
 assert.equal(r.status,201,JSON.stringify(r.data));const project=r.data.project;
 r=await auth(base,cookie,csrf,'/api/studio/templates','POST',{projectId:project.id,name:'Website Starter'});assert.equal(r.status,201);
 r=await auth(base,cookie,csrf,`/api/studio/templates/${r.data.template.id}/projects`,'POST',{name:'Another Premium Site'});
 assert.equal(r.status,201,JSON.stringify(r.data));const child=r.data.project;
 assert.equal(child.type,'site');assert.equal(child.pages.length,3);assert.ok(child.pages.some(x=>x.slug==='home'));
 r=await auth(base,cookie,csrf,`/api/studio/projects/${child.id}/diagnostics`);
 assert.equal(r.status,200);assert.equal(r.data.summary.exportReady,true);
 assert.ok(r.data.checks.some(x=>x.key==='contact')===false);
});
