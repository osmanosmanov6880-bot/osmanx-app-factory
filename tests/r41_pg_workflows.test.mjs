import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {studioDb} from '../src/studio/db.mjs';
import {crmDb} from '../src/crm/db.mjs';
import {issueSession} from '../src/common/security.mjs';
import {respondError} from '../src/common/http.mjs';
import {handleR41PreviewRequest} from '../src/migration/r41-pg-workflows.mjs';

const A='11111111-1111-4111-8111-111111111111',B='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P='22222222-2222-4222-8222-222222222222',Q='33333333-3333-4333-8333-333333333333';
const STAFF='44444444-4444-4444-8444-444444444444',MANAGER='55555555-5555-4555-8555-555555555555';
const CLIENT='66666666-6666-4666-8666-666666666666', OTHER='77777777-7777-4777-8777-777777777777';
const STAMP='2026-11-06T00:00:00.000Z';
const pathBase=`/api/studio/pg-preview/projects/${P}`;
const staffBase=`/workspace/${P}/api/pg-preview`;
const state={tasks:[],visits:[],queries:[],transactions:[],users:new Set([STAFF,MANAGER]),clients:new Set([CLIENT])};
function mockScope(){
  return {query:async(sql,args=[])=>{
    state.queries.push({sql,args});
    if(sql==='SELECT id FROM clients WHERE id=$1 AND archived_at IS NULL')return {rows:state.clients.has(args[0])?[{id:args[0]}]:[]};
    if(sql==='SELECT id FROM users WHERE id=$1 AND active=1')return {rows:state.users.has(args[0])?[{id:args[0]}]:[]};
    if(sql.startsWith('INSERT INTO tasks')){
      const [id,title,description,status,priority,due_at,client_id,assigned_to,created_by,created_at,updated_at]=args;
      const t={id,title,description,status,priority,due_at,client_id,assigned_to,created_by,created_at,updated_at};
      state.tasks.push(t);return {rows:[t]};
    }
    if(sql.startsWith('INSERT INTO visits')){
      const [id,client_id,occurred_at,note,created_by,created_at]=args;
      const v={id,client_id,occurred_at,note,created_by,created_at};
      state.visits.push(v);return {rows:[v]};
    }
    if(sql==='SELECT * FROM tasks WHERE id=$1')return {rows:state.tasks.filter(t=>t.id===args[0])};
    if(sql.startsWith('UPDATE tasks SET')){
      const id=args[args.length-2-(sql.includes('AND assigned_to=')?1:0)];
      const prev=args[args.length-1-(sql.includes('AND assigned_to=')?1:0)];
      const matched=state.tasks.find(t=>t.id===id && t.updated_at===prev && (!sql.includes('AND assigned_to=') || t.assigned_to===args.at(-1)));
      if(!matched)return {rows:[]};
      const assignments=sql.split(' SET ')[1].split(', updated_at=')[0].split(',');
      for(let i=0;i<assignments.length;i++){
        const column=assignments[i].split('=')[0].trim().replaceAll('"','');matched[column]=args[i];
      }
      matched.updated_at=args[assignments.length];return {rows:[matched]};
    }
    if(sql.startsWith('SELECT * FROM tasks')){
      let rows=state.tasks;
      if(sql.includes('assigned_to=$1'))rows=rows.filter(t=>t.assigned_to===args[0]);
      if(sql.includes('client_id=$'))rows=rows.filter(t=>t.client_id===args.find(a=>a===CLIENT));
      return {rows:rows.slice(0,args.at(-1))};
    }
    if(sql.startsWith('SELECT * FROM visits')){
      let rows=state.visits;
      if(sql.includes('created_by=$1'))rows=rows.filter(v=>v.created_by===args[0]);
      return {rows:rows.slice(0,args.at(-1))};
    }
    throw Error('Unexpected test SQL: '+sql.slice(0,100));
  }};
}
const runtime={adapter:{async transaction(args,fn){
  state.transactions.push(args);const oldTasks=structuredClone(state.tasks),oldVisits=structuredClone(state.visits);
  try{return await fn(mockScope());}catch(e){state.tasks=oldTasks;state.visits=oldVisits;throw e;}
}}};
const home=await mkdtemp(join(tmpdir(),'ox-r41-units-'));
const studio=studioDb(join(home,'studio.sqlite'));
const crm=crmDb(join(home,'crm.sqlite'));
for(const [owner,project] of [[A,P],[B,Q]]){
  studio.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?)').run(owner,`${owner}@example.test`,'Synthetic','unused','owner',1,STAMP);
  studio.prepare('INSERT INTO projects(id,owner_id,name,type,industry,modules_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(project,owner,'Preview','crm','restaurant',JSON.stringify(['clients','tasks']),JSON.stringify({}),STAMP,STAMP);
}
for(const [id,role] of [[STAFF,'staff'],[MANAGER,'manager']]){
  crm.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id,`${id}@example.test`,role,'unused',role,1,STAMP);
}
const owner=issueSession(studio,A),ownerB=issueSession(studio,B),staff=issueSession(crm,STAFF),manager=issueSession(crm,MANAGER);
const server=createServer(async(req,res)=>{
  try{
    const employee=req.url.startsWith('/workspace/');
    await handleR41PreviewRequest(req,res,{studioDb:studio,runtime,crmDb:employee?crm:null,workspaceProjectId:employee?P:null});
  }catch(e){respondError(res,e);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
async function request(path,method='GET',body,session=owner,domain='ox_studio'){
  const headers={cookie:`${domain}=${session.token}`};
  if(method!=='GET')headers['x-csrf-token']=session.csrf;
  if(body!==undefined)headers['content-type']='application/json';
  const res=await fetch(origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {code:res.status,body:await res.json()};
}
after(async()=>{await new Promise(resolve=>server.close(resolve));crm.close();studio.close();await rm(home,{recursive:true,force:true});});

test('R4.1 owner session is required before any PostgreSQL transaction',async()=>{
  const n=state.transactions.length;const r=await request(pathBase+'/tasks','GET',undefined,{token:'invalid',csrf:'x'});
  assert.equal(r.code,401);assert.equal(state.transactions.length,n);
});
test('R4.1 other owner cannot access or write another project',async()=>{
  const n=state.transactions.length;
  assert.equal((await request(pathBase+'/tasks','GET',undefined,ownerB)).code,404);
  assert.equal((await request(pathBase+'/visits','POST',{clientId:CLIENT},ownerB)).code,404);
  assert.equal(state.transactions.length,n);
});
test('R4.1 invalid limit and status rejected before PG',async()=>{
  const n=state.transactions.length;
  assert.equal((await request(pathBase+'/tasks?limit=100')).code,400);
  assert.equal((await request(pathBase+'/tasks?status=drop')).code,400);
  assert.equal(state.transactions.length,n);
});
test('R4.1 only managers can create tasks, linked clients and assignees checked',async()=>{
  const n=state.transactions.length;
  assert.equal((await request(staffBase+'/tasks','POST',{title:'Denied'},staff,'ox_crm')).code,403);
  assert.equal(state.transactions.length,n);
  assert.equal((await request(staffBase+'/tasks','POST',{title:'No client',clientId:OTHER},manager,'ox_crm')).code,409);
  const r=await request(staffBase+'/tasks','POST',{title:'Review client',assignedTo:STAFF,clientId:CLIENT},manager,'ox_crm');
  assert.equal(r.code,201);assert.equal(r.body.task.assignedTo,STAFF);
  assert.equal(r.body.task.createdBy,MANAGER);
});
test('R4.1 staff task list is scoped to assigned user',async()=>{
  await request(pathBase+'/tasks','POST',{title:'Other task',assignedTo:MANAGER});
  const st=await request(staffBase+'/tasks','GET',undefined,staff,'ox_crm');
  const mg=await request(staffBase+'/tasks','GET',undefined,manager,'ox_crm');
  assert.equal(st.code,200);assert.equal(mg.code,200);
  assert(st.body.tasks.every(t=>t.assignedTo===STAFF));
  assert(mg.body.tasks.length>st.body.tasks.length);
  assert(state.queries.some(q=>q.sql.includes('assigned_to=$1')&&q.args[0]===STAFF));
});
test('R4.1 staff cannot change reassignment or unassigned task',async()=>{
  const t=state.tasks.find(t=>t.assigned_to===STAFF);
  assert.equal((await request(staffBase+'/tasks/'+t.id,'PATCH',{assignedTo:MANAGER,expectedUpdatedAt:t.updated_at},staff,'ox_crm')).code,403);
  const other=state.tasks.find(t=>t.assigned_to===MANAGER);
  assert.equal((await request(staffBase+'/tasks/'+other.id,'PATCH',{status:'done',expectedUpdatedAt:other.updated_at},staff,'ox_crm')).code,404);
});
test('R4.1 optimistic PATCH prevents stale update and supports staff status change',async()=>{
  const t=state.tasks.find(t=>t.assigned_to===STAFF);
  const v=t.updated_at;
  const changed=await request(staffBase+'/tasks/'+t.id,'PATCH',{status:'doing',expectedUpdatedAt:v},staff,'ox_crm');
  assert.equal(changed.code,200);assert.equal(changed.body.task.status,'doing');
  assert.notEqual(changed.body.task.updatedAt,v);
  assert.equal((await request(staffBase+'/tasks/'+t.id,'PATCH',{status:'done',expectedUpdatedAt:v},staff,'ox_crm')).code,409);
  assert.equal((await request(staffBase+'/tasks/'+t.id,'PATCH',{status:'cancelled',expectedUpdatedAt:changed.body.task.updatedAt},staff,'ox_crm')).code,403);
});
test('R4.1 tasks allow only strict fields and require an update version',async()=>{
  const t=state.tasks[0];
  assert.equal((await request(pathBase+'/tasks/'+t.id,'PATCH',{title:'New'})).code,428);
  assert.equal((await request(pathBase+'/tasks/'+t.id,'PATCH',{title:'New',expectedUpdatedAt:'nonsense'})).code,400);
  assert.equal((await request(pathBase+'/tasks','POST',{title:'SQL',isAdmin:true})).code,400);
});
test('R4.1 staff can create visits but not link other tenant clients',async()=>{
  const invalid=await request(staffBase+'/visits','POST',{clientId:OTHER,note:'unknown'},staff,'ox_crm');
  assert.equal(invalid.code,409);
  const good=await request(staffBase+'/visits','POST',{clientId:CLIENT,note:'Hello'},staff,'ox_crm');
  assert.equal(good.code,201);assert.equal(good.body.visit.createdBy,STAFF);
});
test('R4.1 staff visit list does not expose other staff records',async()=>{
  await request(staffBase+'/visits','POST',{clientId:CLIENT},manager,'ox_crm');
  const s=await request(staffBase+'/visits','GET',undefined,staff,'ox_crm');
  const m=await request(staffBase+'/visits','GET',undefined,manager,'ox_crm');
  assert.equal(s.code,200);assert.equal(m.code,200);
  assert(s.body.visits.every(v=>v.createdBy===STAFF));
  assert(m.body.visits.length>s.body.visits.length);
});
test('R4.1 visit batch validates inside one transaction and rolls back',async()=>{
  const original=state.visits.length;
  const failed=await request(staffBase+'/visits/batch','POST',{items:[{clientId:CLIENT},{clientId:OTHER}]},staff,'ox_crm');
  assert.equal(failed.code,409);assert.equal(state.visits.length,original);
  const good=await request(staffBase+'/visits/batch','POST',{items:[{clientId:CLIENT},{clientId:CLIENT}]},staff,'ox_crm');
  assert.equal(good.code,201);assert.equal(good.body.visits.length,2);
});
test('R4.1 module changes immediately deny access before PostgreSQL',async()=>{
  const n=state.transactions.length;
  studio.prepare("UPDATE projects SET modules_json=? WHERE id=?").run(JSON.stringify(['clients']),P);
  assert.equal((await request(staffBase+'/tasks','GET',undefined,staff,'ox_crm')).code,404);
  assert.equal(state.transactions.length,n);
  studio.prepare("UPDATE projects SET modules_json=? WHERE id=?").run(JSON.stringify(['clients','tasks']),P);
});

test('R4.1 revoked employee session is denied before PG transaction',async()=>{
  const n=state.transactions.length;
  crm.prepare('UPDATE users SET active=0 WHERE id=?').run(STAFF);
  assert.equal((await request(staffBase+'/tasks','GET',undefined,staff,'ox_crm')).code,401);
  assert.equal(state.transactions.length,n);
  crm.prepare('UPDATE users SET active=1 WHERE id=?').run(STAFF);
});
test('R4.1 CSRF and cross-origin requests are rejected before PG writes',async()=>{
  const n=state.transactions.length;
  const badCsrf=await fetch(origin+staffBase+'/visits',{method:'POST',headers:{cookie:`ox_crm=${staff.token}`,'content-type':'application/json','x-csrf-token':'wrong'},body:JSON.stringify({clientId:CLIENT})});
  assert.equal(badCsrf.status,403);
  const cross=await fetch(origin+staffBase+'/visits',{method:'POST',headers:{cookie:`ox_crm=${staff.token}`,'content-type':'application/json','x-csrf-token':staff.csrf,origin:'https://malicious.example'},body:JSON.stringify({clientId:CLIENT})});
  assert.equal(cross.status,403);assert.equal(state.transactions.length,n);
});
test('R4.1 rejects invalid title type and visit injection fields',async()=>{
  assert.equal((await request(pathBase+'/tasks','POST',{title:22})).code,400);
  assert.equal((await request(pathBase+'/visits','POST',{clientId:CLIENT,createdBy:MANAGER})).code,400);
});
