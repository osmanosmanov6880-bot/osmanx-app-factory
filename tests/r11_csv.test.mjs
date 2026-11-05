import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {parseClientCsv,clientsToCsv} from '../src/crm/client_csv.mjs';
const root=new URL('../',import.meta.url).pathname;
const pwd='Great_Test_Password_R11_2026!';
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function start(p,data){
 const proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(p),HOST:'127.0.0.1',DATA_DIR:data,NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
 let log='';proc.stderr.on('data',x=>log+=x);proc.stdout.on('data',x=>log+=x);
 for(let i=0;i<100;i++){if(proc.exitCode!==null)throw Error(log);try{if((await fetch(`http://127.0.0.1:${p}/api/health`)).ok)return proc}catch{}await new Promise(r=>setTimeout(r,65))}proc.kill();throw Error(log);
}
async function req(base,path,method='GET',data,auth={}){
 const headers={};if(data!==undefined)headers['content-type']='application/json';if(auth.cookie)headers.cookie=auth.cookie;if(auth.csrf)headers['x-csrf-token']=auth.csrf;if(auth.extra)Object.assign(headers,auth.extra);
 const r=await fetch(base+path,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,body:await r.json().catch(()=>null),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
test('R1.1 CSV validates quoting, semicolon delimiters, UTF8 and formula injection',()=>{
 const cases='\ufefffull_name;phone;email;source;notes\r\n"Оля, Врач";"+79991110000";"test@example.com";walkin;"Строка 1\nСтрока 2"\r\n';
 const rows=parseClientCsv(cases);assert.equal(rows.length,1);assert.equal(rows[0].full_name,'Оля, Врач');assert.equal(rows[0].notes,'Строка 1\nСтрока 2');
 const excel=clientsToCsv([{full_name:'=1+2',phone:'+79991110000',email:'x@example.com',source:'walkin',notes:'-5+5'}]);
 assert.ok(excel.includes('"\'=1+2"'));assert.ok(excel.includes('"\'+79991110000"'));assert.equal(parseClientCsv(excel)[0].phone,'+79991110000');
 assert.throws(()=>parseClientCsv('full_name,phone,email,source,notes\n"bad,1111,x@a.com,walkin,note'));
 assert.throws(()=>parseClientCsv('full_name,phone,email,source\na,b,c,d'));
});

test('R1.1 CSV onboarding: preview, dedupe, commit, zero auto triggers, export, roles', {timeout:120000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'osmanx-r11-csv-')),p=await port(),origin=`http://127.0.0.1:${p}`;
 const server=await start(p,dir);t.after(()=>server.kill('SIGTERM'));
 let r=await req(origin,'/api/studio/setup','POST',{name:'Owner',email:'owner@csv.test',password:pwd});assert.equal(r.status,201);const owner={cookie:r.cookie,csrf:r.body.csrf};
 r=await req(origin,'/api/studio/projects','POST',{type:'crm',industry:'restaurant',name:'Coffee House',modules:['auth','clients','tasks','analytics','payments'],settings:{accent:'#c9a473',currency:'RUB',primaryAction:'new_client'}},owner);
 assert.equal(r.status,201);const base=`/workspace/${r.body.project.id}`;
 r=await req(origin,base+'/api/setup','POST',{name:'Admin',email:'admin@csv.test',password:pwd},{cookie:owner.cookie,extra:{'x-studio-csrf-token':owner.csrf}});assert.equal(r.status,201);const admin={cookie:r.cookie,csrf:r.body.csrf};
 r=await req(origin,base+'/api/automations','POST',{name:'Позвонить',event:'client_created',task_title:'Перезвонить',priority:'high'},admin);assert.equal(r.status,201);
 const csv='full_name,phone,email,source,notes\n"=VIP клиент","+79000000001","client@csv.test",walkin,"Тест, первый"\n"Повтор","+79000000001","other@csv.test",walkin,"Повтор телефона"\n"Вторая запись",,"second@csv.test",website,"Обращение"\n';
 r=await req(origin,base+'/api/clients/import-preview','POST',{csv},admin);assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body.summary,{total:3,ready:2,duplicates:1,invalid:0});
 r=await req(origin,base+'/api/clients','GET',undefined,admin);assert.equal(r.body.clients.length,0,'preview is read-only');
 r=await req(origin,base+'/api/clients/import','POST',{csv,confirm:true},admin);assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.created,2);
 r=await req(origin,base+'/api/clients/import','POST',{csv,confirm:true},admin);assert.equal(r.status,201);assert.equal(r.body.created,0);assert.equal(r.body.duplicates,3);
 r=await req(origin,base+'/api/tasks','GET',undefined,admin);assert.equal(r.body.tasks.length,0,'bulk CSV import must not run client_created rules');
 const original=await fetch(origin+base+'/api/clients/export',{headers:{cookie:admin.cookie}});assert.equal(original.status,200);assert.equal(original.headers.get('content-type'),'text/csv; charset=utf-8');const csvExport=await original.text();assert.ok(csvExport.includes('"\'=VIP клиент"'));
 assert.equal(parseClientCsv(csvExport).length,2);
 const invalid=csv.replace('walkin,"Повтор телефона"','INVALID,"Повтор телефона"');
 r=await req(origin,base+'/api/clients/import-preview','POST',{csv:invalid},admin);assert.equal(r.status,200);assert.equal(r.body.summary.invalid,1);
 r=await req(origin,base+'/api/clients/import','POST',{csv:invalid,confirm:true},admin);assert.equal(r.status,400);
 r=await req(origin,base+'/api/clients','GET',undefined,admin);assert.equal(r.body.clients.length,2);
 // Staff can view clients, never import/export full customer lists.
 r=await req(origin,base+'/api/users','POST',{name:'Worker',email:'worker@csv.test',password:pwd,role:'staff'},admin);assert.equal(r.status,201,JSON.stringify(r.body));
 r=await req(origin,base+'/api/login','POST',{email:'worker@csv.test',password:pwd});assert.equal(r.status,200);const staff={cookie:r.cookie,csrf:r.body.csrf};
 r=await req(origin,base+'/api/clients/import-preview','POST',{csv},staff);assert.equal(r.status,403);
 const forbidden=await fetch(origin+base+'/api/clients/export',{headers:{cookie:staff.cookie}});assert.equal(forbidden.status,403);
});
