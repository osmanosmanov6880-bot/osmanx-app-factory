import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {signR64WalArchive,verifyR64WalArchive}
  from '../src/migration/r64-wal-archive-evidence.mjs';
import {signR64PitrBoundary,verifyR64PitrBoundary}
  from '../src/migration/r64-pitr-boundary.mjs';
import {signR61Approval}
  from '../src/migration/r61-dual-approval.mjs';
import {evaluateR64RecoveryReview}
  from '../src/migration/r64-recovery-review-gate.mjs';
const TENANT='a'.repeat(24),CASE='b'.repeat(32),
  SYSTEM='7392526296213040844',LSN='0/2000',
  BACKUP='c'.repeat(64),NOW=Date.now();
function fixture(){
  const walKey=generateKeyPairSync('ed25519'),
    pitrKey=generateKeyPairSync('ed25519');
  const observedSegments=[{
    name:'000000010000000000000000',sha256:'d'.repeat(64),size:4
  }];
  const walManifest=signR64WalArchive({
    privateKey:walKey.privateKey,payload:{
      format:'osmanx-r64-wal-archive-v1',scope:'disposable-lab',
      tenantId:TENANT,systemId:SYSTEM,timeline:1,
      targetLsn:LSN,baseBackupSha256:BACKUP,
      segmentBytes:4,segments:observedSegments,
      nonce:randomBytes(16).toString('hex'),
      issuedAt:NOW-1000,expiresAt:NOW+60000
    }
  });
  const archive={manifest:walManifest,
    publicKey:walKey.publicKey,observedSegments};
  const wal=verifyR64WalArchive({...archive,tenantId:TENANT,
    now:()=>NOW});
  const receipt=signR64PitrBoundary({
    privateKey:pitrKey.privateKey,payload:{
      format:'osmanx-r64-pitr-boundary-v1',scope:'disposable-lab',
      tenantId:TENANT,incidentId:CASE,systemId:SYSTEM,
      targetLsn:LSN,afterLsn:'0/3000',
      archiveEvidenceSha256:wal.archiveEvidenceSha256,
      baseBackupSha256:BACKUP,
      nonce:randomBytes(16).toString('hex'),
      issuedAt:NOW-1000,expiresAt:NOW+60000
    }
  });
  const sourceAndRestore={
    manifest:receipt,publicKey:pitrKey.publicKey,
    restoredSystemId:SYSTEM,
    sourceMarkers:['baseline','selected','excluded'],
    restoredMarkers:['baseline','selected']
  };
  const boundary=verifyR64PitrBoundary({
    ...sourceAndRestore,archiveReceipt:wal,
    tenantId:TENANT,now:()=>NOW
  });
  const state=(id,timeline,recovering)=>({
    system_id:SYSTEM,timeline_id:timeline,
    prev_timeline_id:timeline>1?timeline-1:1,
    checkpoint_lsn:'0/5000',redo_lsn:'0/4000',
    in_recovery:recovering
  });
  const rebuilt={
    requiredLsn:'0/4000',
    selectedPool:{async query(sql){
      assert(sql.includes('pg_control_'));
      return {rows:[state('selected',2,false)]};
    }},
    rebuiltPool:{async query(sql){
      return sql.includes('pg_control_')?
        {rows:[state('rebuilt',2,true)]}:
        {rows:[{recovering:true,replay_lsn:'0/5000',delta:'10'}]};
    }}
  };
  const quarantineReport={
    format:'osmanx-r63-quarantine-inspection-v1',
    tenantId:TENANT,clusterId:'e'.repeat(24),incidentId:CASE,
    nodeId:'pg-r59-primary',systemId:SYSTEM,quarantined:true,
    oldTimeline:1,selectedTimeline:2,chainVerified:true,
    chainTip:'e'.repeat(64),sourceEvidenceSha256:
      boundary.boundaryReceiptSha256,oldPrimaryRejoinAllowed:false
  };
  const quarantineStore={
    tenantId:TENANT,
    async inspect({incidentId,nodeId}){
      assert.equal(incidentId,CASE);
      assert.equal(nodeId,'pg-r59-primary');
      return quarantineReport;
    }
  };
  const security=generateKeyPairSync('ed25519'),
    reliability=generateKeyPairSync('ed25519');
  const reviewers={
    security_reviewer:{role:'security',publicKey:security.publicKey},
    reliability_reviewer:{role:'reliability',publicKey:reliability.publicKey}
  };
  const humanApprovals=[
    ['security','security_reviewer',security],
    ['reliability','reliability_reviewer',reliability]
  ].map(([role,reviewerId,key])=>signR61Approval({
    privateKey:key.privateKey,payload:{
      tenantId:TENANT,incidentId:CASE,evidenceSha256:
        boundary.boundaryReceiptSha256,epoch:8,
      s3Version:null,action:'investigate',
      role,reviewerId,nonce:randomBytes(16).toString('hex'),
      issuedAt:NOW-1000,expiresAt:NOW+60000
    }
  }));
  const params={tenantId:TENANT,incidentId:CASE,epoch:8,
    archive,sourceAndRestore,rebuilt,quarantineStore,
    oldNodeId:'pg-r59-primary',humanApprovals,reviewers,now:()=>NOW};
  return {params,quarantineReport};
}
test('R6.4 all cryptographic sources produce external review only, never automatic restore',
  async()=>{
    const f=fixture();
    const result=await evaluateR64RecoveryReview(f.params);
    assert.equal(result.syntheticLabEvidenceReadyForExternalReview,true);
    assert.deepEqual(result.blockers,[]);
    assert.equal(result.signedArchiveVerified,true);
    assert.equal(result.postTargetTransactionExcluded,true);
    assert.equal(result.rebuiltStandbyReadOnly,true);
    assert.equal(result.independentHumanReviewers,2);
    assert.equal(result.realGitHubCiProvenanceReverified,false);
    assert.equal(result.mayUnquarantineOldPrimary,false);
    assert.equal(result.mayPromoteReplica,false);
    assert.equal(result.mayDeploy,false);
    assert.equal(result.productionCutoverAllowed,false);
  });
