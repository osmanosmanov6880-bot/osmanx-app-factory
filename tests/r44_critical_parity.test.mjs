import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {assessR44CriticalParity} from '../src/migration/r44-critical-parity.mjs';
import {validateR43Options} from '../src/migration/r43-pg-http.mjs';
const k=randomBytes(32),U='11111111-1111-4111-8111-111111111111',C='22222222-2222-4222-8222-222222222222',T='33333333-3333-4333-8333-333333333333',P='44444444-4444-4444-8444-444444444444',A='55555555-5555-4555-8555-555555555555',V='66666666-6666-4666-8666-666666666666';
function setup(){
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE users(id TEXT PRIMARY KEY);CREATE TABLE clients(id TEXT PRIMARY KEY);CREATE TABLE tasks(id TEXT PRIMARY KEY);CREATE TABLE payments(id TEXT PRIMARY KEY,client_id TEXT,amount_minor INTEGER,currency TEXT,method TEXT,status TEXT,idem_key TEXT,request_fingerprint TEXT,created_by TEXT);CREATE TABLE automations(id TEXT PRIMARY KEY,event TEXT,priority TEXT,enabled INTEGER,due_days INTEGER,entity_slug TEXT,created_by TEXT);CREATE TABLE automation_runs(id TEXT PRIMARY KEY,automation_id TEXT,event_key TEXT,task_id TEXT);CREATE TABLE custom_entity_schema(slug TEXT PRIMARY KEY,definition_json TEXT,updated_at TEXT NOT NULL);CREATE TABLE custom_orders(id TEXT PRIMARY KEY,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT,created_by TEXT,ticket TEXT);');
 db.prepare('INSERT INTO users VALUES(?)').run(U);db.prepare('INSERT INTO clients VALUES(?)').run(C);
 db.prepare('INSERT INTO tasks VALUES(?)').run(T);
 db.prepare('INSERT INTO payments VALUES(?,?,?,?,?,?,?,?,?)').run(P,C,12500,'RUB','terminal','paid','r44-idem','r44-fp',U);
 db.prepare('INSERT INTO automations VALUES(?,?,?,?,?,?,?)').run(A,'entity_created','medium',1,0,'orders',U);
 db.prepare('INSERT INTO automation_runs VALUES(?,?,?,?)').run(V,A,'r44-event',T);
 db.prepare('INSERT INTO custom_entity_schema VALUES(?,?,?)').run('orders',JSON.stringify({slug:'orders',fields:[{key:'ticket',type:'text',required:false}]}),'2026-11-06T00:00:00.000Z');
 db.prepare('INSERT INTO custom_orders VALUES(?,?,?,?,?,?,?)').run('77777777-7777-4777-8777-777777777777',1,'2026-11-06T00:00:00.000Z','2026-11-06T00:00:00.000Z',null,U,'Synthetic');
 function capture(){return ['users','clients','tasks','payments','automations','automation_runs','custom_entity_schema','custom_orders'].map(name=>{
   const meta=db.prepare('PRAGMA table_info("'+name+'")').all();
   const columns=meta.map(c=>({name:c.name,type:c.type==='INTEGER'?'BIGINT':'TEXT'}));
   const primary=meta.filter(c=>c.pk).map(c=>c.name);
   return {table:{name,columns,primary},postgresRows:db.prepare('SELECT * FROM "'+name+'" ORDER BY "'+primary[0]+'"').all()};
 });}
 return {db,capture};
}
test('R44 verifies nonempty payment, workflow, custom entity parity',()=>{
 const f=setup();try{const r=assessR44CriticalParity(f.db,f.capture(),{secret:k});
 assert.equal(r.ok,true);assert.equal(r.financial.records,1);assert.equal(r.automations.runs,1);
 assert.equal(r.custom.entities,1);assert.equal(r.productionCutoverAllowed,false);
 assert(!JSON.stringify(r).includes('12500'));}finally{f.db.close();}
});
test('R44 catches changed payment with equal counts',()=>{
 const f=setup();try{const c=f.capture();c.find(x=>x.table.name==='payments').postgresRows[0].amount_minor=12501;
 assert.throws(()=>assessR44CriticalParity(f.db,c,{secret:k}),/critical table drift/);}finally{f.db.close();}
});
test('R44 catches duplicate payment idempotency keys',()=>{
 const f=setup();try{f.db.prepare('INSERT INTO payments VALUES(?,?,?,?,?,?,?,?,?)').run('88888888-8888-4888-8888-888888888888',C,1,'RUB','cash','pending','r44-idem',null,U);
 assert.throws(()=>assessR44CriticalParity(f.db,f.capture(),{secret:k}),/duplicate payment idempotency key/);}finally{f.db.close();}
});
test('R44 blocks orphan automation task',()=>{
 const f=setup();try{f.db.prepare('UPDATE automation_runs SET task_id=?').run('99999999-9999-4999-8999-999999999999');
 assert.throws(()=>assessR44CriticalParity(f.db,f.capture(),{secret:k}),/missing task/);}finally{f.db.close();}
});
test('R44 rejects zero or negative payment amounts even when both engines match',()=>{
 const f=setup();try{
   f.db.prepare('UPDATE payments SET amount_minor=?').run(0);
   assert.throws(()=>assessR44CriticalParity(f.db,f.capture(),{secret:k}),/invalid payment amount/);
 }finally{f.db.close();}
});
test('R44 rejects unknown custom-entity automation targets',()=>{
 const f=setup();try{
   f.db.prepare('UPDATE automations SET entity_slug=?').run('unknown');
   assert.throws(()=>assessR44CriticalParity(f.db,f.capture(),{secret:k}),/missing custom entity/);
 }finally{f.db.close();}
});
test('R44 rejects a missing custom table or invalid select option',()=>{
 const f=setup();try{
   const missing=f.capture().filter(x=>x.table.name!=='custom_orders');
   assert.throws(()=>assessR44CriticalParity(f.db,missing,{secret:k}),/custom table missing/);
   const def={slug:'orders',fields:[{key:'ticket',type:'select',options:['Accepted'],required:true}]};
   f.db.prepare('UPDATE custom_entity_schema SET definition_json=?').run(JSON.stringify(def));
   assert.throws(()=>assessR44CriticalParity(f.db,f.capture(),{secret:k}),/invalid custom select value/);
 }finally{f.db.close();}
});
test('R44 denies missing signed payment table before any replay',()=>{
 const f=setup();try{
   const missing=f.capture().filter(c=>c.table.name!=='payments');
   assert.throws(()=>assessR44CriticalParity(f.db,missing,{secret:k}),/required CRM table missing: payments/);
 }finally{f.db.close();}
});
test('R44 rejects unsupported payment statuses despite matching snapshots',()=>{
 const f=setup();try{
   f.db.prepare('UPDATE payments SET status=?').run('unknown');
   assert.throws(()=>assessR44CriticalParity(f.db,f.capture(),{secret:k}),/invalid payment status/);
 }finally{f.db.close();}
});
test('R44 requires explicit synthetic opt-in',()=>{
 const env={OX_R43_SHADOW_REPLAY:'YES',OX_R43_CONFIRM_SYNTHETIC:'YES',OX_R42_PG_RECONCILIATION:'YES',OX_R40_PG_PREVIEW:'YES',OX_R42_JOURNAL_HMAC_KEY:k.toString('hex'),OX_R40_PG_BUNDLE:'/bundle',OX_R40_PG_TRUST_KEY:'/key',OX_R44_CRITICAL_PARITY:'YES'};
 assert.throws(()=>validateR43Options(env),/explicit synthetic fixture opt-in/);
 assert.equal(validateR43Options({...env,OX_R44_CONFIRM_SYNTHETIC:'YES'}).criticalParityGate,true);
});
