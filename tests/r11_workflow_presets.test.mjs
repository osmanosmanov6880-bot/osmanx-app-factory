import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {crmDb} from '../src/crm/db.mjs';
import {normalizeAutomationPreset,simulatePreset} from '../src/crm/automations.mjs';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const pass='GoodAndLong2026_Passcode!';
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
async function launch(entry,cwd,data,p){
 const c=spawn(process.execPath,[entry],{cwd,env:{...process.env,PORT:String(p),HOST:'127.0.0.1',DATA_DIR:data,NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
 let output='';c.stdout.on('data',b=>output+=b);c.stderr.on('data',b=>output+=b);
 for(let i=0;i<100;i++){
  if(c.exitCode!==null)throw Error('Server quit: '+output);
  try{if((await fetch(`http://127.0.0.1:${p}/api/health`)).ok)return c}catch{}
  await new Promise(r=>setTimeout(r,75));
 }
 c.kill();throw Error('Server failed: '+output);
}
async function req(base,path,method='GET',data,auth={}){
 const headers={};if(data!==undefined)headers['content-type']='application/json';if(auth.cookie)headers.cookie=auth.cookie;if(auth.csrf)headers['x-csrf-token']=auth.csrf;if(auth.extra)Object.assign(headers,auth.extra);
 const r=await fetch(base+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
 const body=await r.json().catch(()=>({}));return {status:r.status,body,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
const options={type:'crm',industry:'dental',name:'Резервная стоматология',modules:['auth','clients','analytics','tasks','payments'],settings:{accent:'#c9a473',currency:'RUB',primaryAction:'new_client'}};
const preset={name:'Подтверждённая запись',event:'entity_created',entity_slug:'appointments',condition_field:'status',condition_value:'Подтверждена',task_title:'Подготовить для {{doctor}}',priority:'high',due_days:1,enabled:true};

test('R1.1 pure scenario validation and preview never mutate data',()=>{
 const entities=[{slug:'appointments',fields:[{key:'status',type:'select',options:['Подтверждена','Новая']},{key:'doctor',type:'text'}]}];
 const rule=normalizeAutomationPreset(preset,entities,['auth','tasks']);
 assert.equal(simulatePreset(rule,{event:'entity_created',entitySlug:'appointments',recordValues:{status:'Подтверждена',doctor:'Иван'}}).taskTitle,'Подготовить для Иван');
 assert.equal(simulatePreset(rule,{event:'entity_created',entitySlug:'appointments',recordValues:{status:'Новая'}}).wouldRun,false);
 assert.equal(simulatePreset({...rule,enabled:false},{event:'entity_created',entitySlug:'appointments',recordValues:{status:'Подтверждена'}}).wouldRun,false);
 assert.throws(()=>normalizeAutomationPreset({...preset,entity_slug:'unknown'},entities,['auth','tasks']));
 assert.throws(()=>normalizeAutomationPreset(preset,entities,['auth','clients']));
});

test('R1.1 complete project rules -> previews -> template -> copy -> release -> standalone -> no re-seeding old databases', {timeout:120000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'osmanx-r11-'));const p=await port();const base=`http://127.0.0.1:${p}`;
 const server=await launch('server.mjs',root,join(dir,'studio'),p);t.after(()=>server.kill('SIGTERM'));
 let r=await req(base,'/api/studio/setup','POST',{name:'Владелец',email:'owner@r11.test',password:pass});assert.equal(r.status,201,JSON.stringify(r.body));const owner={cookie:r.cookie,csrf:r.body.csrf};
 r=await req(base,'/api/studio/projects','POST',options,owner);assert.equal(r.status,201,JSON.stringify(r.body));const project=r.body.project;
 r=await req(base,`/api/studio/projects/${project.id}/workflows`,'POST',preset);assert.equal(r.status,401,'unauthed write forbidden');
 r=await req(base,`/api/studio/projects/${project.id}/workflows`,'POST',preset,owner);assert.equal(r.status,201,JSON.stringify(r.body));const wf=r.body.workflow;assert.equal(wf.revision,1);
 // Invalid table, condition and disabled required task module.
 r=await req(base,`/api/studio/projects/${project.id}/workflows`,'POST',{...preset,condition_value:'Does not exist'},owner);assert.equal(r.status,400);
 r=await req(base,`/api/studio/projects/${project.id}/workflow-preview`,'POST',{rule:preset,sample:{event:'entity_created',entitySlug:'appointments',recordValues:{status:'Подтверждена',doctor:'Доктор'}}},owner);
 assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.wouldRun,true);assert.equal(r.body.taskTitle,'Подготовить для Доктор');
 r=await req(base,`/api/studio/projects/${project.id}/workflow-preview`,'POST',{rule:preset,sample:{event:'entity_created',entitySlug:'appointments',recordValues:{status:'Отменена',doctor:'Доктор'}}},owner);
 assert.equal(r.body.wouldRun,false);
 r=await req(base,`/api/studio/projects/${project.id}/workflows/${wf.id}`,'PATCH',{...preset,priority:'medium',revision:999},owner);assert.equal(r.status,409);
 r=await req(base,`/api/studio/projects/${project.id}/workflows/${wf.id}`,'PATCH',{...preset,revision:wf.revision},owner);assert.equal(r.status,200);
 // Clone and reusable template have rules as configuration, never operational data.
 r=await req(base,`/api/studio/projects/${project.id}/clone`,'POST',{name:'Вторая клиника'},owner);assert.equal(r.status,201,JSON.stringify(r.body));const cloned=r.body.project;
 assert.equal(cloned.automationPresets.length,1);assert.notEqual(cloned.automationPresets[0].id,wf.id);
 r=await req(base,'/api/studio/templates','POST',{projectId:project.id,name:'Стоматология с правилами'},owner);assert.equal(r.status,201,JSON.stringify(r.body));const tid=r.body.template.id;
 r=await req(base,`/api/studio/templates/${tid}/download`,'GET',undefined,owner);assert.equal(r.status,200);const portable=r.body;
 assert.equal(portable.snapshot.automationPresets.length,1);assert.ok(!JSON.stringify(portable).includes('created_by'));
 r=await req(base,'/api/studio/templates/import','POST',portable,owner);assert.equal(r.status,201,JSON.stringify(r.body));
 r=await req(base,`/api/studio/templates/${tid}/projects`,'POST',{name:'Третья клиника'},owner);assert.equal(r.status,201);assert.equal(r.body.project.automationPresets.length,1);
 r=await req(base,`/api/studio/projects/${project.id}/releases`,'POST',{notes:'Внедрены сценарии'},owner);assert.equal(r.status,201,JSON.stringify(r.body));
 const rel=r.body.release;
 // Standalone should seed exactly one active rule on fresh DB and retain it on reboot.
 const dest=join(dir,'exported');await mkdir(dest,{recursive:true});
 const response=await fetch(base+`/api/studio/projects/${project.id}/releases/${rel.id}/export`,{headers:{cookie:owner.cookie}});assert.equal(response.status,200);
 await writeFile(join(dir,'archive.zip'),Buffer.from(await response.arrayBuffer()));execFileSync('unzip',['-q',join(dir,'archive.zip'),'-d',dest]);
 const cfg=JSON.parse(await readFile(join(dest,'config/project.json'),'utf8'));assert.equal(cfg.automationPresets.length,1);
 const standalonePort=await port();const dataDir=join(dir,'client-data');const standalone=await launch('run.mjs',dest,dataDir,standalonePort);t.after(()=>standalone.kill('SIGTERM'));
 const independent=`http://127.0.0.1:${standalonePort}`;
 r=await req(independent,'/api/setup','POST',{name:'Админ',email:'independent@r11.test',password:pass});assert.equal(r.status,201,JSON.stringify(r.body));const admin={cookie:r.cookie,csrf:r.body.csrf};
 r=await req(independent,'/api/automations','GET',undefined,admin);assert.equal(r.status,200);assert.equal(r.body.automations.length,1);assert.equal(r.body.automations[0].name,'Подтверждённая запись');
 const patient=await req(independent,'/api/entities/patients/rows','POST',{values:{full_name:'Тестовый пациент',phone:'01234',consent:true}},admin);assert.equal(patient.status,201,JSON.stringify(patient.body));
 const rows=()=>req(independent,'/api/entities/appointments/rows','POST',{values:{patient:patient.body.row.id,doctor:'Врач',date:'2026-11-08',status:'Подтверждена'}},admin);
 assert.equal((await rows()).status,201);
 r=await req(independent,'/api/tasks','GET',undefined,admin);assert.equal(r.status,200);assert.equal(r.body.tasks.length,1);assert.equal(r.body.tasks[0].title,'Подготовить для Врач');
 // The template itself contains no patient data or credentials.
 assert.ok(!JSON.stringify(cfg).includes('Тестовый пациент'));
 // Existing installations must not be overwritten when their config changes.
 const db=crmDb(join(dataDir,'crm.sqlite'),cfg.entities,[{...preset,name:'ANOTHER FROM UPDATE'}],cfg.modules);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM automations').get().n,1);db.close();
 r=await req(base,`/api/studio/projects/${project.id}/workflows/${wf.id}`,'DELETE',undefined,owner);assert.equal(r.status,200);
 r=await req(base,`/api/studio/projects/${project.id}/workflows`,'GET',undefined,owner);assert.equal(r.body.workflows.length,0);
});
