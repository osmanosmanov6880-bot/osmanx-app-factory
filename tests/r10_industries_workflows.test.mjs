import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {createIndustryPack,industryCatalog} from '../src/studio/industries.mjs';
import {openDb} from '../src/common/db.mjs';
import {initializeAutomations} from '../src/crm/automations.mjs';
import {studioDb} from '../src/studio/db.mjs';

const root=join(import.meta.dirname,'..');
const pass='Secure_Password_For_R10_012345';
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function launch(script,cwd,dir,p){
 const proc=spawn(process.execPath,[script],{cwd,env:{...process.env,PORT:String(p),HOST:'127.0.0.1',DATA_DIR:dir,NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
 let logs='';for(const stream of [proc.stdout,proc.stderr])stream.on('data',d=>logs+=d);
 for(let i=0;i<90;i++){if(proc.exitCode!==null)throw Error(logs);try{if((await fetch(`http://127.0.0.1:${p}/api/health`)).ok)return proc;}catch{}await new Promise(r=>setTimeout(r,70));}
 proc.kill();throw Error('Server failed: '+logs);
}
async function req(origin,path,method='GET',data,session={}){
 const headers={};if(data!==undefined)headers['content-type']='application/json';if(session.cookie)headers.cookie=session.cookie;if(session.csrf)headers['x-csrf-token']=session.csrf;if(session.extra)Object.assign(headers,session.extra);
 const r=await fetch(origin+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
 const body=await r.json().catch(()=>({}));return {status:r.status,body,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
async function unpack(buf,dest){
 await mkdir(dest,{recursive:true});const file=join(dest,'export.zip');await writeFile(file,buf);execFileSync('unzip',['-q',file,'-d',dest]);
}

test('R1.0 declarative industry packs: five distinct blueprints, valid pages and entity links',()=>{
 const all=industryCatalog();assert.deepEqual(all.map(x=>x.id),['restaurant','dental','auto','beauty','retail']);
 for(const {id} of all){
  const pack=createIndustryPack(id,['auth','clients','tasks']);assert.ok(pack.pages.length>0);
  assert.equal(pack.entities.length,id==='restaurant'?0:3);
  for(const entity of pack.entities)for(const field of entity.fields)if(field.type==='reference')assert.ok(pack.entities.some(x=>x.slug===field.target));
  assert.ok(pack.pages.every(p=>p.published));
 }
});

test('R1.0 additive automation migration keeps existing rules',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ox-aut-migrate-'));
 const db=openDb(join(dir,'db.sqlite'));
 try{
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE tasks(id TEXT PRIMARY KEY);
   CREATE TABLE automations (id TEXT PRIMARY KEY,name TEXT NOT NULL,event TEXT NOT NULL CHECK(event IN ('client_created','visit_created')),task_title TEXT NOT NULL,priority TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,created_by TEXT,created_at TEXT NOT NULL);
   INSERT INTO automations(id,name,event,task_title,priority,enabled,created_by,created_at) VALUES('old-rule','Legacy','client_created','Call','medium',1,NULL,'2026-10-01');`);
  db.exec("INSERT INTO users(id) VALUES('u'); INSERT INTO tasks(id) VALUES('t'); CREATE TABLE automation_runs(id TEXT PRIMARY KEY,automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,event_key TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),created_at TEXT NOT NULL,UNIQUE(automation_id,event_key)); INSERT INTO automation_runs VALUES('run1','old-rule','event1','t','2026-10-02');");
  initializeAutomations(db);initializeAutomations(db);
  const fields=new Set(db.prepare('PRAGMA table_info(automations)').all().map(x=>x.name));
  for(const key of ['entity_slug','condition_field','condition_value','due_days'])assert.ok(fields.has(key),key);
  assert.equal(db.prepare('SELECT task_title FROM automations WHERE id=?').get('old-rule').task_title,'Call');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM automation_runs').get().n,1,'existing run logs retained');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{db.close()}
});

test('R1.0 studio industry migration preserves legacy projects and linked pages',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ox-studio-migration-')),path=join(dir,'studio.sqlite');
 const before=openDb(path);
 try{
  before.exec(`CREATE TABLE users(id TEXT PRIMARY KEY);INSERT INTO users(id) VALUES('owner');
   CREATE TABLE projects(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),name TEXT,type TEXT CHECK(type IN ('crm','site')),industry TEXT NOT NULL CHECK(industry IN ('restaurant','business')),modules_json TEXT,settings_json TEXT,created_at TEXT,updated_at TEXT);
   INSERT INTO projects VALUES('project1','owner','Старый ресторан','crm','restaurant','["auth"]','{}','2026-11-01','2026-11-01');
   CREATE TABLE project_pages(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, position INTEGER NOT NULL DEFAULT 0, created_at TEXT); 
   INSERT INTO project_pages(id,project_id) VALUES('page1','project1');`);
 }finally{before.close()}
 const after=studioDb(path);
 try{
  assert.equal(after.prepare('SELECT industry FROM projects WHERE id=?').get('project1').industry,'restaurant');
  assert.equal(after.prepare('SELECT project_id FROM project_pages WHERE id=?').get('page1').project_id,'project1');
  after.prepare('INSERT INTO projects(id,owner_id,name,type,industry,modules_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('project2','owner','Клиника','crm','dental','["auth"]','{}','2026-11-04','2026-11-04');
  assert.equal(after.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{after.close()}
});

test('R1.0 complete HTTP: industry packs → data → conditional automation → reusable template → standalone ZIP', {timeout:120000}, async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ox-r10-full-')),p=await port(),origin=`http://127.0.0.1:${p}`;
 const server=await launch('server.mjs',root,join(dir,'factory'),p);t.after(()=>server.kill('SIGTERM'));
 let r=await req(origin,'/api/studio/setup','POST',{name:'Owner',email:'owner@r10.test',password:pass});assert.equal(r.status,201,JSON.stringify(r.body));
 const owner={cookie:r.cookie,csrf:r.body.csrf};
 r=await req(origin,'/api/studio/industries','GET',undefined,owner);assert.equal(r.status,200);assert.equal(r.body.industries.length,5);
 const created={};
 for(const industry of ['restaurant','dental','auto','beauty','retail']){
  r=await req(origin,'/api/studio/projects','POST',{type:'crm',industry,name:'CRM '+industry,modules:['auth','clients','analytics','tasks','payments'],settings:{accent:'#c9a473',currency:'RUB',primaryAction:'new_client'}},owner);
  assert.equal(r.status,201,`${industry}: ${JSON.stringify(r.body)}`);
  created[industry]=r.body.project;
  assert.equal(created[industry].entities.length,industry==='restaurant'?0:3);
  assert.ok(created[industry].pages.some(x=>x.published));
 }
 const dental=created.dental,base=`/workspace/${dental.id}`;
 r=await req(origin,base+'/api/setup','POST',{name:'Admin',email:'admin@r10.test',password:pass},{cookie:owner.cookie,extra:{'x-studio-csrf-token':owner.csrf}});
 assert.equal(r.status,201,JSON.stringify(r.body));const admin={cookie:r.cookie,csrf:r.body.csrf};
 r=await req(origin,base+'/api/automations','POST',{name:'Некорректное правило',event:'entity_created',entity_slug:'missing',task_title:'Nope'},admin);assert.equal(r.status,400);
 r=await req(origin,base+'/api/automations','POST',{name:'Подтверждённый приём',event:'entity_created',entity_slug:'appointments',condition_field:'status',condition_value:'Подтверждена',task_title:'Подготовить кабинет: {{doctor}}',priority:'high',due_days:2},admin);
 assert.equal(r.status,201,JSON.stringify(r.body));const rule=r.body.automation;
 r=await req(origin,base+'/api/entities/patients/rows','POST',{values:{full_name:'Тестовый пациент',phone:'100',consent:true}},admin);
 assert.equal(r.status,201,JSON.stringify(r.body));const patient=r.body.row.id;
 const makeAppointment=status=>req(origin,base+'/api/entities/appointments/rows','POST',{values:{patient,doctor:'Тестовый врач',date:'2026-11-06',status}},admin);
 r=await makeAppointment('Запланирована');assert.equal(r.status,201,JSON.stringify(r.body));
 r=await req(origin,base+'/api/tasks','GET',undefined,admin);assert.equal(r.body.tasks.length,0);
 r=await makeAppointment('Подтверждена');assert.equal(r.status,201,JSON.stringify(r.body));
 r=await req(origin,base+'/api/tasks','GET',undefined,admin);assert.equal(r.body.tasks.length,1);assert.equal(r.body.tasks[0].title,'Подготовить кабинет: Тестовый врач');assert.equal(r.body.tasks[0].priority,'high');assert.ok(r.body.tasks[0].due_at);
 r=await req(origin,base+'/api/automations/runs','GET',undefined,admin);assert.equal(r.body.runs.length,1);
 r=await req(origin,base+'/api/automations/'+rule.id,'PATCH',{enabled:false},admin);assert.equal(r.status,200);
 r=await makeAppointment('Подтверждена');assert.equal(r.status,201);
 r=await req(origin,base+'/api/tasks','GET',undefined,admin);assert.equal(r.body.tasks.length,1);
 r=await req(origin,'/api/studio/templates','POST',{projectId:dental.id,name:'Стоматология — база'},owner);assert.equal(r.status,201,JSON.stringify(r.body));const templateId=r.body.template.id;
 r=await req(origin,`/api/studio/templates/${templateId}/projects`,'POST',{name:'Клиника 2'},owner);assert.equal(r.status,201);assert.equal(r.body.project.entities.length,3);assert.notEqual(r.body.project.id,dental.id);
 const zipResponse=await fetch(origin+`/api/studio/projects/${dental.id}/export`,{headers:{cookie:owner.cookie}});assert.equal(zipResponse.status,200);
 const isolated=join(dir,'independent');await unpack(Buffer.from(await zipResponse.arrayBuffer()),isolated);
 const exportedProject=JSON.parse(await readFile(join(isolated,'config/project.json'),'utf8'));
 assert.equal(exportedProject.industry,'dental');assert.equal(exportedProject.entities.length,3);
 const otherPort=await port();const independent=await launch('run.mjs',isolated,join(dir,'isolated-db'),otherPort);t.after(()=>independent.kill('SIGTERM'));
 const target=`http://127.0.0.1:${otherPort}`;
 r=await req(target,'/api/session');assert.equal(r.status,200);assert.equal(r.body.initialized,false,'no user secrets exported');
 r=await req(target,'/api/setup','POST',{name:'Independent',email:'independent@r10.test',password:pass});assert.equal(r.status,201);const fresh={cookie:r.cookie,csrf:r.body.csrf};
 r=await req(target,'/api/entities');assert.equal(r.status,401);
 r=await req(target,'/api/entities','GET',undefined,fresh);assert.equal(r.status,200);assert.equal(r.body.entities.length,3);
 r=await req(target,'/api/entities/patients/rows','GET',undefined,fresh);assert.equal(r.status,200);assert.equal(r.body.total,0,'real patient data were excluded');
 r=await req(target,'/api/automations','GET',undefined,fresh);assert.equal(r.status,200);assert.equal(r.body.automations.length,0,'operational runtime rules were not copied into template');
});
