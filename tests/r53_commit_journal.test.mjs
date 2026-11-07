import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {crmDb} from '../src/crm/db.mjs';
import {installR53Capture,readR53Committed,inspectR53Schema}
  from '../src/migration/r53-commit-journal.mjs';

const person='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const task='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const stamp='2026-11-06T00:00:00.000Z';
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'ox-r53-atomic-'));
  const db=crmDb(join(root,'source.sqlite'));
  return {db,close:async()=>{db.close();await rm(root,{recursive:true,force:true});}};
}
function add(db,{suffix=''}={}){
  db.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(person,'user'+suffix+'@example.test','Test User','synthetic-hash','manager',1,stamp);
  db.prepare('INSERT INTO clients(id,full_name,created_at,updated_at) VALUES(?,?,?,?)')
    .run(person,'Synthetic Client',stamp,stamp);
  db.prepare('INSERT INTO tasks(id,title,created_by,client_id,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(task,'Signed task',person,person,stamp,stamp);
}
test('R5.3 SQLite rollback removes business rows and their atomic change log',async()=>{
  const f=await fixture();try{
    const installed=installR53Capture(f.db,{syntheticOnly:true});
    assert(installed.trackedTables>=8);
    f.db.exec('BEGIN IMMEDIATE');
    add(f.db);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ox_r53_events').get().n,3);
    f.db.exec('ROLLBACK');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM tasks').get().n,0);
    assert.equal(readR53Committed(f.db,{syntheticOnly:true}).events.length,0);
  }finally{await f.close();}
});
test('R5.3 successive committed insert, update and delete are contiguous and complete',async()=>{
  const f=await fixture();try{
    installR53Capture(f.db,{syntheticOnly:true});
    f.db.exec('BEGIN IMMEDIATE');add(f.db);f.db.exec('COMMIT');
    f.db.prepare('UPDATE tasks SET status=? WHERE id=?').run('done',task);
    f.db.prepare('DELETE FROM tasks WHERE id=?').run(task);
    const j=readR53Committed(f.db,{syntheticOnly:true});
    assert.equal(j.events.length,5);
    assert.deepEqual(j.events.map(x=>x.seq),[1,2,3,4,5]);
    assert.equal(j.events[3].after.status,'done');
    assert.equal(j.events[4].operation,'delete');
    assert.equal(j.events[4].after,null);
    assert.equal(readR53Committed(f.db,{
      afterSequence:5,syntheticOnly:true}).events.length,0);
    assert.equal(j.schemaDigest,inspectR53Schema(f.db).digest);
  }finally{await f.close();}
});
test('R5.3 journal captures business writes after closing and reopening SQLite',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ox-r53-restart-')),path=join(root,'data.sqlite');
  try{
    const first=crmDb(path);installR53Capture(first,{syntheticOnly:true});first.close();
    const second=crmDb(path);
    try{
      second.prepare('INSERT INTO clients(id,full_name,created_at,updated_at) VALUES(?,?,?,?)')
        .run(person,'Persistent',stamp,stamp);
      assert.equal(readR53Committed(second,{syntheticOnly:true}).events.length,1);
    }finally{second.close();}
  }finally{await rm(root,{recursive:true,force:true});}
});
test('R5.3 journal blocks schema drift and unexpected business table before copying',async()=>{
  const f=await fixture();try{
    installR53Capture(f.db,{syntheticOnly:true});
    f.db.exec('ALTER TABLE tasks ADD COLUMN unsupported TEXT');
    assert.throws(()=>readR53Committed(f.db,{syntheticOnly:true}),/schema drift/);
  }finally{await f.close();}
  const x=await fixture();try{
    x.db.exec('CREATE TABLE private_data(id TEXT PRIMARY KEY, secret TEXT)');
    assert.throws(()=>installR53Capture(x.db,{syntheticOnly:true}),
      /unknown durable business table/);
  }finally{await x.close();}
});
test('R5.3 manually altered journal sequence is rejected',async()=>{
  const f=await fixture();try{
    installR53Capture(f.db,{syntheticOnly:true});
    f.db.prepare('INSERT INTO clients(id,full_name,created_at,updated_at) VALUES(?,?,?,?)')
      .run(person,'Client',stamp,stamp);
    f.db.exec('UPDATE ox_r53_events SET seq=5 WHERE seq=1');
    assert.throws(()=>readR53Committed(f.db,{syntheticOnly:true}),/missing, reordered|journal sequence gap/);
  }finally{await f.close();}
});
test('R5.3 cannot install capture on real database without synthetic-only opt-in',async()=>{
  const f=await fixture();try{
    assert.throws(()=>installR53Capture(f.db),/isolated synthetic/);
    assert.throws(()=>readR53Committed(f.db),/synthetic fixture/);
  }finally{await f.close();}
});

test('R5.3 journal reads and installation cannot nest inside an active SQLite write',async()=>{
  const f=await fixture();
  try{
    f.db.exec('BEGIN IMMEDIATE');
    assert.throws(()=>installR53Capture(f.db,{syntheticOnly:true}),
      /active business transaction/);
    f.db.exec('ROLLBACK');
    installR53Capture(f.db,{syntheticOnly:true});
    f.db.exec('BEGIN IMMEDIATE');
    assert.throws(()=>readR53Committed(f.db,{syntheticOnly:true}),
      /within another write transaction/);
    f.db.exec('ROLLBACK');
  }finally{await f.close();}
});

test('R5.3 dropping or substituting a CDC trigger fails closed before upload',async()=>{
  const f=await fixture();try{
    installR53Capture(f.db,{syntheticOnly:true});
    f.db.exec('DROP TRIGGER "ox_r53_tasks_insert"');
    assert.throws(()=>readR53Committed(f.db,{syntheticOnly:true}),
      /missing or additional CDC trigger/);
    f.db.exec('CREATE TRIGGER "ox_r53_tasks_insert" AFTER INSERT ON tasks BEGIN SELECT 1; END;');
    assert.throws(()=>readR53Committed(f.db,{syntheticOnly:true}),
      /CDC trigger SQL was changed/);
  }finally{await f.close();}
});
