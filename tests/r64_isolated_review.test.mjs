import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes} from 'node:crypto';
import {makeR64WalSegmentRecord,signR64WalArchive,verifyR64WalArchive}
  from '../src/migration/r64-wal-archive.mjs';
import {signR64RecoveryBudget}
  from '../src/migration/r64-recovery-budget.mjs';
import {signR61Approval}
  from '../src/migration/r61-dual-approval.mjs';
import {assessR64IsolatedRecovery}
  from '../src/migration/r64-isolated-recovery-review.mjs';
const TENANT='a'.repeat(24),INCIDENT='b'.repeat(32),
  COMMIT='c'.repeat(40),SYSTEM='7392526296213040844',
  BACKUP='d'.repeat(64),TARGET='0/01000000',NOW=Date.now(),
  pre='e'.repeat(32),post='f'.repeat(32),PRE_SHA='1'.repeat(64),
  POST_SHA='2'.repeat(64);
const hash=x=>createHash('sha256').update(x).digest('hex');
function db(events,timeline){
  return {async query(sql,args){
    if(sql.includes('pg_control_system()'))return {rows:[{
      recovering:false,system_id:SYSTEM,timeline
    }]};
    assert(sql.startsWith('SELECT event_id,payload_sha'));
    return {rows:[...events].filter(([id])=>args[1].includes(id))
      .map(([id,sha])=>({event_id:id,payload_sha:sha}))};
  }};
}
async function fixture(){
  const keys=generateKeyPairSync('ed25519');
  const segment=Buffer.alloc(16*1024*1024,0x2a),
    name='000000010000000000000001';
  const archive={packet:signR64WalArchive({
    privateKey:keys.privateKey,payload:{
      format:'osmanx-r64-wal-archive-v1',scope:'disposable-lab',
      tenantId:TENANT,systemId:SYSTEM,timeline:1,
      baseBackupSha256:BACKUP,targetLsn:TARGET,
      segments:[makeR64WalSegmentRecord({name,bytes:segment})],
      issuer:'wal_auditor',nonce:randomBytes(16).toString('hex'),
      issuedAt:NOW-1000,expiresAt:NOW+60000
    }
  }),reader:async()=>segment,publicKey:keys.publicKey,
    systemId:SYSTEM,baseBackupSha256:BACKUP};
  const wal=await verifyR64WalArchive({
    ...archive,tenantId:TENANT,now:()=>NOW
  });
  const budgetKey=generateKeyPairSync('ed25519');
  const budget={publicKey:budgetKey.publicKey,
    packet:signR64RecoveryBudget({
      privateKey:budgetKey.privateKey,payload:{
        format:'osmanx-r64-recovery-budget-v1',scope:'disposable-lab',
        tenantId:TENANT,recoveryId:randomBytes(16).toString('hex'),
        archiveInventorySha256:wal.archiveInventorySha256,
        checkpointSha256:BACKUP,targetLsn:TARGET,
        sourceCommittedEvents:3,targetCommittedEvents:2,
        recoveredEvents:2,startedAt:NOW-10000,readyAt:NOW,
        budgetRtoMs:30000,budgetExcludedEvents:1,
        reporterId:'budget_auditor',nonce:randomBytes(16).toString('hex'),
        issuedAt:NOW-1000,expiresAt:NOW+60000
      }
    })
  };
  const old={nodeId:'pg-r59-primary',systemId:SYSTEM,
    timelineId:1,prevTimelineId:1,checkpointLsn:'0/3000',
    redoLsn:'0/2000',inRecovery:false,observedAt:NOW-1000};
  const newer={...old,nodeId:'pg-r59-standby',timelineId:2,
    prevTimelineId:1,inRecovery:false};
  const rebootstrap={
    oldPrimarySnapshot:old,selectedPrimarySnapshot:newer,
    requiredSystemId:SYSTEM,oldPrimaryRunning:false,
    rebuiltReplica:{nodeId:'pg-r64-rebuilt',systemId:SYSTEM,
      timeline:2,inRecovery:true,replayLsn:'0/3000'},
    sourceProbeHash:'a'.repeat(64),replicaProbeHash:'a'.repeat(64)
  };
  const pointInTime={
    source:db([[pre,PRE_SHA],[post,POST_SHA]],1),
    restored:db([[pre,PRE_SHA]],2),
    targetName:'r64_marker_integrated',preId:pre,postId:post,
    preSha256:PRE_SHA,postSha256:POST_SHA,
    expectedSystemId:SYSTEM,restoreStartedAt:NOW-10000
  };
  const evidenceSha256=hash(JSON.stringify({
    tenantId:TENANT,incidentId:INCIDENT,epoch:5,pinnedCommitSha:COMMIT,
    archive:wal.archiveInventorySha256,pitrTarget:pointInTime.targetName,
    recoveryMs:10000,count:1,rebuild:'isolated-rebootstrap-demonstrated'
  }));
  const security=generateKeyPairSync('ed25519'),
    reliability=generateKeyPairSync('ed25519');
  const reviewers={
    security_operator:{role:'security',publicKey:security.publicKey},
    reliability_operator:{role:'reliability',publicKey:reliability.publicKey}
  };
  const approvals=[
    ['security','security_operator',security],
    ['reliability','reliability_operator',reliability]
  ].map(([role,reviewerId,key])=>signR61Approval({
    privateKey:key.privateKey,payload:{
      tenantId:TENANT,incidentId:INCIDENT,epoch:5,evidenceSha256,
      s3Version:null,action:'investigate',role,reviewerId,
      nonce:randomBytes(16).toString('hex'),
      issuedAt:NOW-1000,expiresAt:NOW+60000
    }
  }));
  return {tenantId:TENANT,incidentId:INCIDENT,epoch:5,
    pinnedCommitSha:COMMIT,archive,pointInTime,rebootstrap,
    budget,approvals,reviewers,now:()=>NOW};
}
test('R6.4 complete synthetic five-source dossier only permits independent human investigation',
  async()=>{
    const f=await fixture(),r=await assessR64IsolatedRecovery(f);
    assert.equal(r.syntheticLabEvidenceComplete,true);
    assert.equal(r.trueNamedPitrBeforeAfterVerified,true);
    assert.equal(r.postTargetExcludedEvents,1);
    assert.equal(r.rebuiltFollowerReceivedPostBackupWal,true);
    assert.equal(r.signedReviewers,2);
    assert.equal(r.mayDeploy,false);
    assert.equal(r.mayRejoinOldPrimary,false);
    assert.equal(r.productionCutoverAllowed,false);
  });
