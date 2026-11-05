import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
const root=join(import.meta.dirname,'..');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function get(url,{method='GET',data,cookie,csrf,headers={}}={}){
 const h={...headers};if(data!==undefined)h['content-type']='application/json';if(cookie)h.cookie=cookie;if(csrf)h['x-csrf-token']=csrf;
 const r=await fetch(url,{method,headers:h,body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
test('R0.9 HTTP: create rule, fire on new customer, pause, and deny staff', {timeout:30000},async t=>{
 const p=await port(),origin=`http://127.0.0.1:${p}`,dir=await mkdtemp(join(tmpdir(),'osmanx-http-r09-'));
 const proc=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:String(p),DATA_DIR:dir,NODE_NO_WARNINGS:'1'},stdio:'ignore'});t.after(()=>proc.kill('SIGTERM'));
 let ready=false;for(let i=0;i<60;i++){try{if((await get(origin+'/api/health')).status===200){ready=true;break}}catch{}await delay(80)}assert.ok(ready);
 const pass='Secure_Test_Pass_12345';
 let r=await get(origin+'/api/studio/setup',{method:'POST',data:{email:'factory@example.test',name:'Factory',password:pass}});assert.equal(r.status,201);const ownCookie=r.cookie,ownCsrf=r.body.csrf;
 r=await get(origin+'/api/studio/projects',{method:'POST',cookie:ownCookie,csrf:ownCsrf,data:{name:'CRM TEST',type:'crm',industry:'restaurant',modules:['auth','clients','tasks','analytics'],settings:{accent:'#91aaff',currency:'RUB',primaryAction:'new_client'}}});assert.equal(r.status,201);
 const base=origin+'/workspace/'+r.body.project.id;
 r=await get(base+'/api/setup',{method:'POST',cookie:ownCookie,headers:{'x-studio-csrf-token':ownCsrf},data:{name:'Administrator',email:'admin@example.test',password:pass}});assert.equal(r.status,201);const cookie=r.cookie,csrf=r.body.csrf;
 r=await get(base+'/api/automations',{method:'POST',cookie,csrf,data:{name:'First call',event:'client_created',task_title:'Call this guest',priority:'high'}});assert.equal(r.status,201,JSON.stringify(r.body));const ruleId=r.body.automation.id;
 r=await get(base+'/api/clients',{method:'POST',cookie,csrf,data:{full_name:'Customer 1'}});assert.equal(r.status,201);const cid=r.body.client.id;
 r=await get(base+'/api/tasks',{cookie});assert.equal(r.body.tasks.length,1);assert.equal(r.body.tasks[0].client_id,cid);
 r=await get(base+'/api/automations/runs',{cookie});assert.equal(r.body.runs.length,1);
 r=await get(base+'/api/automations/'+ruleId,{method:'PATCH',cookie,csrf,data:{enabled:false}});assert.equal(r.status,200);
 r=await get(base+'/api/clients',{method:'POST',cookie,csrf,data:{full_name:'Customer 2'}});assert.equal(r.status,201);
 r=await get(base+'/api/tasks',{cookie});assert.equal(r.body.tasks.length,1);
 r=await get(base+'/api/users',{method:'POST',cookie,csrf,data:{name:'Staff',email:'staff@example.test',password:pass,role:'staff'}});assert.equal(r.status,201);
 r=await get(base+'/api/login',{method:'POST',data:{email:'staff@example.test',password:pass}});assert.equal(r.status,200);
 r=await get(base+'/api/automations',{cookie:r.cookie});assert.equal(r.status,403);
});
