import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createServer } from 'node:net';
import { normalizeEntity } from '../src/common/entities.mjs';
import { normalizePage } from '../src/common/pages.mjs';
import { randomUUID } from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const pass='StrongPass_2026_MVP';
const supplier={slug:'suppliers',title:'Поставщики',description:'Контрагенты ресторана',access:{read:['admin','manager','staff'],write:['admin','manager']},fields:[
  {key:'company',label:'Компания',type:'text',required:true},
  {key:'phone',label:'Телефон',type:'text',required:false},
  {key:'active',label:'Работает',type:'boolean',required:true}
]};
const order={slug:'orders',title:'Заказы',description:'Закупки ресторана',access:{read:['admin','manager','staff'],write:['admin','manager']},fields:[
  {key:'title',label:'Номер заказа',type:'text',required:true},
  {key:'supplier',label:'Поставщик',type:'reference',target:'suppliers',required:true},
  {key:'state',label:'Статус',type:'select',options:['новый','закрыт'],required:true},
  {key:'quantity',label:'Количество',type:'integer',required:false},
  {key:'ordered_on',label:'Дата',type:'date',required:false}
]};
function error400(fn,status=400){assert.throws(fn,e=>e.status===status);}

test('schema compiler: immutable identifiers, strict types, safe references and optional additive fields',()=>{
 const a=normalizeEntity(supplier);
 assert.equal(a.fields.length,3);
 error400(()=>normalizeEntity({...supplier,slug:'evil; DROP TABLE users;'}));
 error400(()=>normalizeEntity({...supplier,fields:[...supplier.fields,{key:'id',label:'ID',type:'text',required:false}]}));
 error400(()=>normalizeEntity({...supplier,fields:[...supplier.fields,{key:'company',label:'Copy',type:'text',required:false}]}));
 error400(()=>normalizeEntity(order,null,[]));
 assert.equal(normalizeEntity(order,null,[supplier]).fields[1].target,'suppliers');
 error400(()=>normalizeEntity({...supplier,fields:[{...supplier.fields[0],type:'integer'},...supplier.fields.slice(1)]},supplier,[supplier]),409);
 error400(()=>normalizeEntity({...supplier,fields:supplier.fields.slice(0,2)},supplier,[supplier]),409);
 error400(()=>normalizeEntity({...supplier,fields:[...supplier.fields,{key:'new_required',label:'Новый',type:'text',required:true}]},supplier,[supplier]),409);
 assert.equal(normalizeEntity({...supplier,fields:[...supplier.fields,{key:'extra_note',label:'Заметка',type:'longtext',required:false}]},supplier,[supplier]).fields.length,4);
 const fields=[{key:'title',label:'Заказ',type:'text',required:true},{key:'supplier',label:'Поставщик',type:'reference',target:'suppliers',required:true}];
 const entities=[supplier,{...order,fields}];
 const page={title:'Закупки',slug:'purchases',published:true,description:'',blocks:[
  {id:randomUUID(),type:'form',title:'Новый заказ',entity:'custom:orders',fields:['title','supplier'],submitLabel:'Сохранить'},
  {id:randomUUID(),type:'table',title:'Заказы',entity:'custom:orders',columns:['title','supplier']},
  {id:randomUUID(),type:'button',label:'Создать заказ',style:'primary',action:'create:custom:orders'}
 ]};
 assert.equal(normalizePage(page,['auth'],entities).blocks.length,3);
 const missing={...page,blocks:[{...page.blocks[0],fields:['title']}]};
 error400(()=>normalizePage(missing,['auth'],entities));
 error400(()=>normalizePage({...page,blocks:[{...page.blocks[2],action:'create:custom:missing'}]},['auth'],entities));
});

