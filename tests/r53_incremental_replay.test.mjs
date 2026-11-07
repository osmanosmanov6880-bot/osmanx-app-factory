import test from 'node:test';
import assert from 'node:assert/strict';
import {backup} from 'node:sqlite';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {crmDb} from '../src/crm/db.mjs';
import {installR53Capture} from '../src/migration/r53-commit-journal.mjs';
import {createR48WitnessClient,createR48WitnessReceiver}
  from '../src/migration/r48-witness.mjs';
import {publishR53Incremental,readR53AuthenticatedStream,r53WitnessTenant}
  from '../src/migration/r53-incremental.mjs';
import {restoreR53Incremental} from '../src/migration/r53-replay.mjs';

const projectId='11111111-1111-4111-8111-111111111111';
const userId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const clientId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const taskId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const paymentId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const stamp='2026-11-06T00:00:00.000Z';
const baselineArchiveId='e'.repeat(32);
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'ox-r53-stream-'));
  const sourceDb=crmDb(join(root,'source.sqlite'));
  sourceDb.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(userId,'test@example.test','Sample user','synthetic-only','manager',1,stamp);
  sourceDb.prepare('INSERT INTO clients(id,full_name,created_at,updated_at) VALUES(?,?,?,?)')
    .run(clientId,'Original',stamp,stamp);
  const baseline=join(root,'baseline.sqlite');
  await backup(sourceDb,baseline);await chmod(baseline,0o600);
  installR53Capture(sourceDb,{syntheticOnly:true});
  const vault={projectId,manifestSha256:'a'.repeat(64),catalogKey:randomBytes(32)};
  const deltaKey=randomBytes(32);
  const objects=new Map(),failure={blockWorm:false};
  const remote={
    async assertBucketControls(){return {versioningEnabled:true,objectLockEnabled:true};},
    async put(key,bytes){objects.set(key,Buffer.from(bytes));return true;},
    async get(key){
      if(!objects.has(key))throw Error('R4.8 S3 denied: GET status 404');
      return Buffer.from(objects.get(key));
    },
    async inspectR49Worm(key){
      if(failure.blockWorm)throw Error('R4.8 S3 denied: lost Object Lock');
      if(!objects.has(key))throw Error('missing WORM object');
      return {objectLockVerified:true,retentionMode:'COMPLIANCE',
        versioned:true,versionId:'synthetic-v1'};
    }
  };
  const token=randomBytes(32).toString('hex'),secret=randomBytes(32);
  const witnessServer=createServer(createR48WitnessReceiver({
    root:join(root,'witness'),token,secret
  }));
  await new Promise(ok=>witnessServer.listen(0,'127.0.0.1',ok));
  const witness=createR48WitnessClient({
    endpoint:'http://127.0.0.1:'+witnessServer.address().port+'/',
    token,secret,tenant:r53WitnessTenant(vault.catalogKey,projectId),
    allowSyntheticLoopback:true});
  const baseRestoreReceipt={format:'osmanx-r49-offline-dr-v1',
    outputFile:baseline,archiveId:baselineArchiveId,readOnlySource:true,
    catalogWitnessVerified:true,objectLockVerified:true,
    signedTablesVerified:8,productionCutoverAllowed:false};
  const args={vault,remote,witness,deltaKey,baselineArchiveId};
  return {root,sourceDb,objects,failure,args,baseline,baseRestoreReceipt,
    close:async()=>{
      sourceDb.close();await new Promise(ok=>witnessServer.close(ok));
      await rm(root,{recursive:true,force:true});
    }};
}
function postBackupWrites(db){
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare('INSERT INTO tasks(id,title,client_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(taskId,'Committed after signed snapshot',clientId,userId,stamp,stamp);
    db.prepare('UPDATE clients SET notes=? WHERE id=?')
      .run('Updated after backup',clientId);
    db.prepare('INSERT INTO payments(id,client_id,amount_minor,currency,method,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(paymentId,clientId,12500,'RUB','terminal','paid',userId,stamp,stamp);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
test('R5.3 encrypts only new committed rows and restores task/client/payment updates',async()=>{
  const f=await fixture();try{
    postBackupWrites(f.sourceDb);
    const published=await publishR53Incremental({sourceDb:f.sourceDb,...f.args});
    assert.equal(published.publishedEvents,3);
    assert.equal(published.totalCommittedEvents,3);
    assert.equal(published.encryptedReadbackVerified,true);
    assert.equal(published.pendingUnreplicatedEvents,false);
    const ciphertext=f.objects.get('r53/segments/'+
      [...f.objects.keys()].find(x=>x.startsWith('r53/segments/')).split('/')[2].replace('.oxd','')+'.oxd');
    assert(ciphertext&&!ciphertext.toString('utf8').includes('Committed after signed snapshot'));
    const result=await restoreR53Incremental({
      baseRestoreReceipt:f.baseRestoreReceipt,
      recoveryDirectory:join(f.root,'restored'),...f.args
    });
    assert.equal(result.appliedCommittedChanges,3);
    assert.equal(result.lostFromCoveredCommittedSequence,0);
    assert.equal(result.idempotentRetryVerified,true);
    assert.equal(result.productionCutoverAllowed,false);
    const db=crmDb(result.outputFile);
    try{
      assert.equal(db.prepare('SELECT title FROM tasks WHERE id=?').get(taskId).title,
        'Committed after signed snapshot');
      assert.equal(db.prepare('SELECT notes FROM clients WHERE id=?').get(clientId).notes,
        'Updated after backup');
      assert.equal(db.prepare('SELECT amount_minor FROM payments WHERE id=?')
        .get(paymentId).amount_minor,12500);
    }finally{db.close();}
    const duplicate=await publishR53Incremental({sourceDb:f.sourceDb,...f.args});
    assert.equal(duplicate.publishedEvents,0);
    assert.equal(duplicate.totalCommittedEvents,3);
  }finally{await f.close();}
});
test('R5.3 second incremental segment cannot be replaced with an older valid pointer',async()=>{
  const f=await fixture();try{
    postBackupWrites(f.sourceDb);
    await publishR53Incremental({sourceDb:f.sourceDb,...f.args});
    const oldHead=Buffer.from(f.objects.get('r53/head.json'));
    f.sourceDb.prepare('UPDATE tasks SET status=? WHERE id=?').run('done',taskId);
    const second=await publishR53Incremental({sourceDb:f.sourceDb,...f.args});
    assert.equal(second.publishedEvents,1);
    assert.equal(second.totalCommittedEvents,4);
    const latest=Buffer.from(f.objects.get('r53/head.json'));
    const history=await readR53AuthenticatedStream(f.args);
    assert.equal(history.events.length,4);
    f.objects.set('r53/head.json',oldHead);
    await assert.rejects(readR53AuthenticatedStream(f.args),
      /older than or different from independent witness/);
    f.objects.set('r53/head.json',latest);
    const restored=await restoreR53Incremental({
      baseRestoreReceipt:f.baseRestoreReceipt,
      recoveryDirectory:join(f.root,'recovered-second'),...f.args
    });
    const db=crmDb(restored.outputFile);
    try{assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(taskId).status,'done');}
    finally{db.close();}
  }finally{await f.close();}
});
test('R5.3 missing or tampered S3 WORM segment rejects recovery',async()=>{
  const f=await fixture();try{
    postBackupWrites(f.sourceDb);
    await publishR53Incremental({sourceDb:f.sourceDb,...f.args});
    const segment=[...f.objects.keys()].find(x=>x.startsWith('r53/segments/'));
    const bytes=Buffer.from(f.objects.get(segment));
    f.objects.set(segment,Buffer.from('{"tampered":true}'));
    await assert.rejects(readR53AuthenticatedStream(f.args),/digest mismatch/);
    f.objects.set(segment,bytes);
    f.failure.blockWorm=true;
    await assert.rejects(readR53AuthenticatedStream(f.args),/lost Object Lock/);
  }finally{await f.close();}
});
test('R5.3 incorrect delta encryption key or different signed baseline fails closed',async()=>{
  const f=await fixture();try{
    postBackupWrites(f.sourceDb);
    await publishR53Incremental({sourceDb:f.sourceDb,...f.args});
    await assert.rejects(readR53AuthenticatedStream({
      ...f.args,deltaKey:randomBytes(32)}),/invalid HMAC/);
    await assert.rejects(restoreR53Incremental({
      ...f.args,baseRestoreReceipt:{...f.baseRestoreReceipt,archiveId:'d'.repeat(32)},
      recoveryDirectory:join(f.root,'bad-baseline')
    }),/wrong baseline|invalid HMAC/);
  }finally{await f.close();}
});