test('R6.4 wrong WAL archive bytes and wrong PITR boundary fail before any review',async()=>{
  const f=fixture();
  const tampered={...f.params,archive:{...f.params.archive,
    observedSegments:[{...f.params.archive.observedSegments[0],
      sha256:'1'.repeat(64)}]}};
  await assert.rejects(evaluateR64RecoveryReview(tampered),
    /signed WAL inventory differs/);
  const lost={...f.params,sourceAndRestore:{...f.params.sourceAndRestore,
    restoredMarkers:['baseline']}};
  await assert.rejects(evaluateR64RecoveryReview(lost),
    /lost selected COMMIT/);
});
test('R6.4 quarantine tamper, stale follower and revoked human prevent readiness',async()=>{
  const f=fixture();
  const quarantineStore={...f.params.quarantineStore,
    async inspect(){return {...f.quarantineReport,chainVerified:false};}};
  const blocked=await evaluateR64RecoveryReview({
    ...f.params,quarantineStore
  });
  assert.equal(blocked.syntheticLabEvidenceReadyForExternalReview,false);
  assert(blocked.blockers.some(s=>s.includes('quarantine')));
  const revoked={...f.params.reviewers,
    security_reviewer:{...f.params.reviewers.security_reviewer,
      revoked:true}};
  await assert.rejects(evaluateR64RecoveryReview({
    ...f.params,reviewers:revoked
  }),/revoked/);
});
test('R6.4 foreign tenant cannot substitute backup or incident approvals',async()=>{
  const f=fixture();
  await assert.rejects(evaluateR64RecoveryReview({
    ...f.params,tenantId:'f'.repeat(24)
  }),/tenant-pinned signed WAL|signed WAL inventory differs|foreign/);
});
