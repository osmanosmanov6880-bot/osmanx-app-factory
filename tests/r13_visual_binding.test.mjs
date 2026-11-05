import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePage,PAGE_SCHEMA_VERSION } from '../src/common/pages.mjs';
import { normalizeSitePage,renderWebsite } from '../src/site/model.mjs';
import { createIndustryPack } from '../src/studio/industries.mjs';
const root=join(import.meta.dirname,'..');
const pass='R13_Strong_Demo_Pass_2604!';
const page=blocks=>({title:'Визуальный экран',slug:'visual-screen',description:'Обновлённая сетка',published:true,blocks});
const block=(type,config)=>({id:randomUUID(),type,...config});
const modules=['auth','clients','tasks','analytics','payments'];
const entities=createIndustryPack('dental',modules).entities;
const reject=fn=>assert.throws(fn,e=>e.status===400);

test('R1.3 CRM contract: grid, custom entity counter, row limits and form success text are normalized',()=>{
 const p=normalizePage(page([
  block('hero',{title:'Широкий заголовок',eyebrow:'',subtitle:'',layout:'wide'}),
  block('metric',{metric:'entity_count',entity:'custom:patients',label:'Пациентов',layout:'third'}),
  block('table',{title:'Список пациентов',entity:'custom:patients',columns:['full_name','phone'],limit:5,layout:'half'}),
  block('form',{title:'Анкета',entity:'clients',fields:['full_name','phone'],submitLabel:'Сохранить',successText:'Гость добавлен в CRM',layout:'half'})
 ]),modules,entities);
 assert.equal(PAGE_SCHEMA_VERSION,4);
 assert.deepEqual(p.blocks.map(b=>b.layout),['wide','third','half','half']);
 assert.equal(p.blocks[1].entity,'custom:patients');
 assert.equal(p.blocks[2].limit,5);
 assert.equal(p.blocks[3].successText,'Гость добавлен в CRM');
 const old=normalizePage(page([block('metric',{metric:'clients_total',label:'Гости'})]),modules,entities);
 assert.equal(old.blocks[0].layout,'half','Old pages without layout preserve equivalent two-column metrics');
 reject(()=>normalizePage(page([block('metric',{metric:'entity_count',entity:'custom:unknown',label:'X'})]),modules,entities));
 reject(()=>normalizePage(page([block('table',{title:'A',entity:'custom:patients',columns:['full_name'],limit:500})]),modules,entities));
 reject(()=>normalizePage(page([block('hero',{title:'A',eyebrow:'',subtitle:'',layout:'third'})]),modules,entities));
 reject(()=>normalizePage(page([block('text',{title:'B',body:'C',layout:'xxl'})]),modules,entities));
 reject(()=>normalizePage(page([block('divider',{layout:'half'})]),modules,entities));
 reject(()=>normalizePage(page([block('metric',{metric:'entity_count',entity:'custom:patients',label:'X'})]),modules,[]));
});

test('R1.3 website: layout is validated, escaped, rendered, mobile CSS is included',()=>{
 const p=normalizeSitePage(page([
  block('hero',{eyebrow:'Услуги',title:'Тестовая компания',subtitle:'',layout:'wide'}),
  block('text',{title:'Секция <b>1</b>',body:'Безопасный текст',layout:'half'}),
  block('text',{title:'Секция 2',body:'Половина страницы',layout:'half'}),
  block('features',{title:'Преимущества',items:[{title:'Скорость',body:'Рядом'}],layout:'third'})
 ]),['auth','cms','leads']);
 assert.equal(p.schemaVersion,2);
 const html=renderWebsite(p,[p],{name:'ATELIER',settings:{accent:'#cdb08a',tagline:''}});
 assert.match(html,/class="site-layout"/);
 assert.match(html,/site-span-half/);
 assert.match(html,/site-span-third/);
 assert.match(html,/&lt;b&gt;1&lt;\/b&gt;/);
 reject(()=>normalizeSitePage(page([block('hero',{eyebrow:'',title:'X',subtitle:'',layout:'third'})])));
 reject(()=>normalizeSitePage(page([block('button',{label:'Danger',href:'javascript:alert(1)',layout:'half'})])));
});

