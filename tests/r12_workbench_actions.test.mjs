import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizePage,PAGE_SCHEMA_VERSION} from '../src/common/pages.mjs';
import {projectDiagnostics} from '../src/studio/diagnostics.mjs';
import {normalizeProject} from '../src/studio/routes.mjs';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const pass='R12_Ultra_Secure_2026!';
const id=()=>randomUUID();
const button=(action,more={})=>({id:id(),type:'button',label:'Действие',action,style:'primary',...more});
const page=(blocks,slug='custom-page')=>({title:'Тестовая страница',slug,description:'',published:true,blocks});
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n;}
async function launch(dir,p){
 const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(p),HOST:'127.0.0.1',DATA_DIR:dir,NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
 let output='';child.stderr.on('data',x=>output+=x);child.stdout.on('data',x=>output+=x);
 for(let i=0;i<100;i++){
  if(child.exitCode!==null)throw Error('server ended: '+output);
  try{if((await fetch('http://127.0.0.1:'+p+'/api/health')).ok)return child;}catch{}
  await new Promise(r=>setTimeout(r,70));
 }
 child.kill();throw Error('could not launch: '+output);
}
async function req(origin,path,{method='GET',body,cookie,csrf}={}){
 const headers={};if(cookie)headers.cookie=cookie;if(csrf)headers['x-csrf-token']=csrf;
 if(body!==undefined)headers['content-type']='application/json';
 const response=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 const value=await response.json().catch(()=>null);
 return {status:response.status,value,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}
const setup={name:'Мастерская 12',email:'r12-owner@test.example',password:pass};
const config={name:'Ресторан с действиями',type:'crm',industry:'restaurant',modules:['auth','clients','tasks','analytics'],settings:{accent:'#c9a473',primaryAction:'new_client',currency:'RUB'}};

test('R1.2 declarative button validation: page navigation, visibility, confirmation and notice',()=>{
 const p=normalizePage(page([button('navigate:page:private-room',{confirm:true,confirmText:'Открыть экран?',roles:['manager','admin']})]),config.modules);
 assert.equal(PAGE_SCHEMA_VERSION,4);
 assert.equal(p.blocks[0].confirm,true);assert.deepEqual(p.blocks[0].roles,['manager','admin']);
 assert.equal(p.blocks[0].action,'navigate:page:private-room');
 const notice=normalizePage(page([button('notice',{message:'Готово <script>alert(1)</script>'})]),config.modules);
 assert.match(notice.blocks[0].message,/<script>/,'Text remains data, must be escaped at render');
 assert.throws(()=>normalizePage(page([button('notice',{message:''})]),config.modules),x=>x.status===400);
 assert.throws(()=>normalizePage(page([button('navigate:page:../secret')]),config.modules),x=>x.status===400);
 assert.throws(()=>normalizePage(page([button('fetch:https://evil.test')]),config.modules),x=>x.status===400);
 assert.throws(()=>normalizePage(page([button('navigate:clients',{roles:['root']})]),config.modules),x=>x.status===400);
 assert.throws(()=>normalizePage(page([button('navigate:clients',{roles:[]})]),config.modules),x=>x.status===400);
 assert.throws(()=>normalizePage(page([button('navigate:clients',{confirm:'true'})]),config.modules),x=>x.status===400);
});

test('R1.2 owner workbench, broken links block export, publication repairs it, independently exported config retains actions', {timeout:120000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'osmanx-r12-'));const p=await port();const origin=`http://127.0.0.1:${p}`;
 const server=await launch(join(dir,'studio'),p);t.after(()=>server.kill('SIGTERM'));
 let response=await req(origin,'/api/studio/setup',{method:'POST',body:setup});assert.equal(response.status,201,JSON.stringify(response.value));
 const owner={cookie:response.cookie,csrf:response.value.csrf};
 response=await req(origin,'/api/studio/projects',{method:'POST',cookie:owner.cookie,csrf:owner.csrf,body:config});assert.equal(response.status,201,JSON.stringify(response.value));
 const projectId=response.value.project.id,rootPath=`/api/studio/projects/${projectId}`;
 // Rules shown in the unified workbench must be editable from the real Studio API.
 response=await req(origin,rootPath+'/workflows',{method:'POST',cookie:owner.cookie,csrf:owner.csrf,body:{name:'Задача для нового гостя',event:'client_created',task_title:'Связаться с гостем',priority:'medium',due_days:1,enabled:true}});
 assert.equal(response.status,201,JSON.stringify(response.value));
 const originalRule=response.value.workflow;
 response=await req(origin,rootPath+'/workflows/'+originalRule.id,{method:'PATCH',cookie:owner.cookie,csrf:owner.csrf,body:{...originalRule,enabled:false}});
 assert.equal(response.status,200,JSON.stringify(response.value));
 assert.equal(response.value.workflow.enabled,false);
 response=await req(origin,rootPath+'/workbench',{cookie:owner.cookie});
 assert.equal(response.status,200);assert.equal(response.value.project.automationPresets.find(x=>x.id===originalRule.id).enabled,false);
 const demo=await fetch(origin+'/assets/studio/workbench.js');assert.equal(demo.status,200);assert.match(await demo.text(),/initProjectWorkbench/);
 response=await req(origin,rootPath+'/workbench');assert.equal(response.status,401,'Workspaces must require owner session');
 response=await req(origin,rootPath+'/workbench',{cookie:owner.cookie});assert.equal(response.status,200);assert.equal(response.value.project.id,projectId);
 assert.equal(response.value.diagnostics.summary.exportReady,true);
 assert.ok(Array.isArray(response.value.releases));
 let first=response.value.project.pages[0];
 const newButton=button('navigate:page:members',{label:'Перейти к сотрудникам',roles:['admin','manager'],confirm:true,confirmText:'Открыть список команды?'});
 response=await req(origin,rootPath+'/pages/'+first.id,{method:'PATCH',cookie:owner.cookie,csrf:owner.csrf,body:{...first,blocks:[...first.blocks,newButton]}});
 assert.equal(response.status,200,JSON.stringify(response.value));first=response.value.page;
 response=await req(origin,rootPath+'/workbench',{cookie:owner.cookie});assert.equal(response.value.diagnostics.summary.exportReady,false);
 assert.ok(response.value.diagnostics.checks.some(x=>x.key==='page-links'&&x.level==='error'));
 let raw=await fetch(origin+rootPath+'/export',{headers:{cookie:owner.cookie}});assert.equal(raw.status,409,'Broken page link cannot reach client ZIP');
 response=await req(origin,rootPath+'/pages',{method:'POST',cookie:owner.cookie,csrf:owner.csrf,body:page([{id:id(),type:'hero',eyebrow:'',title:'Команда',subtitle:''}],'members')});
 assert.equal(response.status,201,JSON.stringify(response.value));const target=response.value.page;
 response=await req(origin,rootPath+'/workbench',{cookie:owner.cookie});assert.equal(response.value.diagnostics.summary.exportReady,true);
 response=await req(origin,rootPath+'/pages/'+target.id,{method:'PATCH',cookie:owner.cookie,csrf:owner.csrf,body:{...target,published:false}});
 assert.equal(response.status,200);
 response=await req(origin,rootPath+'/workbench',{cookie:owner.cookie});assert.equal(response.value.diagnostics.summary.exportReady,false,'Unpublished destination is broken');
 const unpublished=response.value.project.pages.find(pg=>pg.id===target.id);
 response=await req(origin,rootPath+'/pages/'+target.id,{method:'PATCH',cookie:owner.cookie,csrf:owner.csrf,body:{...unpublished,published:true}});
 assert.equal(response.status,200);
 const notice=button('notice',{label:'Сохранено',message:'Готово!',roles:['staff']});
 response=await req(origin,rootPath+'/pages/'+first.id,{method:'PATCH',cookie:owner.cookie,csrf:owner.csrf,body:{...first,blocks:[...first.blocks,notice]}});
 assert.equal(response.status,200,JSON.stringify(response.value));
 const invalid=button('javascript:alert(1)');
 response=await req(origin,rootPath+'/pages/'+first.id,{method:'PATCH',cookie:owner.cookie,csrf:owner.csrf,body:{...response.value.page,blocks:[invalid]}});
 assert.equal(response.status,400,'Executable actions are forbidden');
 raw=await fetch(origin+rootPath+'/export',{headers:{cookie:owner.cookie}});assert.equal(raw.status,200,'Published link allows a complete export');
 const dest=join(dir,'standalone');await mkdir(dest,{recursive:true});const zip=join(dir,'complete.zip');await writeFile(zip,Buffer.from(await raw.arrayBuffer()));
 execFileSync('unzip',['-q',zip,'-d',dest]);
 const exported=JSON.parse(await readFile(join(dest,'config/project.json'),'utf8'));
 const exportedButton=exported.pages.flatMap(pg=>pg.blocks).find(b=>b.id===newButton.id);
 assert.equal(exportedButton.action,'navigate:page:members');assert.deepEqual(exportedButton.roles,['admin','manager']);assert.equal(exportedButton.confirm,true);
 assert.ok(exported.pages.flatMap(pg=>pg.blocks).some(b=>b.action==='notice'&&b.roles[0]==='staff'));
 assert.ok(!JSON.stringify(exported).includes(pass),'Export cannot contain passwords');
 assert.ok(!JSON.stringify(exported).includes('session_id'),'Export cannot contain user session data');
});
