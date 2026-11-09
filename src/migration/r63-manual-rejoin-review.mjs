// R6.3: human-only rehearsal verdict. Every signature is reverified;
// the target is a disposable lab, never production. No write actions.
import {createHash} from 'node:crypto';
import {inspectR62FenceObservations}
  from './r62-fence-evidence.mjs';
import {verifyR61DualApprovals}
  from './r61-dual-approval.mjs';
import {assessR63PgTimelineRejoin}
  from './r63-timeline-rejoin.mjs';
import {verifyR63PhysicalBackup}
  from './r63-physical-backup-evidence.mjs';
const TENANT=/^[a-f0-9]{24}$/,INCIDENT=/^[a-f0-9]{32}$/,
  SHA=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function deny(ok,why){if(!ok)throw Error('R6.3 lab rejoin review refused: '+why);}
export function evaluateR63ManualRejoinReview({
  tenantId,clusterId,incidentId,epoch,commitSha,
  oldSnapshot,selectedSnapshot,requiredSystemId,
  fenceExpected,fencePackets,fenceDirectory,
  quarantineInspection,physicalBackup,
  approvals,reviewers,ciProvenance,
  now=()=>Date.now()
}={}){
  deny(TENANT.test(tenantId||'')&&TENANT.test(clusterId||'')&&
    INCIDENT.test(incidentId||'')&&
    Number.isSafeInteger(epoch)&&epoch>=1&&epoch<=1000000&&
    COMMIT.test(commitSha||'')&&
    Array.isArray(fencePackets)&&Array.isArray(approvals)&&
    typeof now==='function'&&
    quarantineInspection&&physicalBackup,
    'strict lab identity and required signed evidence missing');
  const timeline=assessR63PgTimelineRejoin({
    oldPrimary:oldSnapshot,selectedPrimary:selectedSnapshot,
    requiredSystemId,now
  });
  const observed=inspectR62FenceObservations({
    observations:fencePackets,observers:fenceDirectory,
    expected:fenceExpected,now
  });
  const backup=verifyR63PhysicalBackup({
    ...physicalBackup,tenantId,now
  });
  const review=verifyR61DualApprovals({
    tenantId,incidentId,epoch,
    evidenceSha256:quarantineInspection.sourceEvidenceSha256,
    s3Version:null,action:'investigate',approvals,reviewers,now
  });
  const errors=[];
  if(quarantineInspection.format!=='osmanx-r63-quarantine-inspection-v1'||
    quarantineInspection.tenantId!==tenantId||
    quarantineInspection.clusterId!==clusterId||
    quarantineInspection.incidentId!==incidentId||
    quarantineInspection.nodeId!==oldSnapshot.nodeId||
    quarantineInspection.systemId!==requiredSystemId||
    quarantineInspection.oldTimeline!==oldSnapshot.timelineId||
    quarantineInspection.selectedTimeline!==selectedSnapshot.timelineId||
    quarantineInspection.quarantined!==true||
    quarantineInspection.chainVerified!==true||
    quarantineInspection.oldPrimaryRejoinAllowed!==false||
    !SHA.test(quarantineInspection.sourceEvidenceSha256||''))
    errors.push('durable old-primary quarantine or HMAC review is not verified');
  if(timeline.classification!=='old-primary-timeline-stale'||
    timeline.newTimelineVerified!==true)
    errors.push('selected primary is not on a verified successor timeline');
  if(observed.tenantId!==tenantId||
    observed.incidentId!==incidentId||
    fenceExpected.clusterId!==clusterId||
    fenceExpected.epoch!==epoch||
    fenceExpected.primaryNode!==oldSnapshot.nodeId||
    fenceExpected.standbyNode!==selectedSnapshot.nodeId||
    observed.observerReportsVerified!==true)
    errors.push('two signed fence observers do not bind exact incident');
  if(physicalBackup.manifest.systemId!==requiredSystemId||
    physicalBackup.manifest.timeline!==oldSnapshot.timelineId||
    backup.restoredCheckpointExactlyMatches!==true)
    errors.push('physical backup provenance differs from old source timeline');
  if(review.distinctPublicKeys!==2||
    review.readonlyAuthorizationVerified!==true)
    errors.push('two independent human signers did not approve inspection');
  if(ciProvenance?.format!=='osmanx-r60-ci-provenance-gate-v1'||
    ciProvenance.tenantId!==tenantId||
    ciProvenance.commitSha!==commitSha||
    ciProvenance.pinnedCiLabGatePassed!==true||
    ciProvenance.independentReviewerKeys!==5||
    ciProvenance.verifiedSourceJobs!==5)
    errors.push('pinned CI laboratory evidence incomplete');
  const report={
    format:'osmanx-r63-manual-rejoin-review-v1',
    tenantId,clusterId,incidentId,commitSha,epoch,
    errors,
    timelineClassification:timeline.classification,
    quarantineReviewVerified:errors.every(x=>!x.startsWith('durable')),
    independentFencingObservations:observed.independentObserverKeys,
    offlineHumanSignatures:review.distinctPublicKeys,
    physicalBackupRestored:backup.restoredPhysicalNodeVerified,
    physicalBackupManifestVerified:backup.pgVerifybackupPassed,
    syntheticReadinessForExternalReviewer:errors.length===0,
    requiredIndependentExternalValidation:true,
    selfSuppliedCiReportNotExternallyCertified:true,
    physicalPowerFenceIndependentlyCertified:false,
    splitBrainRiskEliminated:false,
    fullPitrVerified:false,
    mayUnquarantineOldPrimary:false,mayRunPgRewind:false,
    mayIssuePgPromote:false,mayRestoreCustomerData:false,
    mayMergeMain:false,mayDeploy:false,
    productionCutoverAllowed:false,industrialZeroRpoCertified:false
  };
  return Object.freeze({...report,reportSha256:hash(report)});
}
