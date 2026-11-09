import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {signR61Approval} from '../src/migration/r61-dual-approval.mjs';
import {signR62FenceObservation}
  from '../src/migration/r62-fence-evidence.mjs';
import {signR63PhysicalBackupEvidence,inspectR63PgBackupManifest}
  from '../src/migration/r63-physical-backup-evidence.mjs';
import {digestR62Checkpoint}
  from '../src/migration/r62-restore-evidence.mjs';
import {evaluateR63ManualRejoinReview}
  from '../src/migration/r63-manual-rejoin-review.mjs';
const TENANT='a'.repeat(24),CLUSTER='b'.repeat(24),
  INCIDENT='c'.repeat(32),SYS='7392526296213040844',
  SHA='d'.repeat(64),EVIDENCE='e'.repeat(64),COMMIT='f'.repeat(40),
  LSN='0/1000',NOW=Date.now(),NODE='pg-r59-primary',
  TARGET='pg-r59-standby',EPOCH=5,NONCE=()=>randomBytes(16).toString('hex'),
  kp=()=>generateKeyPairSync('ed25519');
function fixture(){
  const oldSnapshot={nodeId:NODE,systemId:SYS,
    timelineId:1,prevTimelineId:1,checkpointLsn:'0/3000',
    redoLsn:'0/1000',inRecovery:false,observedAt:NOW-1000};
  const selectedSnapshot={...oldSnapshot,nodeId:TARGET,
    timelineId:2,prevTimelineId:1,inRecovery:false};
  const fenceExpected={tenantId:TENANT,clusterId:CLUSTER,
    incidentId:INCIDENT,epoch:EPOCH,intentSha256:SHA,
    challengeSha256:'1'.repeat(64),requiredLsn:LSN,
    primaryNode:NODE,standbyNode:TARGET};
  const fo=kp(),so=kp();
  const fenceDirectory={
    fence_auditor:{role:'fence-observer',publicKey:fo.publicKey},
    standby_auditor:{role:'standby-observer',publicKey:so.publicKey}
  };
  const fencePackets=[
    ['fence-observer','fence_auditor',fo],
    ['standby-observer','standby_auditor',so]
  ].map(([role,observerId,key])=>signR62FenceObservation({
    privateKey:key.privateKey,payload:{
      ...fenceExpected,scope:'disposable-lab',
      primaryPowerState:'terminated',standbyInRecovery:true,
      standbyReplayVerified:true,role,observerId,
      nonce:NONCE(),issuedAt:NOW-1000,expiresAt:NOW+30000
    }
  }));
  const restoredRow={tenant:TENANT,epoch:EPOCH,holder:null,
    lease_id:null,expires_at:null,pending_op:'3'.repeat(32),
    pending_sha:SHA,pending_if_match:null,pending_create:true,
    pending_epoch:EPOCH,pending_before_version:null,
    committed_op:null,committed_sha:null,committed_version:null,
    committed_epoch:null};
  const bytes=Buffer.from(JSON.stringify({
    'PostgreSQL-Backup-Manifest-Version':1,
    Files:[{Path:'base/1/123',Size:8192}],
    'WAL-Ranges':[{'Timeline':1,'Start-LSN':LSN,'End-LSN':'0/3000'}],
    'Manifest-Checksum':'2'.repeat(64)
  }));
  const backupKey=kp();
  const physicalBackup={publicKey:backupKey.publicKey,
    restoredRow,restoredSystemId:SYS,restoredTimeline:1,
    manifestBytes:bytes,verifierExitCode:0,
    manifest:signR63PhysicalBackupEvidence({
      privateKey:backupKey.privateKey,payload:{
        format:'osmanx-r63-physical-backup-v1',scope:'disposable-lab',
        tenantId:TENANT,systemId:SYS,timeline:1,sourceLsn:LSN,
        manifestSha256:inspectR63PgBackupManifest(bytes).backupManifestSha256,
        checkpointSha256:digestR62Checkpoint(restoredRow,TENANT),
        verifierTool:'pg_verifybackup',nonce:NONCE(),
        issuedAt:NOW-1000,expiresAt:NOW+30000
      }
    })
  };
  const quarantineInspection={
    format:'osmanx-r63-quarantine-inspection-v1',tenantId:TENANT,
    clusterId:CLUSTER,incidentId:INCIDENT,nodeId:NODE,
    systemId:SYS,oldTimeline:1,selectedTimeline:2,chainVerified:true,
    quarantined:true,sourceEvidenceSha256:EVIDENCE,
    oldPrimaryRejoinAllowed:false
  };
  const security=kp(),reliability=kp();
  const reviewers={
    security_reviewer:{role:'security',publicKey:security.publicKey},
    reliability_reviewer:{role:'reliability',publicKey:reliability.publicKey}
  };
  const approvals=[
    ['security','security_reviewer',security],
    ['reliability','reliability_reviewer',reliability]
  ].map(([role,reviewerId,k])=>signR61Approval({
    privateKey:k.privateKey,payload:{tenantId:TENANT,
      incidentId:INCIDENT,evidenceSha256:EVIDENCE,epoch:EPOCH,
      s3Version:null,action:'investigate',role,reviewerId,
      nonce:NONCE(),issuedAt:NOW-1000,expiresAt:NOW+30000}
  }));
  const ciProvenance={format:'osmanx-r60-ci-provenance-gate-v1',
    tenantId:TENANT,commitSha:COMMIT,
    pinnedCiLabGatePassed:true,verifiedSourceJobs:5,
    independentReviewerKeys:5};
  return {
    tenantId:TENANT,clusterId:CLUSTER,incidentId:INCIDENT,
    epoch:EPOCH,commitSha:COMMIT,
    oldSnapshot,selectedSnapshot,requiredSystemId:SYS,
    fenceExpected,fencePackets,fenceDirectory,
    quarantineInspection,physicalBackup,approvals,reviewers,
    ciProvenance,now:()=>NOW
  };
}
test('R6.3 all five signed synthetic sources permit only human review, never rejoin',()=>{
  const report=evaluateR63ManualRejoinReview(fixture());
  assert.equal(report.syntheticReadinessForExternalReviewer,true);
  assert.deepEqual(report.errors,[]);
  assert.equal(report.physicalBackupRestored,true);
  assert.equal(report.timelineClassification,'old-primary-timeline-stale');
  assert.equal(report.mayUnquarantineOldPrimary,false);
  assert.equal(report.mayRunPgRewind,false);
  assert.equal(report.mayIssuePgPromote,false);
  assert.equal(report.industrialZeroRpoCertified,false);
  assert.equal(report.productionCutoverAllowed,false);
  assert.match(report.reportSha256,/^[a-f0-9]{64}$/);
});
test('R6.3 fork still live or wrong pinned CI never passes release evidence',()=>{
  const one=fixture();
  one.selectedSnapshot={...one.selectedSnapshot,timelineId:1};
  const refused=evaluateR63ManualRejoinReview(one);
  assert.equal(refused.syntheticReadinessForExternalReviewer,false);
  assert(refused.errors.some(x=>x.includes('successor timeline')));
  const another=fixture();
  another.ciProvenance={...another.ciProvenance,commitSha:'1'.repeat(40)};
  assert.equal(evaluateR63ManualRejoinReview(
    another).syntheticReadinessForExternalReviewer,false);
});
test('R6.3 tampered old-primary isolation or backup signature refuses review',()=>{
  const f=fixture(),fake=f.fencePackets.map(x=>({...x}));
  fake[0].primaryPowerState='unreachable';
  assert.throws(()=>evaluateR63ManualRejoinReview({
    ...f,fencePackets:fake
  }),/non-terminated primary/);
  const restore=fixture();
  restore.physicalBackup={...restore.physicalBackup,
    restoredRow:{...restore.physicalBackup.restoredRow,
      pending_sha:'2'.repeat(64)}};
  assert.throws(()=>evaluateR63ManualRejoinReview(restore),
    /restored system, timeline or fenced checkpoint differs/);
});
test('R6.3 mutable quarantine report, revoked humans and cross-tenant data rejected',()=>{
  const f=fixture();
  const wrong={...f,quarantineInspection:{
    ...f.quarantineInspection,chainVerified:false
  }};
  assert.equal(evaluateR63ManualRejoinReview(
    wrong).syntheticReadinessForExternalReviewer,false);
  const revoked={...f,reviewers:{
    ...f.reviewers,security_reviewer:{
      ...f.reviewers.security_reviewer,revoked:true
    }
  }};
  assert.throws(()=>evaluateR63ManualRejoinReview(revoked),/revoked/);
  assert.throws(()=>evaluateR63ManualRejoinReview({
    ...f,tenantId:'../other'
  }),/strict lab identity/);
});
