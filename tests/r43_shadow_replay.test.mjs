import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {applyR43ShadowPatch} from '../src/migration/r43-shadow-replay.mjs';
import {r43AfterImageHmac,r43AuditVersion} from '../src/migration/r42-pg-audit.mjs';
import {appendR43Checkpoint,verifyR43Checkpoints} from '../src/migration/r43-replay-journal.mjs';
import {validateR43Options} from '../src/migration/r43-pg-http.mjs';

const C='11111111-1111-4111-8111-111111111111';
const T='22222222-2222-4222-8222-222222222222';
const V='33333333-3333-4333-8333-333333333333';
const U='44444444-4444-4444-8444-444444444444';
const A1='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const A2='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const A3='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const TIME='2026-11-06T00:00:00.000Z';
const secret=randomBytes(32);
const table=(name,columns)=>({name,primary:['id'],columns:columns.map(name=>({name,type:'TEXT'}))});
const TABLES={
  users:table('users',['id','role']),
  clients:table('clients',['id','full_name','phone','email','source','notes','archived_at','created_at','updated_at']),
  tasks:table('tasks',['id','title','description','status','priority','due_at','client_id','assigned_to','created_by','created_at','updated_at']),
  visits:table('visits',['id','client_id','occurred_at','note','created_by','created_at']),
  audit_log:table('audit_log',['id','user_id','action','entity','entity_id','metadata_json','created_at'])
};
const event=(id,action,entity,row)=>({id,user_id:null,action:'pg-preview.'+action,
  entity,entity_id:row.id,metadata_json:JSON.stringify({surface:'postgresql-preview',actorKind:'studio-owner',
    auditVersion:'r43-after-image-v1',afterImageHmac:r43AfterImageHmac(secret,entity,row),
    afterImageVersion:r43AuditVersion(entity,row)}),created_at:TIME});

