import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {parseStoredZip} from '../src/common/archive.mjs';
import {studioDb} from '../src/studio/db.mjs';
import {normalizeSitePage,makeSitePages} from '../src/site/model.mjs';
const root=resolve(import.meta.dirname,'..');
const pass='SuperSecretPass_123!';
async function port(){const s=createServer();await new Promise(ok=>s.listen(0,'127.0.0.1',ok));const p=s.address().port;await new Promise(ok=>s.close(ok));return p;}
async function start(cwd,script,data,p){
 const child=spawn(process.execPath,[script],{cwd,env:{...process.env,HOST:'127.0.0.1',PORT:String(p),DATA_DIR:data,NODE_NO_WARNINGS:'1',SETUP_TOKEN:''},stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',s=>log+=s);child.stderr.on('data',s=>log+=s);
 const origin=`http://127.0.0.1:${p}`;
 for(let i=0;i<120;i++){
  if(child.exitCode!==null)throw Error('Exit: '+log);
  try{const r=await fetch(origin+'/api/health');if(r.ok)return {child,origin};}catch{}
  await new Promise(ok=>setTimeout(ok,65));
 }
 child.kill();throw Error('Timeout: '+log);
}
async function request(origin,path,{method='GET',cookie,csrf,data,headers={}}={}){
 const h={...headers};if(cookie)h.cookie=cookie;if(csrf)h['x-csrf-token']=csrf;
 if(data!==undefined)h['content-type']='application/json';
 const res=await fetch(origin+path,{method,headers:h,body:data===undefined?undefined:JSON.stringify(data),redirect:'manual'});
 const txt=await res.text();let payload;try{payload=JSON.parse(txt);}catch{payload=txt;}
 return {status:res.status,payload,headers:res.headers,cookie:res.headers.get('set-cookie')?.split(';')[0]};
}
async function unzip(buffer,dest){
 const files=parseStoredZip(buffer);for(const [file,content] of files){const path=join(dest,file);await mkdir(dirname(path),{recursive:true});await writeFile(path,content);}
 return files;
}
test('R0.5: old projects migrate with FK references intact',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'ox-migration-'));
 const file=join(folder,'old.sqlite');
 const {DatabaseSync}=await import('node:sqlite');
 const db=new DatabaseSync(file);
 db.exec("PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(id), name TEXT,type TEXT CHECK(type IN ('crm')),industry TEXT CHECK(industry IN ('restaurant')),modules_json TEXT,settings_json TEXT,created_at TEXT,updated_at TEXT);CREATE TABLE project_pages(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),title TEXT,slug TEXT,description TEXT,published INTEGER,blocks_json TEXT,position INTEGER,revision INTEGER,created_at TEXT,updated_at TEXT);");
 db.prepare('INSERT INTO users VALUES(?)').run('owner');
 db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?,?,?,?)').run('old','owner','Retained','crm','restaurant','["auth"]','{"accent":"#91aaff"}','t','t');
 db.prepare('INSERT INTO project_pages VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('p','old','P','service','',1,'[]',0,1,'t','t');
 db.close();
 const migrated=studioDb(file);
 assert.equal(migrated.prepare('SELECT name FROM projects WHERE id=?').get('old').name,'Retained');
 assert.equal(migrated.prepare('SELECT project_id FROM project_pages WHERE id=?').get('p').project_id,'old');
 assert.equal(migrated.prepare('PRAGMA foreign_key_check').all().length,0);
 migrated.prepare('INSERT INTO projects(id,owner_id,name,type,industry,modules_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('site','owner','Site','site','business','["auth","cms"]','{}','t','t');
 migrated.close();
});
test('R0.5: site block contract rejects unsafe markup and URLs',()=>{
 const p=makeSitePages('Site');assert.equal(p.length,3);
 assert.equal(makeSitePages('Site',['auth','cms'])[2].blocks.some(b=>b.type==='form'),false);
 assert.throws(()=>normalizeSitePage({...p[0],blocks:[{id:'badbutton001',type:'button',label:'click',href:'javascript:alert(1)',style:'primary'}]}),/ссылки/);
 assert.throws(()=>normalizeSitePage({...p[0],blocks:[{id:'badscript001',type:'script',body:'x'}]}),/Неподдерживаемый/);
});
test('R0.5: factory site -> CMS auth -> real leads -> release -> clean independent ZIP', {timeout:120000},async t=>{
 const folder=await mkdtemp(join(tmpdir(),'ox-site-r05-'));
 const f=await start(root,'server.mjs',join(folder,'factory-data'),await port());t.after(()=>f.child.kill());
 let r=await request(f.origin,'/api/studio/blueprints');assert.equal(r.status,401);
 r=await request(f.origin,'/api/studio/setup',{method:'POST',data:{name:'Owner',email:'factory@example.test',password:pass}});assert.equal(r.status,201,JSON.stringify(r.payload));
 const ownerCookie=r.cookie,ownerCsrf=r.payload.csrf;
 r=await request(f.origin,'/api/studio/blueprints',{cookie:ownerCookie});assert.equal(r.status,200);assert.equal(r.payload.blueprints.length,2);
 r=await request(f.origin,'/api/studio/projects',{method:'POST',cookie:ownerCookie,csrf:ownerCsrf,
  data:{name:'ATELIER Agency',type:'site',industry:'business',modules:['auth','cms','leads'],settings:{accent:'#ccae7b',tagline:'Дизайн и инженерия',contactEmail:'hi@example.test'}}});
 assert.equal(r.status,201,JSON.stringify(r.payload));const site=r.payload.project,id=site.id,base=`/workspace/${id}`;
 assert.equal(site.pages.length,3);assert.equal(site.type,'site');
 r=await request(f.origin,base+'/');assert.equal(r.status,200);assert.match(r.payload,/ATELIER Agency/);assert.match(r.payload,/rel="stylesheet"/);
 assert.doesNotMatch(r.payload,/<style>/);
 r=await request(f.origin,base+'/contacts');assert.equal(r.status,200);assert.match(r.payload,/data-site-lead="contacts"/);
 r=await request(f.origin,base+'/assets/site.css');assert.equal(r.status,200);assert.match(r.payload,/\.site-header/);
 r=await request(f.origin,base+'/assets/theme.css');assert.equal(r.status,200);assert.match(r.payload,/#ccae7b/);
 r=await request(f.origin,base+'/admin');assert.equal(r.status,200);assert.match(r.payload,/OSMANX/);
 r=await request(f.origin,base+'/robots.txt');assert.equal(r.status,200);assert.match(r.payload,/Disallow: \/$/m);
 r=await request(f.origin,base+'/sitemap.xml');assert.equal(r.status,404,'No sitemap without configured production URL');
 r=await request(f.origin,base+'/api/site/setup',{method:'POST',data:{name:'Intruder',email:'bad@example.test',password:pass}});assert.equal(r.status,403);
 r=await request(f.origin,base+'/api/site/setup',{method:'POST',cookie:ownerCookie,headers:{'x-studio-csrf-token':ownerCsrf},data:{name:'Site Admin',email:'site-admin@example.test',password:pass}});
 assert.equal(r.status,201,JSON.stringify(r.payload));const adminCookie=r.cookie,adminCsrf=r.payload.csrf;
 r=await request(f.origin,base+'/api/site/leads');assert.equal(r.status,401);
 r=await request(f.origin,base+'/api/site/leads',{method:'POST',data:{page:'contacts',name:'Client'}});assert.equal(r.status,400);
 r=await request(f.origin,base+'/api/site/leads',{method:'POST',data:{page:'services',name:'Client',phone:'+79991112233'}});assert.equal(r.status,404);
 r=await request(f.origin,base+'/api/site/leads',{method:'POST',data:{page:'contacts',name:'Client',phone:'+79991112233',email:'client@example.test',message:'Need website',website:''}});
 assert.equal(r.status,201,JSON.stringify(r.payload));
 r=await request(f.origin,base+'/api/site/overview',{cookie:adminCookie});assert.equal(r.status,200);assert.equal(r.payload.overview.leads,1);
 r=await request(f.origin,base+'/api/site/leads',{cookie:adminCookie});assert.equal(r.status,200);assert.equal(r.payload.leads[0].message,'Need website');const lead=r.payload.leads[0];
 r=await request(f.origin,base+'/api/site/leads/'+lead.id,{method:'PATCH',cookie:adminCookie,data:{status:'closed'}});assert.equal(r.status,403,'CSRF required');
 r=await request(f.origin,base+'/api/site/leads/'+lead.id,{method:'PATCH',cookie:adminCookie,csrf:adminCsrf,data:{status:'in_progress'}});assert.equal(r.status,200);
 r=await request(f.origin,base+'/api/site/pages',{cookie:adminCookie});assert.equal(r.status,200);const home=r.payload.pages.find(p=>p.slug==='home');
 r=await request(f.origin,base+'/api/site/pages/'+home.id,{method:'PATCH',cookie:adminCookie,csrf:adminCsrf,
  data:{...home,title:'Главная',blocks:[{id:'hero-secure-001',type:'hero',eyebrow:'ATELIER',title:'<script>alert(1)</script>',subtitle:'Works'}]}});
 assert.equal(r.status,200,JSON.stringify(r.payload));
 r=await request(f.origin,base+'/');assert.equal(r.status,200);assert.match(r.payload,/&lt;script&gt;/);assert.doesNotMatch(r.payload,/<script>alert\(1\)<\/script>/);
 r=await request(f.origin,base+'/api/site/pages/'+home.id,{method:'PATCH',cookie:adminCookie,csrf:adminCsrf,data:{...home}});assert.equal(r.status,409);
 r=await request(f.origin,base+'/api/site/settings',{method:'PATCH',cookie:adminCookie,csrf:adminCsrf,data:{brand:'Atelier 2',accent:'#dbb078',tagline:'Новые слова',contactEmail:'office@example.test'}});assert.equal(r.status,200);
 r=await request(f.origin,base+'/');assert.match(r.payload,/Atelier 2/);
 const studioPages=await request(f.origin,`/api/studio/projects/${id}/pages`,{cookie:ownerCookie});assert.equal(studioPages.status,200);
 const page=studioPages.payload.pages.find(p=>p.slug==='services');
 r=await request(f.origin,`/api/studio/projects/${id}/pages/${page.id}`,{method:'PATCH',cookie:ownerCookie,csrf:ownerCsrf,data:{...page,title:'Все направления',blocks:[{id:'site-hero-001',type:'hero',eyebrow:'Услуги',title:'Услуги <b>компании</b>',subtitle:'Содержимое управляется из Studio'}]}});
 assert.equal(r.status,200,JSON.stringify(r.payload));
 r=await request(f.origin,base+'/services');assert.equal(r.status,200);assert.match(r.payload,/Услуги &lt;b&gt;компании&lt;\/b&gt;/);
 // The type of an existing CRM/site project cannot be changed in place.
 r=await request(f.origin,`/api/studio/projects/${id}`,{method:'PATCH',cookie:ownerCookie,csrf:ownerCsrf,data:{type:'crm'}});
 assert.equal(r.status,400);
 // A second website can be created without the lead module: no public form is exposed.
 r=await request(f.origin,'/api/studio/projects',{method:'POST',cookie:ownerCookie,csrf:ownerCsrf,
  data:{name:'Brochure only',type:'site',industry:'business',modules:['auth','cms'],settings:{accent:'#dab585',tagline:'',contactEmail:''}}});
 assert.equal(r.status,201,JSON.stringify(r.payload));
 const noLeadsId=r.payload.project.id;
 assert.equal(r.payload.project.pages.find(x=>x.slug==='contacts').blocks.some(b=>b.type==='form'),false);
 r=await request(f.origin,`/workspace/${noLeadsId}/contacts`);
 assert.equal(r.status,200);assert.doesNotMatch(r.payload,/data-site-lead=/);
 r=await request(f.origin,`/workspace/${noLeadsId}/api/site/leads`,{method:'POST',data:{page:'contacts',name:'X',phone:'+79998887766'}});
 assert.equal(r.status,404);
 r=await request(f.origin,`/api/studio/projects/${id}/releases`,{method:'POST',cookie:ownerCookie,csrf:ownerCsrf,data:{notes:'First company site'}});assert.equal(r.status,201,JSON.stringify(r.payload));const rel=r.payload.release;
 const exported=await fetch(f.origin+`/api/studio/projects/${id}/releases/${rel.id}/export`,{headers:{cookie:ownerCookie}});
 assert.equal(exported.status,200);const zip=Buffer.from(await exported.arrayBuffer());const unpack=join(folder,'standalone');const files=await unzip(zip,unpack);
 assert.ok(files.has('src/site/routes.mjs'));assert.ok(files.has('public/site/admin.js'));
 assert.equal(files.has('src/crm/routes.mjs'),false);
 assert.ok(!zip.includes(Buffer.from('client@example.test')),'Site customer data not exported');
 assert.ok(!zip.includes(Buffer.from('site-admin@example.test')),'Site credentials not exported');
 const st=await start(unpack,'run.mjs',join(folder,'independent-data'),await port());t.after(()=>st.child.kill());
 r=await request(st.origin,'/');assert.equal(r.status,200);assert.match(r.payload,/ATELIER Agency/);
 assert.doesNotMatch(r.payload,/Atelier 2/,'CMS local edits must not leak into export');
 r=await request(st.origin,'/api/site/session');assert.equal(r.payload.initialized,false);
 r=await request(st.origin,'/api/site/leads',{method:'POST',data:{page:'contacts',name:'Independent',phone:'+79998887766',message:'Hello'}});assert.equal(r.status,201);
 r=await request(st.origin,'/api/site/setup',{method:'POST',data:{name:'Independent Admin',email:'independent@example.test',password:pass}});assert.equal(r.status,201);
 r=await request(st.origin,'/api/site/leads',{cookie:r.cookie});assert.equal(r.status,200);assert.equal(r.payload.leads.length,1);
});

test('R0.5: standalone website backup, live-server gate, verify and rollback of leads', {timeout:120000},async t=>{
 const {exportProject}=await import('../src/studio/export.mjs');
 const {randomUUID}=await import('node:crypto');
 const {spawnSync}=await import('node:child_process');
 const dir=await mkdtemp(join(tmpdir(),'ox-site-backup-'));
 const app=join(dir,'site'),data=join(dir,'database');
 const project={id:randomUUID(),name:'BACKUP TEST',type:'site',industry:'business',modules:['auth','cms','leads'],settings:{accent:'#d0a976',tagline:'',contactEmail:''},pages:makeSitePages(),entities:[]};
 const zip=await exportProject(project,root);await unzip(zip,app);
 async function close(proc){proc.kill('SIGTERM');await new Promise(resolve=>{if(proc.exitCode!==null)return resolve();proc.once('exit',resolve);});}
 function maintenance(...args){return spawnSync(process.execPath,['ops.mjs',...args],{cwd:app,encoding:'utf8',env:{...process.env,DATA_DIR:data,NODE_NO_WARNINGS:'1'}});}
 let service=await start(app,'run.mjs',data,await port());t.after(()=>service.child.kill());
 let r=await request(service.origin,'/api/site/setup',{method:'POST',data:{name:'Owner',email:'owner@example.test',password:pass}});
 assert.equal(r.status,201);let cookie=r.cookie;
 r=await request(service.origin,'/api/site/leads',{method:'POST',data:{page:'contacts',name:'First',phone:'+79990000000'}});assert.equal(r.status,201);
 assert.notEqual(maintenance('backup').status,0,'cannot back up while server is live');
 await close(service.child);
 const first=maintenance('backup');assert.equal(first.status,0,first.stderr);
 const saved=JSON.parse(first.stdout);assert.match(saved.id,/^\d{14}-[0-9a-f]{8}$/);
 assert.equal(maintenance('verify',saved.id).status,0);
 service=await start(app,'run.mjs',data,await port());
 r=await request(service.origin,'/api/site/leads',{method:'POST',data:{page:'contacts',name:'Second',phone:'+79991111111'}});assert.equal(r.status,201);
 r=await request(service.origin,'/api/site/leads',{cookie});assert.equal(r.status,200);assert.equal(r.payload.leads.length,2);
 await close(service.child);
 const restore=maintenance('restore',saved.id,'--confirm');assert.equal(restore.status,0,restore.stderr);
 assert.ok(JSON.parse(restore.stdout).safetyBackup,'restore must create pre-restore recovery point');
 service=await start(app,'run.mjs',data,await port());
 r=await request(service.origin,'/api/site/login',{method:'POST',data:{email:'owner@example.test',password:pass}});assert.equal(r.status,200);
 r=await request(service.origin,'/api/site/leads',{cookie:r.cookie});assert.equal(r.status,200);assert.deepEqual(r.payload.leads.map(l=>l.name),['First']);
 await close(service.child);
});