async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function launch(script,cwd,data,port){
 const child=spawn(process.execPath,[script],{cwd,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:data,NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c);
 for(let i=0;i<80;i++){
  if(child.exitCode!==null)throw new Error('Exited '+logs);
  try{const r=await fetch('http://127.0.0.1:'+port+'/api/health');if(r.ok)return child;}catch{}
  await new Promise(r=>setTimeout(r,100));
 }
 child.kill();throw new Error('Not ready: '+logs);
}
async function request(base,path,method='GET',data,login={}){
 const headers={};if(data!==undefined)headers['content-type']='application/json';
 if(login.cookie)headers.cookie=login.cookie;if(login.csrf)headers['x-csrf-token']=login.csrf;
 if(login.extra)Object.assign(headers,login.extra);
 const r=await fetch(base+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});
 const b=await r.json().catch(()=>({}));return {status:r.status,body:b,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
async function unzip(buf,dest){let at=0;while(at+30<=buf.length&&buf.readUInt32LE(at)===0x04034b50){
 const size=buf.readUInt32LE(at+18),nl=buf.readUInt16LE(at+26),extra=buf.readUInt16LE(at+28),name=buf.subarray(at+30,at+30+nl).toString('utf8');
 assert.ok(!name.includes('..')&&!name.startsWith('/'));const file=join(dest,name);await mkdir(dirname(file),{recursive:true});await writeFile(file,buf.subarray(at+30+nl+extra,at+30+nl+extra+size));at+=30+nl+extra+size;
}}

test('HTTP factory -> entity schema -> typed CRUD + RBAC -> migration -> custom page -> independent ZIP', {timeout:120000}, async t=>{
 const tmp=await mkdtemp(join(tmpdir(),'osmanx-r03-')),p=await freePort(),origin=`http://127.0.0.1:${p}`;
 const child=await launch('server.mjs',root,join(tmp,'data'),p);t.after(()=>child.kill('SIGTERM'));
 let r=await request(origin,'/api/studio/setup','POST',{name:'Owner',email:'factory@demo.example',password:pass});
 assert.equal(r.status,201,JSON.stringify(r.body));const studio={cookie:r.cookie,csrf:r.body.csrf};
 r=await request(origin,'/api/studio/projects','POST',{name:'Universal Restaurant',type:'crm',industry:'restaurant',modules:['auth','clients','analytics','tasks','payments'],settings:{accent:'#91aaff',primaryAction:'new_client',currency:'RUB'}},studio);
 assert.equal(r.status,201,JSON.stringify(r.body));const project=r.body.project.id,base=`/workspace/${project}`;
 assert.deepEqual(r.body.project.entities,[]);
 const entityEndpoint=`/api/studio/projects/${project}/entities`;
 r=await request(origin,entityEndpoint,'POST',supplier);assert.equal(r.status,401,'requires studio session');
 r=await request(origin,entityEndpoint,'POST',{...supplier,slug:'a";drop table users;--'},studio);assert.equal(r.status,400);
 r=await request(origin,entityEndpoint,'POST',supplier,studio);assert.equal(r.status,201,JSON.stringify(r.body));let storedSupplier=r.body.entity;
 r=await request(origin,entityEndpoint,'POST',order,studio);assert.equal(r.status,201,JSON.stringify(r.body));const storedOrder=r.body.entity;
 r=await request(origin,entityEndpoint,'GET',undefined,studio);assert.equal(r.body.entities.length,2);
 r=await request(origin,base+'/api/setup','POST',{name:'Admin',email:'admin@demo.example',password:pass},{cookie:studio.cookie,extra:{'x-studio-csrf-token':studio.csrf}});
 assert.equal(r.status,201,JSON.stringify(r.body));const admin={cookie:r.cookie,csrf:r.body.csrf};
 r=await request(origin,base+'/api/entities','GET',undefined,admin);assert.equal(r.status,200);assert.equal(r.body.entities.length,2);
 r=await request(origin,base+'/api/entities/suppliers/rows','POST',{values:{company:'Foo',active:true}},admin);assert.equal(r.status,201,JSON.stringify(r.body));const sid=r.body.row.id;
 r=await request(origin,base+'/api/entities/orders/rows','POST',{values:{title:'ORD-1',supplier:'11111111-1111-1111-1111-111111111111',state:'новый'}},admin);assert.equal(r.status,400,'unknown reference');
 r=await request(origin,base+'/api/entities/orders/rows','POST',{values:{title:'ORD-1',supplier:sid,state:'новый',quantity:3,ordered_on:'2026-10-30'}},admin);
 assert.equal(r.status,201,JSON.stringify(r.body));const oid=r.body.row.id;
 assert.equal(r.body.row.quantity,3);
 r=await request(origin,base+'/api/entities/orders/rows','POST',{values:{title:'ORD-2',supplier:sid,state:'выкраден'}},admin);assert.equal(r.status,400,'select is allowlisted');
 r=await request(origin,base+'/api/entities/orders/rows','POST',{values:{title:'ORD-2',supplier:sid,state:'новый',raw_sql:'DROP'}},admin);assert.equal(r.status,400,'extra fields forbidden');
 r=await request(origin,base+'/api/entities/orders/rows','POST',{values:{title:'ORD-2',supplier:sid,state:'новый',quantity:3.5}},admin);assert.equal(r.status,400,'strict integers');
 r=await request(origin,base+'/api/entities/orders/rows','POST',{values:{title:'ORD-2',supplier:sid,state:'новый',ordered_on:'2026-02-30'}},admin);assert.equal(r.status,400,'strict calendar dates');
 r=await request(origin,base+'/api/entities/orders/rows','GET',undefined,admin);assert.equal(r.body.total,1);assert.equal(r.body.rows[0].title,'ORD-1');
 r=await request(origin,base+'/api/entities/orders/rows?q=ORD','GET',undefined,admin);assert.equal(r.body.total,1);
 r=await request(origin,base+'/api/entities/orders/rows/'+oid,'PATCH',{version:1,values:{state:'закрыт'}},admin);
 assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.row.version,2);
 r=await request(origin,base+'/api/entities/orders/rows/'+oid,'PATCH',{version:1,values:{state:'новый'}},admin);assert.equal(r.status,409,'stale versions rejected');
 // New fields are additive, existing record persists with NULL.
 r=await request(origin,entityEndpoint+'/'+storedOrder.id,'PATCH',{...storedOrder,fields:[...storedOrder.fields,{key:'comment',label:'Комментарий',type:'longtext',required:false}]},studio);
 assert.equal(r.status,200,JSON.stringify(r.body));const orderV2=r.body.entity;
 r=await request(origin,base+'/api/entities/orders/rows/'+oid,'GET',undefined,admin);assert.equal(r.status,200);assert.equal(r.body.row.state,'закрыт');assert.equal(r.body.row.comment,null);
 r=await request(origin,base+'/api/entities/orders/rows/'+oid,'PATCH',{version:2,values:{comment:'Срочно'}},admin);assert.equal(r.body.row.comment,'Срочно');
 r=await request(origin,entityEndpoint+'/'+storedOrder.id,'PATCH',{...storedOrder,fields:[...storedOrder.fields.slice(0,1),{...storedOrder.fields[1],type:'text'},...storedOrder.fields.slice(2)]},studio);assert.equal(r.status,409,'no destructive type change');
 r=await request(origin,entityEndpoint+'/'+storedOrder.id,'PATCH',{...orderV2,fields:orderV2.fields.slice(0,-1)},studio);assert.equal(r.status,409,'no field drop');
 // Staff may see but cannot write when default schema says read-only.
 r=await request(origin,base+'/api/users','POST',{name:'Employee',email:'staff@demo.example',password:pass,role:'staff'},admin);assert.equal(r.status,201);
 r=await request(origin,base+'/api/login','POST',{email:'staff@demo.example',password:pass});const staff={cookie:r.cookie,csrf:r.body.csrf};
 r=await request(origin,base+'/api/entities/orders/rows','GET',undefined,staff);assert.equal(r.status,200);
 r=await request(origin,base+'/api/entities/orders/rows','POST',{values:{title:'STAFF',supplier:sid,state:'новый'}},staff);assert.equal(r.status,403);
 r=await request(origin,base+'/api/entities/orders/rows','POST',{values:{title:'NO CSRF',supplier:sid,state:'новый'}},{cookie:admin.cookie});assert.equal(r.status,403);
 // Generated pages may safely bind to the new entity.
 const page={title:'Закупки ресторана',slug:'purchases',description:'Связанные заказы',published:true,blocks:[
  {id:randomUUID(),type:'hero',eyebrow:'RESTAURANT',title:'Все заказы',subtitle:'Управление закупками'},
  {id:randomUUID(),type:'form',title:'Новый заказ',entity:'custom:orders',fields:['title','supplier','state'],submitLabel:'Сохранить'},
  {id:randomUUID(),type:'table',title:'Список заказов',entity:'custom:orders',columns:['title','state','supplier']},
  {id:randomUUID(),type:'button',label:'Добавить заказ',action:'create:custom:orders',style:'primary'}
 ]};
 r=await request(origin,`/api/studio/projects/${project}/pages`,'POST',page,studio);assert.equal(r.status,201,JSON.stringify(r.body));
 r=await request(origin,base+'/api/pages','GET',undefined,admin);assert.equal(r.status,200);assert.ok(r.body.pages.some(p=>p.slug==='purchases'));
 const zipResponse=await fetch(origin+`/api/studio/projects/${project}/export`,{headers:{cookie:studio.cookie}});
 assert.equal(zipResponse.status,200);const zip=Buffer.from(await zipResponse.arrayBuffer());
 const extracted=join(tmp,'independent');await unzip(zip,extracted);
 const config=JSON.parse(await readFile(join(extracted,'config/project.json'),'utf8'));
 assert.equal(config.entities.length,2);assert.equal(config.pages.length,2);
 const otherPort=await freePort(),otherBase=`http://127.0.0.1:${otherPort}`;
 const second=await launch('run.mjs',extracted,join(tmp,'independent-data'),otherPort);t.after(()=>second.kill('SIGTERM'));
 r=await request(otherBase,'/api/setup','POST',{name:'Independent',email:'independent@demo.example',password:pass});assert.equal(r.status,201,JSON.stringify(r.body));const exported={cookie:r.cookie,csrf:r.body.csrf};
 r=await request(otherBase,'/api/entities/orders/rows','GET',undefined,exported);assert.equal(r.status,200);assert.equal(r.body.total,0,'data never exported');
 r=await request(otherBase,'/api/entities/suppliers/rows','POST',{values:{company:'Independent Supplier',active:false}},exported);assert.equal(r.status,201);const sid2=r.body.row.id;
 r=await request(otherBase,'/api/entities/orders/rows','POST',{values:{title:'Separate',supplier:sid2,state:'новый',comment:'Independent data'}},exported);assert.equal(r.status,201,JSON.stringify(r.body));
 r=await request(otherBase,'/api/pages','GET',undefined,exported);assert.ok(r.body.pages.some(p=>p.slug==='purchases'));
 // Factory tenant data must remain untouched by exported CRM.
 r=await request(origin,base+'/api/entities/orders/rows','GET',undefined,admin);assert.equal(r.body.total,1);
 r=await request(origin,base+'/api/entities/orders/rows/'+oid,'DELETE',{version:3},admin);assert.equal(r.status,200);
 r=await request(origin,base+'/api/entities/orders/rows','GET',undefined,admin);assert.equal(r.body.total,0);
});
