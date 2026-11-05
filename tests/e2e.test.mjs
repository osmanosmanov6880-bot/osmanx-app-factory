import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createServer } from 'node:net';

const root=resolve(import.meta.dirname,'..');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){
  const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;
  await new Promise(r=>s.close(r));return p;
}
async function start(script,cwd,dataDir,port){
  const proc=spawn(process.execPath,[script],{cwd,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:dataDir,NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
  let logs='';proc.stdout.on('data',x=>logs+=x);proc.stderr.on('data',x=>logs+=x);
  for(let i=0;i<80;i++){
    if(proc.exitCode!==null)throw new Error('Server exited: '+logs);
    try{const r=await fetch('http://127.0.0.1:'+port+'/api/health');if(r.ok)return proc;}catch{}
    await sleep(100);
  }
  proc.kill('SIGTERM');throw new Error('Server did not boot: '+logs);
}
async function api(origin,path,{method='GET',data,token,cookie,headers={}}={}){
  const h={...headers};if(data!==undefined)h['content-type']='application/json';if(token)h['x-csrf-token']=token;if(cookie)h.cookie=cookie;
  const r=await fetch(origin+path,{method,headers:h,body:data===undefined?undefined:JSON.stringify(data)});
  const text=await r.text();let payload;try{payload=JSON.parse(text)}catch{payload=text}
  return {status:r.status,payload,cookie:r.headers.get('set-cookie')?.split(';')[0],headers:r.headers};
}
function unzipStored(buffer,dest){
  const promises=[];let at=0;
  while(at+30<=buffer.length && buffer.readUInt32LE(at)===0x04034b50){
    const size=buffer.readUInt32LE(at+18),namelen=buffer.readUInt16LE(at+26),extralen=buffer.readUInt16LE(at+28);
    const name=buffer.subarray(at+30,at+30+namelen).toString('utf8');
    if(name.startsWith('/')||name.includes('..'))throw new Error('Unsafe path: '+name);
    const offset=at+30+namelen+extralen;
    promises.push((async()=>{const file=join(dest,name);await mkdir(dirname(file),{recursive:true});await writeFile(file,buffer.subarray(offset,offset+size));})());
    at=offset+size;
  }
  return Promise.all(promises);
}
const newPass='Z5_mQ8s4_b7zN';
test('OSMANX factory -> restaurant CRM -> independent ZIP export', {timeout:120000}, async t=>{
  const tmp=await mkdtemp(join(tmpdir(),'osmanx-test-'));
  const port=await freePort(),origin=`http://127.0.0.1:${port}`;
  const proc=await start('server.mjs',root,join(tmp,'studio-data'),port);
  t.after(()=>proc.kill('SIGTERM'));
  let assets=await fetch(origin+'/assets/studio/editor.js');
  assert.equal(assets.status,200,'Page editor JS must be served by the factory');
  assert.match(await assets.text(),/initPageEditor/);
  let r=await api(origin,'/api/studio/session');
  assert.equal(r.status,200);assert.equal(r.payload.initialized,false);
  r=await api(origin,'/api/studio/setup',{method:'POST',data:{email:'owner@test.example',name:'Factory Owner',password:newPass}});
  assert.equal(r.status,201,JSON.stringify(r.payload));
  const factoryCookie=r.cookie,factoryCsrf=r.payload.csrf;
  r=await api(origin,'/api/studio/projects',{method:'POST',cookie:factoryCookie,token:factoryCsrf,
    data:{name:'Test Restaurant',type:'crm',industry:'restaurant',modules:['auth','clients','analytics','tasks','payments'],settings:{accent:'#91aaff',primaryAction:'new_client',currency:'RUB'}}});
  assert.equal(r.status,201,JSON.stringify(r.payload));
  const project=r.payload.project,id=project.id,prefix=`/workspace/${id}`;
  assert.equal(project.modules.length,5);
  r=await api(origin,`/api/studio/projects/${id}/pages`);
  assert.equal(r.status,401,'factory pages require an authenticated owner');
  r=await api(origin,`/api/studio/projects/${id}/pages`,{cookie:factoryCookie});
  assert.equal(r.status,200);assert.equal(r.payload.pages.length,1);
  const starter=r.payload.pages[0];assert.equal(starter.slug,'service');assert.equal(starter.published,true);
  const revised={...starter,title:'Гости и сервис',description:'Новый экран',blocks:[
    {id:starter.blocks[0].id,type:'hero',eyebrow:'OSMANX',title:'Сервис под контролем',subtitle:'Все процессы в одном месте'},
    {id:starter.blocks[1].id,type:'metric',label:'Гости',metric:'clients_total'},
    {id:'form-client-demo-01',type:'form',title:'Добавить гостя',entity:'clients',fields:['full_name','phone','source'],submitLabel:'Сохранить гостя'},
    {id:'btn-client-demo-01',type:'button',label:'Клиенты',action:'navigate:clients',style:'secondary'},
    {id:'table-task-demo-01',type:'table',title:'Задачи',entity:'tasks',columns:['title','priority']},
    {id:'text-sanitization-01',type:'text',title:'Текст',body:'<img src=x onerror=alert(1)>'}
  ]};
  r=await api(origin,`/api/studio/projects/${id}/pages/${starter.id}`,{method:'PATCH',cookie:factoryCookie,token:factoryCsrf,data:revised});
  assert.equal(r.status,200,JSON.stringify(r.payload));assert.equal(r.payload.page.revision,2);
  r=await api(origin,`/api/studio/projects/${id}/pages/${starter.id}`,{method:'PATCH',cookie:factoryCookie,token:factoryCsrf,data:revised});
  assert.equal(r.status,409,'stale editors may not overwrite revisions');
  r=await api(origin,`/api/studio/projects/${id}/pages`,{method:'POST',cookie:factoryCookie,token:factoryCsrf,data:{title:'Черновик',slug:'draft-idea',description:'',published:false,blocks:[]}});
  assert.equal(r.status,201);const draftId=r.payload.page.id;
  r=await api(origin,`/api/studio/projects/${id}/pages/${draftId}`,{method:'DELETE',cookie:factoryCookie,token:factoryCsrf,data:{revision:1}});
  assert.equal(r.status,200);
  r=await api(origin,prefix+'/api/pages');assert.equal(r.status,401,'published pages are only accessible after CRM login');
  assets=await fetch(origin+prefix+'/assets/pages.js');
  assert.equal(assets.status,200,'Published page runtime JS must be served in CRM workspace');
  r=await api(origin,prefix+'/api/config');assert.equal(r.payload.config.name,'Test Restaurant');
  r=await api(origin,prefix+'/api/session');assert.equal(r.payload.initialized,false);
  r=await api(origin,prefix+'/api/setup',{method:'POST',data:{email:'intruder@test.example',name:'Intruder',password:newPass}});
  assert.equal(r.status,403,'factory project bootstrap must require owner');
  r=await api(origin,prefix+'/api/setup',{method:'POST',cookie:factoryCookie,headers:{'x-studio-csrf-token':factoryCsrf},data:{email:'admin@test.example',name:'Restaurant Admin',password:newPass}});
  assert.equal(r.status,201,JSON.stringify(r.payload));
  const crmCookie=r.cookie,csrf=r.payload.csrf;
  r=await api(origin,prefix+'/api/pages',{cookie:crmCookie});
  assert.equal(r.status,200);assert.equal(r.payload.pages.length,1);
  assert.equal(r.payload.pages[0].title,'Гости и сервис');
  assert.ok(r.payload.pages[0].blocks.some(b=>b.type==='form'));
  r=await api(origin,prefix+'/api/page-metrics',{cookie:crmCookie});
  assert.equal(r.payload.metrics.clients_total,0);
  r=await api(origin,prefix+'/api/clients',{method:'POST',cookie:crmCookie,data:{full_name:'CSRF should be blocked'}});
  assert.equal(r.status,403);
  r=await api(origin,prefix+'/api/clients',{method:'POST',cookie:crmCookie,token:csrf,
    data:{full_name:'Alice Guest',phone:'+79990000000',source:'referral'}});
  assert.equal(r.status,201,JSON.stringify(r.payload));const cid=r.payload.client.id;
  r=await api(origin,prefix+'/api/clients',{cookie:crmCookie});assert.equal(r.payload.clients.length,1);
  for(let i=0;i<2;i++){
    r=await api(origin,prefix+'/api/visits',{method:'POST',cookie:crmCookie,token:csrf,
      data:{client_id:cid,note:`Visit ${i+1}`}});
    assert.equal(r.status,201,JSON.stringify(r.payload));
  }
  r=await api(origin,prefix+'/api/tasks',{method:'POST',cookie:crmCookie,token:csrf,
    data:{title:'Call guest',client_id:cid,priority:'high'}});
  assert.equal(r.status,201);const taskId=r.payload.task.id;
  r=await api(origin,prefix+'/api/tasks/'+taskId,{method:'PATCH',cookie:crmCookie,token:csrf,data:{status:'done'}});
  assert.equal(r.payload.task.status,'done');
  r=await api(origin,prefix+'/api/payments',{method:'POST',cookie:crmCookie,token:csrf,headers:{'idempotency-key':'test-payment-001'},
    data:{client_id:cid,amount_minor:105050,currency:'RUB',method:'terminal',status:'paid'}});
  assert.equal(r.status,201,JSON.stringify(r.payload));const payId=r.payload.payment.id;
  r=await api(origin,prefix+'/api/payments',{method:'POST',cookie:crmCookie,token:csrf,headers:{'idempotency-key':'test-payment-001'},
    data:{client_id:cid,amount_minor:105050,currency:'RUB',method:'terminal',status:'paid'}});
  assert.equal(r.payload.replayed,true);
  r=await api(origin,prefix+'/api/page-metrics',{cookie:crmCookie});
  assert.equal(r.payload.metrics.clients_total,1);
  assert.equal(r.payload.metrics.open_tasks,0);
  assert.equal(r.payload.metrics.repeat_share,100);
  assert.equal(r.payload.metrics.paid_minor,105050);
  r=await api(origin,prefix+'/api/analytics',{cookie:crmCookie});
  assert.equal(r.status,200);assert.equal(r.payload.analytics.totals.clients,1);
  assert.equal(r.payload.analytics.totals.visits,2);
  assert.equal(r.payload.analytics.totals.repeatClients,1);
  assert.equal(r.payload.analytics.totals.repeatShare,100);
  assert.equal(r.payload.analytics.totals.paidMinor,105050);
  r=await api(origin,prefix+'/api/users',{method:'POST',cookie:crmCookie,token:csrf,
    data:{name:'Waiter',email:'waiter@test.example',password:newPass,role:'staff'}});
  assert.equal(r.status,201);
  r=await api(origin,prefix+'/api/login',{method:'POST',data:{email:'waiter@test.example',password:newPass}});
  assert.equal(r.status,200);const staffCookie=r.cookie;
  r=await api(origin,prefix+'/api/payments',{cookie:staffCookie});assert.equal(r.status,403);
  r=await api(origin,prefix+'/api/analytics',{cookie:staffCookie});assert.equal(r.status,403);
  r=await api(origin,prefix+'/api/page-metrics',{cookie:staffCookie});
  assert.equal(r.status,200);assert.ok(!('paid_minor' in r.payload.metrics));assert.ok(!('repeat_share' in r.payload.metrics));
  r=await api(origin,prefix+'/api/payments/'+payId,{method:'PATCH',cookie:crmCookie,token:csrf,data:{status:'refunded'}});
  assert.equal(r.status,200);
  r=await api(origin,prefix+'/api/analytics',{cookie:crmCookie});assert.equal(r.payload.analytics.totals.paidMinor,0);
  r=await api(origin,prefix+'/api/payments',{method:'POST',cookie:crmCookie,token:csrf,headers:{'idempotency-key':'test-payment-001'},
    data:{client_id:cid,amount_minor:105050,currency:'RUB',method:'terminal',status:'paid'}});
  assert.equal(r.payload.replayed,true,'a changed payment status must not break idempotency fingerprint');
  r=await api(origin,prefix+'/api/payments',{method:'POST',cookie:crmCookie,token:csrf,headers:{'idempotency-key':'test-payment-001'},
    data:{client_id:cid,amount_minor:105051,currency:'RUB',method:'terminal',status:'paid'}});
  assert.equal(r.status,409,'the same idempotency key cannot be reused for a different payment');
  r=await api(origin,prefix+'/api/clients/'+cid,{method:'DELETE',cookie:crmCookie,token:csrf,data:{}});
  assert.equal(r.status,200);
  r=await api(origin,prefix+'/api/clients',{cookie:crmCookie});assert.equal(r.payload.clients.length,0);
  r=await api(origin,prefix+'/api/visits',{cookie:crmCookie});assert.equal(r.payload.visits.length,2);
  r=await api(origin,`/api/studio/projects/${id}`,{method:'PATCH',cookie:factoryCookie,token:factoryCsrf,
    data:{name:'Restaurant Rebranded',settings:{accent:'#aabbcc',primaryAction:'new_task',currency:'RUB'}}});
  assert.equal(r.status,200);assert.equal(r.payload.project.settings.primaryAction,'new_task');
  r=await api(origin,prefix+'/api/config');assert.equal(r.payload.config.settings.accent,'#aabbcc','settings apply to CRM config');
  r=await api(origin,'/api/studio/projects',{method:'POST',cookie:factoryCookie,token:factoryCsrf,
    data:{name:'Second Restaurant',type:'crm',industry:'restaurant',modules:['auth','clients'],settings:{accent:'#123456',primaryAction:'new_client',currency:'EUR'}}});
  assert.equal(r.status,201);const secondPrefix=`/workspace/${r.payload.project.id}`;
  r=await api(origin,secondPrefix+'/api/setup',{method:'POST',cookie:factoryCookie,
    headers:{'x-studio-csrf-token':factoryCsrf},data:{email:'second@test.example',name:'Second Admin',password:newPass}});
  assert.equal(r.status,201);const secondCookie=r.cookie;
  r=await api(origin,secondPrefix+'/api/clients',{cookie:crmCookie});
  assert.equal(r.status,401,'different project database rejects CRM1 session');
  r=await api(origin,secondPrefix+'/api/clients',{cookie:secondCookie});
  assert.equal(r.status,200);assert.equal(r.payload.clients.length,0,'new project has no prior CRM records');
  r=await api(origin,secondPrefix+'/api/payments',{cookie:secondCookie});
  assert.equal(r.status,404,'disabled payment module is not mounted');
  r=await api(origin,`/api/studio/projects/${id}/export`,{cookie:factoryCookie});
  assert.equal(r.status,200);
  const zip=await fetch(origin+`/api/studio/projects/${id}/export`,{headers:{cookie:factoryCookie}}).then(x=>x.arrayBuffer()).then(x=>Buffer.from(x));
  assert.equal(zip.readUInt32LE(0),0x04034b50);
  const exported=join(tmp,'exported');await unzipStored(zip,exported);
  const config=JSON.parse(await readFile(join(exported,'config/project.json'),'utf8'));
  assert.equal(config.id,id);assert.equal(config.settings.accent,'#aabbcc');
  assert.equal(config.pages.length,1);assert.equal(config.pages[0].title,'Гости и сервис');
  assert.equal(config.pages[0].blocks.find(b=>b.type==='form').entity,'clients');
  const otherPort=await freePort(),otherOrigin=`http://127.0.0.1:${otherPort}`;
  const proc2=await start('run.mjs',exported,join(tmp,'exported-data'),otherPort);
  t.after(()=>proc2.kill('SIGTERM'));
  r=await api(otherOrigin,'/api/session');assert.equal(r.payload.initialized,false,'no credentials exported');
  r=await api(otherOrigin,'/api/setup',{method:'POST',data:{name:'Independent Admin',email:'independent@test.example',password:newPass}});
  assert.equal(r.status,201,JSON.stringify(r.payload));
  const expCookie=r.cookie,expCsrf=r.payload.csrf;
  r=await api(otherOrigin,'/api/pages',{cookie:expCookie});assert.equal(r.status,200);assert.equal(r.payload.pages[0].slug,'service');
  r=await api(otherOrigin,'/api/page-metrics',{cookie:expCookie});assert.equal(r.payload.metrics.clients_total,0);
  r=await api(otherOrigin,'/api/clients',{cookie:expCookie});assert.equal(r.payload.clients.length,0,'no client data leaked');
  r=await api(otherOrigin,'/api/clients',{method:'POST',cookie:expCookie,token:expCsrf,data:{full_name:'Exported Customer'}});
  assert.equal(r.status,201);
  r=await api(otherOrigin,'/api/clients',{cookie:expCookie});assert.equal(r.payload.clients.length,1);
});