async function fixture(){
  const folder=await mkdtemp(join(tmpdir(),'ox-r43-unit-'));
  const db=new DatabaseSync(join(folder,'shadow.sqlite'),{enableForeignKeyConstraints:true});
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT NOT NULL); CREATE TABLE clients(id TEXT PRIMARY KEY,full_name TEXT NOT NULL,phone TEXT NOT NULL,email TEXT NOT NULL,source TEXT NOT NULL,notes TEXT NOT NULL,archived_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL,priority TEXT NOT NULL,due_at TEXT,client_id TEXT REFERENCES clients(id),assigned_to TEXT REFERENCES users(id),created_by TEXT REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE visits(id TEXT PRIMARY KEY,client_id TEXT NOT NULL REFERENCES clients(id),occurred_at TEXT NOT NULL,note TEXT NOT NULL,created_by TEXT REFERENCES users(id),created_at TEXT NOT NULL); CREATE TABLE audit_log(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),action TEXT NOT NULL,entity TEXT NOT NULL,entity_id TEXT,metadata_json TEXT NOT NULL,created_at TEXT NOT NULL);');
  db.prepare('INSERT INTO users VALUES(?,?)').run(U,'staff');
  db.prepare('INSERT INTO clients VALUES(?,?,?,?,?,?,?,?,?)').run(C,'Original','','','unknown','',null,TIME,TIME);
  const pg={
    users:[{id:U,role:'staff'}],
    clients:[{id:C,full_name:'Changed in PG',phone:'',email:'',source:'unknown',notes:'',archived_at:null,created_at:TIME,updated_at:TIME}],
    tasks:[{id:T,title:'First',description:'',status:'todo',priority:'medium',due_at:null,client_id:C,assigned_to:U,created_by:null,created_at:TIME,updated_at:TIME}],
    visits:[{id:V,client_id:C,occurred_at:TIME,note:'',created_by:null,created_at:TIME}],
    audit_log:[]
  };
  pg.audit_log=[event(A1,'update','clients',pg.clients[0]),
    event(A2,'create','tasks',pg.tasks[0]),event(A3,'create','visits',pg.visits[0])];
  const captures=Object.keys(TABLES).map(name=>({table:TABLES[name],postgresRows:pg[name]}));
  return {folder,db,pg,captures,async close(){db.close();await rm(folder,{recursive:true,force:true});}};
}
test('R4.3 rejects six-group UUIDs and accepts valid audit identifiers',async()=>{
  const f=await fixture();
  try{assert.equal(applyR43ShadowPatch(f.db,f.captures,{secret}).shadowVerified,true);}
  finally{await f.close();}
  const invalid=await fixture();
  try{
    const captures=invalid.captures.map(c=>c.table.name==='audit_log'?
      {...c,postgresRows:c.postgresRows.map((r,i)=>i===0?
        {...r,id:'aaaaaaaa-aaaa-4aaa-8aaa-abcd-aaaaaaaaaaaa'}:r)}:c);
    assert.throws(()=>applyR43ShadowPatch(invalid.db,captures,{secret}),/new audit entry IDs invalid/);
  }finally{await invalid.close();}
});
test('R4.3 replays only audited mutations and retry is exactly idempotent',async()=>{
  const f=await fixture();
  try{
    const first=applyR43ShadowPatch(f.db,f.captures,{secret});
    assert.deepEqual([first.inserted,first.updated],[5,1]);
    assert.equal(first.auditEventCount,3);
    assert.equal(f.db.prepare('SELECT full_name FROM clients WHERE id=?').get(C).full_name,'Changed in PG');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM visits').get().n,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM audit_log').get().n,3);
    const retry=applyR43ShadowPatch(f.db,f.captures,{secret});
    assert.equal(retry.inserted,0);assert.equal(retry.updated,0);
    assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{await f.close();}
});
test('R4.3 crash injection rolls back preceding inserts and updates',async()=>{
  const f=await fixture();
  try{
    assert.throws(()=>applyR43ShadowPatch(f.db,f.captures,{faultAfterTable:'tasks',secret}),/injected shadow failure/);
    assert.equal(f.db.prepare('SELECT full_name FROM clients WHERE id=?').get(C).full_name,'Original');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM audit_log').get().n,0);
    const resumed=applyR43ShadowPatch(f.db,f.captures,{secret});
    assert.equal(resumed.shadowVerified,true);
    assert.equal(resumed.inserted,5);
  }finally{await f.close();}
});
test('R4.3 refuses unlogged PG changes before shadow write',async()=>{
  const f=await fixture();
  try{
    const unlogged=f.captures.map(x=>({table:x.table,postgresRows:x.postgresRows.filter(row=>row.id!==A1)}));
    assert.throws(()=>applyR43ShadowPatch(f.db,unlogged,{secret}),/no matching signed after-image/);
    assert.equal(f.db.prepare('SELECT full_name FROM clients').get().full_name,'Original');
  }finally{await f.close();}
});
test('R4.3 refuses unsupported changes to users and missing source rows',async()=>{
  const f=await fixture();
  try{
    const changed=f.captures.map(x=>x.table.name==='users'?{...x,postgresRows:[{id:U,role:'admin'}]}:x);
    assert.throws(()=>applyR43ShadowPatch(f.db,changed,{secret}),/unsupported PostgreSQL mutation/);
    const removed=f.captures.map(x=>x.table.name==='clients'?{...x,postgresRows:[]}:x);
    assert.throws(()=>applyR43ShadowPatch(f.db,removed,{secret}),/removed source records/);
  }finally{await f.close();}
});
test('R4.3 rejects direct mutation of a row that was previously audited',async()=>{
  const f=await fixture();
  try{
    const modified=f.captures.map(c=>c.table.name==='clients'
      ?{...c,postgresRows:c.postgresRows.map(row=>({...row,full_name:'Unlogged after signed update'}))}:c);
    assert.throws(()=>applyR43ShadowPatch(f.db,modified,{secret}),/latest signed after-image does not match PostgreSQL row/);
    assert.equal(f.db.prepare('SELECT full_name FROM clients').get().full_name,'Original');
    const before=r43AfterImageHmac(secret,'clients',f.pg.clients[0]);
    const after=r43AfterImageHmac(secret,'clients',{...f.pg.clients[0],full_name:'Unlogged after signed update'});
    assert.notEqual(before,after);
  }finally{await f.close();}
});
test('R4.3 refuses unlogged rollback to the original SQLite value',async()=>{
  const f=await fixture();
  try{
    // The row now looks identical to the signed SQLite baseline, but the
    // latest audit still commits to a different PostgreSQL after-image.
    const revert=f.captures.map(c=>c.table.name==='clients'
      ?{...c,postgresRows:c.postgresRows.map(r=>({...r,full_name:'Original'}))}:c);
    assert.throws(()=>applyR43ShadowPatch(f.db,revert,{secret}),
      /latest signed after-image does not match PostgreSQL row/);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n,0);
  }finally{await f.close();}
});
test('R4.3 rejects a signed audit whose target is no longer present',async()=>{
  const f=await fixture();
  try{
    const orphan=f.captures.map(c=>c.table.name==='visits'
      ?{...c,postgresRows:[]}:c);
    assert.throws(()=>applyR43ShadowPatch(f.db,orphan,{secret}),
      /signed audit event targets a missing PostgreSQL row/);
  }finally{await f.close();}
});
test('R4.3 accepts strictly ordered audited updates and verifies final state',async()=>{
  const f=await fixture();
  try{
    const intermediate={...f.pg.clients[0],full_name:'Intermediate',updated_at:'2026-11-06T00:00:00.001Z'};
    const latest={...f.pg.clients[0],full_name:'Final audited change',updated_at:'2026-11-06T00:00:00.002Z'};
    const extra=event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4','update','clients',intermediate);
    const last=event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5','update','clients',latest);
    const captures=f.captures.map(c=>c.table.name==='clients'?{...c,postgresRows:[latest]}:
      c.table.name==='audit_log'?{...c,postgresRows:[...c.postgresRows,extra,last]}:c);
    const result=applyR43ShadowPatch(f.db,captures,{secret});
    assert.equal(result.shadowVerified,true);
    assert.equal(f.db.prepare('SELECT full_name FROM clients').get().full_name,'Final audited change');
    assert.equal(applyR43ShadowPatch(f.db,captures,{secret}).inserted,0);
  }finally{await f.close();}
});
test('R4.3 refuses contradictory same-version audited after-images',async()=>{
  const f=await fixture();
  try{
    const counterfeit=event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4','update','clients',
      {...f.pg.clients[0],full_name:'Other snapshot at same version'});
    const captures=f.captures.map(c=>c.table.name==='audit_log'?
      {...c,postgresRows:[...c.postgresRows,counterfeit]}:c);
    assert.throws(()=>applyR43ShadowPatch(f.db,captures,{secret}),
      /ambiguous same-version audit after-images/);
  }finally{await f.close();}
});
test('R4.3 HMAC checkpoints deduplicate replay after a restart',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'ox-r43-journal-'));
  const receipt={format:'osmanx-r43-shadow-replay-v1',syntheticOnly:true,readOnlySource:true,
    primarySqliteModified:false,productionCutoverAllowed:false,shadowAligned:true,
    checkpointHmac:randomBytes(32).toString('hex'),manifestSha256:randomBytes(32).toString('hex'),
    tenantToken:'example-only',firstPass:{inserted:5,updated:1},idempotentRetryVerified:true,finishedAt:TIME};
  try{
    const first=await appendR43Checkpoint({directory:folder,secret,receipt});
    const duplicate=await appendR43Checkpoint({directory:folder,secret,receipt:{...receipt,finishedAt:new Date().toISOString()}});
    assert.equal(first.sequence,1);assert.equal(duplicate.deduplicated,true);
    assert.equal((await verifyR43Checkpoints({directory:folder,secret})).entries,1);
    await assert.rejects(verifyR43Checkpoints({directory:folder,secret:randomBytes(32)}),/HMAC mismatch/);
    const file=join(folder,'replay.jsonl'),raw=await readFile(file,'utf8');
    await writeFile(file,raw.replace('"inserted":5','"inserted":50'));
    await assert.rejects(verifyR43Checkpoints({directory:folder,secret}),/digest changed/);
  }finally{await rm(folder,{recursive:true,force:true});}
});
test('R4.3 requires explicit synthetic opt-in and R4.2 trust gate',()=>{
  assert.equal(validateR43Options({}),null);
  assert.throws(()=>validateR43Options({OX_R43_SHADOW_REPLAY:'YES'}),/synthetic fixture/);
  assert.throws(()=>validateR43Options({OX_R43_SHADOW_REPLAY:'YES',OX_R43_CONFIRM_SYNTHETIC:'YES'}),/signed R4.2/);
  const opts=validateR43Options({OX_R43_SHADOW_REPLAY:'YES',OX_R43_CONFIRM_SYNTHETIC:'YES',
    OX_R42_PG_RECONCILIATION:'YES',OX_R40_PG_PREVIEW:'YES',
    OX_R42_JOURNAL_HMAC_KEY:secret.toString('hex'),OX_R40_PG_BUNDLE:'/example',
    OX_R40_PG_TRUST_KEY:'/external'});
  assert.equal(opts.shadowReplay,true);assert.equal(opts.productionCutoverAllowed,false);
});
