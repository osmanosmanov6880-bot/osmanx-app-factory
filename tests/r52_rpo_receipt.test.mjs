import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectR52SyntheticTransactionLoss,enforceR52SyntheticLossBudget}
  from '../src/migration/r52-rpo.mjs';
import {writeR52RehearsalReceipt,verifyR52RehearsalReceipt}
  from '../src/migration/r52-receipt.mjs';

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'ox-r52-rpo-'));
  const primary=join(root,'primary.sqlite'),recovered=join(root,'restored.sqlite');
  for(const path of [primary,recovered]){
    const db=new DatabaseSync(path);
    db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY)');
    db.close();
  }
  const id=randomUUID();
  const db=new DatabaseSync(primary);
  db.prepare('INSERT INTO tasks(id) VALUES(?)').run(id);db.close();
  return {root,primary,recovered,id,close:()=>rm(root,{recursive:true,force:true})};
}
const fingerprint='c'.repeat(64);
function matrix(){
  return {format:'osmanx-r52-failure-matrix-v1',
    syntheticOnly:true,failedServicesExercised:4,
    everyFaultDeniedReadiness:true,everyRecoveryRevalidated:true,
    sourceFingerprintUnchanged:true,productionCutoverAllowed:false,
    serviceResults:['storage','backupWitness','auditAnchor','alerts']
      .map(service=>({service,failClosed:true,restored:true,recoveryMs:11,
        postRestoreRevalidated:true}))};
}
test('R5.2 committed post-backup task is missing from sealed recovered SQLite',async()=>{
  const f=await fixture();
  try{
    const result=inspectR52SyntheticTransactionLoss({
      sourcePath:f.primary,recoveredPath:f.recovered,
      committedAfterBackupIds:[f.id],syntheticOnly:true,maxLostTransactions:0});
    assert.equal(result.committedAfterBackup,1);
    assert.equal(result.lostSinceBackup,1);
    assert.equal(result.withinTestLossBudget,false);
    assert.equal(result.transactionLevelRpoSecondsMeasured,false);
    assert.throws(()=>enforceR52SyntheticLossBudget(result),/committed synthetic transactions missing/);
  }finally{await f.close();}
});
test('R5.2 newer verified recovery contains the committed transaction',async()=>{
  const f=await fixture();
  try{
    const db=new DatabaseSync(f.recovered);
    db.prepare('INSERT INTO tasks(id) VALUES(?)').run(f.id);db.close();
    const result=inspectR52SyntheticTransactionLoss({
      sourcePath:f.primary,recoveredPath:f.recovered,
      committedAfterBackupIds:[f.id],syntheticOnly:true,maxLostTransactions:0});
    assert.equal(result.lostSinceBackup,0);
    assert.equal(enforceR52SyntheticLossBudget(result).testLossBudgetAccepted,true);
  }finally{await f.close();}
});
test('R5.2 never counts an uncommitted source marker as lost committed work',async()=>{
  const f=await fixture();
  try{
    await assert.rejects(async()=>inspectR52SyntheticTransactionLoss({
      sourcePath:f.primary,recoveredPath:f.recovered,
      committedAfterBackupIds:[randomUUID()],syntheticOnly:true}),
      /not committed in primary/);
  }finally{await f.close();}
});
test('R5.2 HMAC report discloses loss truthfully and cannot approve production',async()=>{
  const f=await fixture();
  try{
    const rpo=inspectR52SyntheticTransactionLoss({
      sourcePath:f.primary,recoveredPath:f.recovered,committedAfterBackupIds:[f.id],
      syntheticOnly:true,maxLostTransactions:0});
    const opts={directory:join(f.root,'receipt'),tenantToken:'a'.repeat(24),
      key:randomBytes(32)};
    const saved=await writeR52RehearsalReceipt(opts,{matrix:matrix(),rpo});
    const report=await verifyR52RehearsalReceipt(opts,saved.receiptId);
    assert.equal(report.reportedLostTransactions,1);
    assert.equal(report.syntheticLossBudgetMet,false);
    assert.equal(report.fourServiceFaultsVerified,true);
    assert.equal(report.productionCutoverAllowed,false);
    const raw=await readFile(saved.path,'utf8');
    assert.equal(raw.includes(f.primary),false);
    assert.equal(raw.includes(f.id),false);
  }finally{await f.close();}
});
test('R5.2 modified or re-keyed receipt is rejected',async()=>{
  const f=await fixture();
  try{
    const rpo=inspectR52SyntheticTransactionLoss({
      sourcePath:f.primary,recoveredPath:f.recovered,committedAfterBackupIds:[f.id],
      syntheticOnly:true,maxLostTransactions:0});
    const opts={directory:join(f.root,'receipt'),tenantToken:'a'.repeat(24),
      key:randomBytes(32)};
    const saved=await writeR52RehearsalReceipt(opts,{matrix:matrix(),rpo});
    await assert.rejects(verifyR52RehearsalReceipt({...opts,key:randomBytes(32)},
      saved.receiptId),/rehearsal HMAC changed/);
    await writeFile(saved.path,(await readFile(saved.path,'utf8')).replace(
      '"lostSinceBackup":1','"lostSinceBackup":0'));
    await assert.rejects(verifyR52RehearsalReceipt(opts,saved.receiptId),
      /rehearsal HMAC changed/);
  }finally{await f.close();}
});
test('R5.2 report cannot be fabricated with only three verified service faults',async()=>{
  const f=await fixture();
  try{
    const rpo=inspectR52SyntheticTransactionLoss({
      sourcePath:f.primary,recoveredPath:f.recovered,
      committedAfterBackupIds:[f.id],syntheticOnly:true});
    const partial={...matrix(),failedServicesExercised:3};
    await assert.rejects(writeR52RehearsalReceipt({directory:join(f.root,'receipt'),
      key:randomBytes(32),tenantToken:'a'.repeat(24)},{matrix:partial,rpo}),
    /incomplete four-service fault drill/);
  }finally{await f.close();}
});
