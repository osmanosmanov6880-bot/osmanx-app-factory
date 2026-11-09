// R6.2 five-source FAIL-CLOSED DRILL review. No execution actions.
// Validates actual Ed25519 offline observations/approvals and signed
// logical restore; returns readiness for HUMAN examination only.
import {createHash} from 'node:crypto';
import {inspectR62FenceObservations} from './r62-fence-evidence.mjs';
import {verifyR61DualApprovals} from './r61-dual-approval.mjs';
import {verifyR62Restore,normalizedR62Checkpoint}
  from './r62-restore-evidence.mjs';
import {examineR62S3Lineage} from './r62-s3-lineage.mjs';
const TENANT=/^[a-f0-9]{24}$/,ID=/^[a-f0-9]{32}$/,
  COMMIT=/^[a-f0-9]{40}$/,SHA=/^[a-f0-9]{64}$/,
  LSN=/^[0-9A-F]+\/[0-9A-F]+$/;
function deny(ok,why){if(!ok)throw Error('R6.2 failover drill gate refused: '+why);}
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function evaluateR62FailoverDrill({
  tenantId,incidentId,epoch,expectedCommitSha,
  primaryFence,observerPackets,observerDirectory,
  barrier,restore,versionAnalysis,
  humanApprovals,reviewers,ciProvenance,
  now=()=>Date.now()
}={}){
  deny(TENANT.test(tenantId||'')&&ID.test(incidentId||'')&&
    Number.isSafeInteger(epoch)&&epoch>=1&&epoch<=1000000&&
    COMMIT.test(expectedCommitSha||'')&&
    primaryFence?.tenantId===tenantId&&
    primaryFence?.incidentId===incidentId&&
    primaryFence?.epoch===epoch&&
    barrier?.format==='osmanx-r62-sync-barrier-v1'&&
    barrier.tenantId===tenantId&&
    restore?.manifest&&restore?.publicKey&&
    Buffer.isBuffer(restore.logicalDump)&&restore.restoredRow&&
    versionAnalysis?.pending&&versionAnalysis?.forensics&&
    Array.isArray(observerPackets)&&Array.isArray(humanApprovals)&&
    typeof now==='function',
    'tenant, incident, commit, signed packet and bounded lab evidence required');
  // Each cryptographic primitive re-verifies the original source packet.
  const fence=inspectR62FenceObservations({
    observations:observerPackets,observers:observerDirectory,
    expected:primaryFence,now
  });
  const restored=verifyR62Restore({
    manifest:restore.manifest,publicKey:restore.publicKey,
    tenantId,logicalDump:restore.logicalDump,
    restoredRow:restore.restoredRow,now
  });
  const lineage=examineR62S3Lineage({
    tenantId,...versionAnalysis,now
  });
  const review=verifyR61DualApprovals({
    tenantId,incidentId,epoch,
    evidenceSha256:lineage.evidenceSha256,
    s3Version:lineage.selectedPendingVersionId,
    action:'investigate',approvals:humanApprovals,
    reviewers,now
  });
  const fields=normalizedR62Checkpoint(restore.restoredRow,tenantId);
  const errors=[];
  if(primaryFence.challengeSha256!==barrier.proofSha256||
    primaryFence.requiredLsn!==barrier.observedLsn||
    primaryFence.intentSha256!==versionAnalysis.pending.sha256)
    errors.push('observer proof differs from fresh WAL barrier or checkpoint');
  if(barrier.freshSynchronousCommitConfirmed!==true||
    barrier.standbyReplayConfirmed!==true||
    barrier.classification!=='fresh-wal-replay-observed')
    errors.push('no fresh replay-confirmed synchronous barrier');
  if(fields.epoch!==epoch||fields.pendingSha!==versionAnalysis.pending.sha256||
    fields.pendingOp===null)
    errors.push('independent logical restore does not match pending intent');
  if(restored.restoredRowVerified!==true)
    errors.push('no verified independently restored PostgreSQL checkpoint');
  if(lineage.classification!=='coherent-manual-review'||
    lineage.independentWitnessVerified!==true)
    errors.push('S3 WORM history or independent witness conflict');
  if(review.readonlyAuthorizationVerified!==true||
    fence.observerReportsVerified!==true)
    errors.push('distinct offline observer or reviewer proof missing');
  if(ciProvenance?.format!=='osmanx-r60-ci-provenance-gate-v1'||
    ciProvenance.commitSha!==expectedCommitSha||
    ciProvenance.tenantId!==tenantId||
    ciProvenance.pinnedCiLabGatePassed!==true||
    ciProvenance.independentReviewerKeys!==5||
    ciProvenance.verifiedSourceJobs!==5)
    errors.push('five independent pinned successful CI checks not verified');
  // This report is NOT an access token or production deployment grant.
  const summary={
    format:'osmanx-r62-failover-drill-review-v1',
    tenantId,incidentId,epoch,commitSha:expectedCommitSha,
    evidenceTimestamp:now(),errors,
    signedOldPrimaryObservations:2,
    signedReadOnlyHumanReviewers:2,
    logicalRestoreVerified:restored.restoredRowVerified,
    s3WormHistoryClass:lineage.classification,
    freshWalReplayVerified:barrier.standbyReplayConfirmed===true,
    independentCiSourcesVerified:ciProvenance?.pinnedCiLabGatePassed===true,
    labEvidenceComplete:errors.length===0,
    requiresHumanReview:true,
    oldPrimaryIsolationCertified:false,
    canPromotePg:false,canClearPending:false,
    canMutateS3:false,canRestoreCustomerData:false,
    deployAllowed:false,mainMergeAllowed:false,
    industrialZeroRpoCertified:false,productionCutoverAllowed:false
  };
  return Object.freeze({...summary,reportSha256:digest(summary)});
}
