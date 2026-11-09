import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {signR64RecoveryBudget,verifyR64RecoveryBudget}
  from '../src/migration/r64-recovery-budget.mjs';
const TENANT='a'.repeat(24),ARCHIVE='b'.repeat(64),
  CHECKPOINT='c'.repeat(64),TARGET='0/1020000';
function fixture(){
  const key=generateKeyPairSync('ed25519'),now=Date.now();
  const payload={format:'osmanx-r64-recovery-budget-v1',
    scope:'disposable-lab',tenantId:TENANT,recoveryId:randomBytes(16).toString('hex'),
    archiveInventorySha256:ARCHIVE,checkpointSha256:CHECKPOINT,
    targetLsn:TARGET,sourceCommittedEvents:3,targetCommittedEvents:2,
    recoveredEvents:2,startedAt:now-10000,readyAt:now-1000,
    budgetRtoMs:30000,budgetExcludedEvents:1,
    reporterId:'independent_reviewer',
    nonce:randomBytes(16).toString('hex'),
    issuedAt:now-1000,expiresAt:now+30000};
  const packet=signR64RecoveryBudget({payload,privateKey:key.privateKey});
  const check=(args={})=>verifyR64RecoveryBudget({
    packet,publicKey:key.publicKey,tenantId:TENANT,
    archiveInventorySha256:ARCHIVE,checkpointSha256:CHECKPOINT,
    targetLsn:TARGET,now:()=>now,...args
  });
  return {now,payload,packet,key,check};
}
test('R6.4 signed lab RTO and intentional one-event PITR exclusion never certify industrial RPO',
  ()=>{
    const f=fixture(),receipt=f.check();
    assert.equal(receipt.labBudgetSatisfied,true);
    assert.equal(receipt.laboratoryRecoveryMs,9000);
    assert.equal(receipt.deliberatelyExcludedPostTargetEvents,1);
    assert.equal(receipt.industrialRtoCertified,false);
    assert.equal(receipt.industrialRpoCertified,false);
    assert.equal(receipt.productionCutoverAllowed,false);
  });
test('R6.4 slow restore and over-budget exclusion cause closed lab budget',()=>{
  const f=fixture(),slow={...f.payload,readyAt:f.now+60000},
    slowPacket=signR64RecoveryBudget({
      payload:slow,privateKey:f.key.privateKey});
  assert.equal(f.check({packet:slowPacket}).labBudgetSatisfied,false);
  const losses={...f.payload,sourceCommittedEvents:4};
  const packet=signR64RecoveryBudget({
    payload:losses,privateKey:f.key.privateKey});
  assert.equal(f.check({packet}).labBudgetSatisfied,false);
});
test('R6.4 missing pre-target events, zero post-target and impossible count are not evidence',
  ()=>{
    const f=fixture();
    for(const bad of [
      {...f.payload,targetCommittedEvents:1,recoveredEvents:2},
      {...f.payload,sourceCommittedEvents:2,recoveredEvents:2},
      {...f.payload,sourceCommittedEvents:1},
      {...f.payload,readyAt:f.payload.startedAt-1}
    ]){
      assert.throws(()=>signR64RecoveryBudget({
        payload:bad,privateKey:f.key.privateKey
      }),/R6.4 recovery budget refused/);
    }
  });
test('R6.4 forged time, old report, wrong WAL archive and foreign tenant rejected',
  ()=>{
    const f=fixture();
    assert.throws(()=>f.check({
      packet:{...f.packet,sourceCommittedEvents:8}
    }),/signature not valid/);
    assert.throws(()=>f.check({now:()=>f.now+100000}),/expired/);
    assert.throws(()=>f.check({archiveInventorySha256:'f'.repeat(64)}),
      /foreign or noncanonical/);
    assert.throws(()=>f.check({tenantId:'d'.repeat(24)}),
      /foreign or noncanonical/);
  });