async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function launch(script,cwd,dir,p){
 const child=spawn(process.execPath,[script],{cwd,env:{...process.env,PORT:String(p),HOST:'127.0.0.1',DATA_DIR:dir,NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
 let log='';child.stderr.on('data',d=>log+=d);child.stdout.on('data',d=>log+=d);
 for(let i=0;i<100;i++){
  if(child.exitCode!==null)throw Error('Server exited: '+log);
  try{if((await fetch(`http://127.0.0.1:${p}/api/health`)).ok)return child;}catch{}
  await new Promise(r=>setTimeout(r,60));
 }
 child.kill();throw Error('Server failed: '+log);
}
async function req(origin,path,method='GET',data,auth={}){
 const headers={};if(data!==undefined)headers['content-type']='application/json';if(auth.cookie)headers.cookie=auth.cookie;if(auth.csrf)headers['x-csrf-token']=auth.csrf;
 const response=await fetch(origin+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
 const value=await response.json().catch(()=>null);return {status:response.status,value,cookie:response.headers.get('set-cookie')?.split(';')[0]};
}

test('R1.3 factory HTTP -> SQLite page -> independent ZIP -> custom entity counter API', {timeout:120000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ox-r13-'));
 const p=await port(),factory=await launch('server.mjs',root,join(dir,'factory-db'),p);t.after(()=>factory.kill());
 const origin=`http://127.0.0.1:${p}`;
 let r=await req(origin,'/api/studio/setup','POST',{name:'Owner',email:'r13owner@example.test',password:pass});assert.equal(r.status,201,JSON.stringify(r.value));
 const auth={cookie:r.cookie,csrf:r.value.csrf};
 r=await req(origin,'/api/studio/projects','POST',{name:'OSMANX Dental R1.3',type:'crm',industry:'dental',modules,settings:{accent:'#d9b58b',primaryAction:'new_client',currency:'RUB'}},auth);
 assert.equal(r.status,201,JSON.stringify(r.value));
 const project=r.value.project,patients=project.entities.find(e=>e.slug==='patients'),first=project.pages[0];
 const blocks=[...first.blocks,
  block('metric',{metric:'entity_count',entity:'custom:patients',label:'Все пациенты',layout:'third'}),
  block('table',{title:'Последние записи',entity:'custom:patients',columns:['full_name','phone'],limit:5,layout:'half'})
 ];
 r=await req(origin,`/api/studio/projects/${project.id}/pages/${first.id}`,'PATCH',{...first,blocks},auth);
 assert.equal(r.status,200,JSON.stringify(r.value));
 assert.equal(r.value.page.blocks.at(-2).layout,'third');
 const invalid={...r.value.page,blocks:blocks.map(x=>x.type==='metric'&&x.metric==='entity_count'?{...x,entity:'custom:nonexistent'}:x)};
 r=await req(origin,`/api/studio/projects/${project.id}/pages/${first.id}`,'PATCH',invalid,auth);
 assert.equal(r.status,400,'Must reject unknown entity binding');
 const response=await fetch(origin+`/api/studio/projects/${project.id}/export`,{headers:{cookie:auth.cookie}});
 assert.equal(response.status,200,'Valid layout must export');
 const dest=join(dir,'independent');await mkdir(dest,{recursive:true});const zip=join(dir,'build.zip');await writeFile(zip,Buffer.from(await response.arrayBuffer()));
 execFileSync('unzip',['-q',zip,'-d',dest]);
 const config=JSON.parse(await readFile(join(dest,'config/project.json'),'utf8'));
 const blocks2=config.pages[0].blocks;
 assert.ok(blocks2.some(b=>b.metric==='entity_count'&&b.layout==='third'));
 assert.ok(blocks2.some(b=>b.type==='table'&&b.limit===5&&b.layout==='half'));
 assert.match(await readFile(join(dest,'public/crm/pages.js'),'utf8'),/data-entity-count/);
 assert.match(await readFile(join(dest,'public/crm/app.css'),'utf8'),/page-layout-third/);
 const p2=await port(),independent=await launch('run.mjs',dest,join(dir,'client-data'),p2);t.after(()=>independent.kill());
 const other=`http://127.0.0.1:${p2}`;
 r=await req(other,'/api/session');assert.equal(r.value.initialized,false);
 r=await req(other,'/api/setup','POST',{name:'Admin',email:'admin@example.test',password:pass});assert.equal(r.status,201,JSON.stringify(r.value));
 const staff={cookie:r.cookie,csrf:r.value.csrf};
 r=await req(other,'/api/entities/patients/rows','GET',undefined,staff);assert.equal(r.status,200);assert.equal(r.value.total,0);
 r=await req(other,'/api/entities/patients/rows','POST',{values:{full_name:'Гость проверки',phone:'+70000000001',consent:true}},staff);assert.equal(r.status,201,JSON.stringify(r.value));
 r=await req(other,'/api/entities/patients/rows?limit=1','GET',undefined,staff);assert.equal(r.status,200);assert.equal(r.value.total,1);
 r=await req(other,'/api/pages','GET',undefined,staff);assert.equal(r.status,200);assert.ok(r.value.pages.some(page=>page.blocks.some(b=>b.metric==='entity_count')));
});