test('R6.4 forbidden old primary and unsafe recovery budget prevent lab readiness',
  async()=>{
    const f=await fixture();
    const rejoin=await assessR64IsolatedRecovery({
      ...f,rebootstrap:{...f.rebootstrap,oldPrimaryRunning:true}
    });
    assert.equal(rejoin.syntheticLabEvidenceComplete,false);
    assert(rejoin.missing.some(x=>x.includes('follower rebuild')));
    const slow=await fixture();
    slow.budget={...slow.budget,packet:{...slow.budget.packet,
      budgetRtoMs:1000}};
    await assert.rejects(assessR64IsolatedRecovery(slow),
      /reporter signature not valid/);
  });
test('R6.4 forged reviewer signature, missing WAL and false late-commit state fail closed',
  async()=>{
    const f=await fixture();
    const signatures=f.approvals.map(x=>({...x}));
    signatures[0].signature=signatures[1].signature;
    await assert.rejects(assessR64IsolatedRecovery({
      ...f,approvals:signatures
    }),/invalid offline Ed25519 signature/);
    const missing=await fixture();
    missing.archive={...missing.archive,reader:async()=>undefined};
    await assert.rejects(assessR64IsolatedRecovery(missing),
      /missing, truncated or tampered WAL segment/);
    const fork=await fixture();
    fork.pointInTime={...fork.pointInTime,
      restored:db([[pre,PRE_SHA],[post,POST_SHA]],2)};
    await assert.rejects(assessR64IsolatedRecovery(fork),
      /post-target commit/);
  });
