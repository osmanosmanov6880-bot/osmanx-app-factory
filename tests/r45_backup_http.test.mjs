import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {studioDb} from '../src/studio/db.mjs';
import {issueSession} from '../src/common/security.mjs';
import {respondError} from '../src/common/http.mjs';
import {handleR45Request} from '../src/migration/r45-pg-http.mjs';
const A='11111111-1111-4111-8111-111111111111';
const B='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const P='22222222-2222-4222-8222-222222222222';
const Q='33333333-3333-4333-8333-333333333333';
const now='2026-11-06T00:00:00.000Z';
const root=await mkdtemp(join(tmpdir(),'ox-r45-http-'));
const db=studioDb(join(root,'studio.sqlite'));
for(const [owner,project] of [[A,P],[B,Q]]){
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(owner,owner+'@example.test','Synthetic','not-a-password','owner',1,now);
  db.prepare('INSERT INTO projects(id,owner_id,name,type,industry,modules_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(project,owner,'Test','crm','restaurant','["clients","tasks"]','{}',now,now);
}
const first=issueSession(db,A),second=issueSession(db,B);
let pgCalls=0;const runtime={adapter:{transaction:async()=>{pgCalls++;throw Error('PG must not be used in restore authorization tests');}}};
const options={backupDrill:true,secret:randomBytes(32),bundleDir:'/synthetic',trustedPublicKey:'/public'};
const server=createServer(async(req,res)=>{
  try{await handleR45Request(req,res,{studioDb:db,runtime,dataDir:root,options});}
  catch(e){respondError(res,e);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const route='/api/studio/pg-preview/projects/'+P+'/backup-drill';
async function request(path,method='GET',session=first,csrf,extra={}){
  const headers={...extra};
  if(session)headers.cookie='ox_studio='+session.token;
  if(csrf!==undefined)headers['x-csrf-token']=csrf;
  const res=await fetch(base+path,{method,headers});
  return {status:res.status,body:await res.json()};
}
after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();await rm(root,{recursive:true,force:true});});
test('R4.5 refuses anonymous history before PostgreSQL or filesystem read',async()=>{
  const count=pgCalls;
  assert.equal((await request(route+'/history','GET',null)).status,401);
  assert.equal(pgCalls,count);
});
test('R4.5 owner cannot inspect or replay another organization',async()=>{
  const count=pgCalls;
  assert.equal((await request(route+'/history','GET',second)).status,404);
  assert.equal((await request(route+'/check','POST',second,second.csrf)).status,404);
  assert.equal(pgCalls,count);
});
test('R4.5 CSRF and Origin failures precede any database connection',async()=>{
  const count=pgCalls;
  assert.equal((await request(route+'/check','POST',first,'incorrect')).status,403);
  assert.equal((await request(route+'/check','POST',first,first.csrf,{origin:'https://attacker.example'})).status,403);
  assert.equal(pgCalls,count);
});
test('R4.5 state-changing route rejects GET and requires POST',async()=>{
  const count=pgCalls;
  assert.equal((await request(route+'/check','GET')).status,405);
  assert.equal(pgCalls,count);
});
test('R4.5 private restore evidence history is initially empty and has no cutover route',async()=>{
  const r=await request(route+'/history');
  assert.equal(r.status,200);
  assert.equal(r.body.entries,0);
  assert.equal(r.body.productionCutoverAllowed,false);
  assert.equal(pgCalls,0);
});
test('R4.5 deactivated owner immediately loses preview access',async()=>{
  db.prepare('UPDATE users SET active=0 WHERE id=?').run(A);
  try{assert.equal((await request(route+'/history')).status,401);}
  finally{db.prepare('UPDATE users SET active=1 WHERE id=?').run(A);}
  assert.equal(pgCalls,0);
});
