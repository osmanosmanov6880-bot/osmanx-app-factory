import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {signR61Approval} from '../src/migration/r61-dual-approval.mjs';
import {signR62FenceObservation}
  from '../src/migration/r62-fence-evidence.mjs';
import {signR62RestoreManifest,digestR62Checkpoint,shaR62}
  from '../src/migration/r62-restore-evidence.mjs';
import {examineR62S3Lineage} from '../src/migration/r62-s3-lineage.mjs';
import {evaluateR62FailoverDrill}
  from '../src/migration/r62-failover-drill-gate.mjs';
const TENANT='a'.repeat(24),INCIDENT='b'.repeat(32),CLUSTER='c'.repeat(24),
  PENDING='d'.repeat(64),COMMIT='e'.repeat(40),
  CHALLENGE='f'.repeat(64),LSN='0/AB2000',EPOCH=9;
const key=()=>generateKeyPairSync('ed25519');
const nonce=()=>randomBytes(16).toString('hex');
const verifyFields=()=>({format:'osmanx-r62-version-forensic-v1'});
function makeFixture({witnessVerified=true}={}){
  const now=Date.now(),earlier='a'.repeat(64);
  const row={tenant:TENANT,epoch:EPOCH,holder:'1'.repeat(24),
    lease_id:'2'.repeat(32),expires_at:new Date('2026-11-10T00:00:00Z'),
    pending_op:'3'.repeat(32),pending_sha:PENDING,
    pending_if_match:null,pending_create:true,pending_epoch:EPOCH,
    pending_before_version:'prior-v1',committed_op:'4'.repeat(32),
    committed_sha:earlier,committed_version:'prior-v1',committed_epoch:8};
  const dump=Buffer.from('R62 synthetic isolated logical backup');
  const backupKey=key();
  const restore={publicKey:backupKey.publicKey,logicalDump:dump,
    restoredRow:row,manifest:signR62RestoreManifest({
      privateKey:backupKey.privateKey,payload:{
        format:'osmanx-r62-logical-restore-v1',scope:'disposable-lab',
        tenantId:TENANT,walLsn:LSN,dumpSha256:shaR62(dump),
        checkpointSha256:digestR62Checkpoint(row,TENANT),
        nonce:nonce(),issuedAt:now-500,expiresAt:now+100000
      }
    })
  };
  const v=(versionId,sha256,isLatest)=>({
    versionId,sha256,isLatest,
    retentionMode:'COMPLIANCE',retainedUntil:'2090-01-01T00:00:00.000Z',
    lastModified:'2026-11-09T00:00:00.000Z'
  });
  const versionAnalysis={
    pending:{epoch:EPOCH,sha256:PENDING,beforeVersion:'prior-v1'},
    committed:{versionId:'prior-v1',sha256:earlier},
    forensics:{format:'osmanx-r60-version-forensic-v1',
      tenantId:TENANT,canUnquarantine:false,
      requiresManualWitnessReview:true,
      reviewedVersions:[v('pending-v2',PENDING,true),v('prior-v1',earlier,false)],
      matchingPendingVersions:['pending-v2']},
    witness:{entries:7,catalogSha256:PENDING},witnessVerified
  };
  const lineage=examineR62S3Lineage({tenantId:TENANT,...versionAnalysis});
  const sec=key(),rel=key();
  const reviewers={security_auditor:{role:'security',publicKey:sec.publicKey},
    reliability_auditor:{role:'reliability',publicKey:rel.publicKey}};
  const humanApprovals=[
    ['security','security_auditor',sec],
    ['reliability','reliability_auditor',rel]
  ].map(([role,reviewerId,kp])=>signR61Approval({
    privateKey:kp.privateKey,payload:{
      tenantId:TENANT,incidentId:INCIDENT,epoch:EPOCH,
      evidenceSha256:lineage.evidenceSha256,
      s3Version:lineage.selectedPendingVersionId,
      action:'investigate',role,reviewerId,nonce:nonce(),
      issuedAt:now-500,expiresAt:now+100000
    }
  }));
  const primaryFence={tenantId:TENANT,incidentId:INCIDENT,
    clusterId:CLUSTER,epoch:EPOCH,
    primaryNode:'pg-r59-primary',standbyNode:'pg-r59-standby',
    intentSha256:PENDING,challengeSha256:CHALLENGE,requiredLsn:LSN};
  const fenceKey=key(),observerKey=key();
  const observerDirectory={
    fence_observer:{role:'fence-observer',publicKey:fenceKey.publicKey},
    standby_observer:{role:'standby-observer',publicKey:observerKey.publicKey}
  };
  const observerPackets=[
    ['fence-observer','fence_observer',fenceKey],
    ['standby-observer','standby_observer',observerKey]
  ].map(([role,observerId,kp])=>signR62FenceObservation({
    privateKey:kp.privateKey,payload:{
      ...primaryFence,scope:'disposable-lab',
      primaryPowerState:'terminated',standbyInRecovery:true,
      standbyReplayVerified:true,role,observerId,
      nonce:nonce(),issuedAt:now-500,expiresAt:now+30000
    }
  }));
  const barrier={format:'osmanx-r62-sync-barrier-v1',
    tenantId:TENANT,challengeId:nonce(),proofSha256:CHALLENGE,
    observedLsn:LSN,freshSynchronousCommitConfirmed:true,
    standbyReplayConfirmed:true,classification:'fresh-wal-replay-observed'};
  const ciProvenance={format:'osmanx-r60-ci-provenance-gate-v1',
    tenantId:TENANT,commitSha:COMMIT,pinnedCiLabGatePassed:true,
    independentReviewerKeys:5,verifiedSourceJobs:5};
  const inputs={tenantId:TENANT,incidentId:INCIDENT,epoch:EPOCH,
    expectedCommitSha:COMMIT,primaryFence,observerPackets,
    observerDirectory,barrier,restore,versionAnalysis,humanApprovals,
    reviewers,ciProvenance,now:()=>now};
  return {inputs,now};
}
test('R6.2 all signed lab evidence yields review completeness but never promotion',()=>{
  const f=makeFixture(),result=evaluateR62FailoverDrill(f.inputs);
  assert.equal(result.labEvidenceComplete,true);
  assert.deepEqual(result.errors,[]);
  assert.equal(result.signedOldPrimaryObservations,2);
  assert.equal(result.signedReadOnlyHumanReviewers,2);
  assert.equal(result.logicalRestoreVerified,true);
  assert.equal(result.s3WormHistoryClass,'coherent-manual-review');
  assert.equal(result.canPromotePg,false);
  assert.equal(result.canClearPending,false);
  assert.equal(result.canMutateS3,false);
  assert.equal(result.mainMergeAllowed,false);
  assert.equal(result.industrialZeroRpoCertified,false);
  assert.equal(result.productionCutoverAllowed,false);
});
test('R6.2 a stale/partitioned WAL challenge or wrong pinned CI commit blocks lab readiness',()=>{
  const f=makeFixture();
  const barrier={...f.inputs.barrier,freshSynchronousCommitConfirmed:false,
    standbyReplayConfirmed:false,classification:'unconfirmed-synchronous-commit'};
  const status=evaluateR62FailoverDrill({...f.inputs,barrier});
  assert.equal(status.labEvidenceComplete,false);
  assert(status.errors.some(x=>x.includes('synchronous barrier')));
  const wrong=evaluateR62FailoverDrill({...f.inputs,
    ciProvenance:{...f.inputs.ciProvenance,commitSha:'f'.repeat(40)}});
  assert.equal(wrong.labEvidenceComplete,false);
  assert(wrong.errors.some(x=>x.includes('CI checks')));
});
test('R6.2 independent witness mismatch refuses even signed human approvals',()=>{
  const f=makeFixture({witnessVerified:false});
  const out=evaluateR62FailoverDrill(f.inputs);
  assert.equal(out.labEvidenceComplete,false);
  assert.equal(out.s3WormHistoryClass,'independent-witness-not-aligned');
  assert.equal(out.canClearPending,false);
});
test('R6.2 forged restore or altered offline human authorization aborts gate',()=>{
  const f=makeFixture();
  const forged={...f.inputs.restore,
    restoredRow:{...f.inputs.restore.restoredRow,pending_sha:'1'.repeat(64)}};
  assert.throws(()=>evaluateR62FailoverDrill({...f.inputs,restore:forged}),
    /restored checkpoint differs/);
  const reviews=f.inputs.humanApprovals.map(x=>({...x}));
  reviews[0].signature=reviews[1].signature;
  assert.throws(()=>evaluateR62FailoverDrill({...f.inputs,
    humanApprovals:reviews}),/invalid offline Ed25519 signature/);
});
test('R6.2 old-primary unsigned observation is never accepted as proof',()=>{
  const f=makeFixture();
  const evidence=f.inputs.observerPackets.map(x=>({...x}));
  evidence[0].primaryPowerState='unreachable';
  assert.throws(()=>evaluateR62FailoverDrill({
    ...f.inputs,observerPackets:evidence
  }),/non-terminated primary/);
});
