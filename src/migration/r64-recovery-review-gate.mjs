// R6.4 human-only recovery evidence gate. Calls real verification functions,
// not a user-submitted success flag. The PostgreSQL pool/quarantine adapter
// remains a trusted local lab dependency, NOT external production provenance.
import {createHash} from 'node:crypto';
import {verifyR64WalArchive}
  from './r64-wal-archive-evidence.mjs';
import {verifyR64PitrBoundary}
  from './r64-pitr-boundary.mjs';
import {assessR64RebuiltStandby}
  from './r64-rebootstrap-review.mjs';
import {verifyR61DualApprovals}
  from './r61-dual-approval.mjs';
const TENANT=/^[a-f0-9]{24}$/,ID=/^[a-f0-9]{32}$/,
  NODE=/^[a-z][a-z0-9-]{2,48}$/,SHA=/^[a-f0-9]{64}$/;
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function deny(ok,msg){if(!ok)throw Error('R6.4 human-only evidence gate refused: '+msg);}
export async function evaluateR64RecoveryReview({
  tenantId,incidentId,epoch,
  archive,sourceAndRestore,rebuilt,
  quarantineStore,oldNodeId,
  humanApprovals,reviewers,now=()=>Date.now()
}={}){
  deny(TENANT.test(tenantId||'')&&ID.test(incidentId||'')&&
    Number.isSafeInteger(epoch)&&epoch>=1&&epoch<=1000000&&
    NODE.test(oldNodeId||'')&&
    archive?.manifest&&archive?.publicKey&&
    Array.isArray(archive.observedSegments)&&
    sourceAndRestore?.manifest&&sourceAndRestore?.publicKey&&
    Array.isArray(sourceAndRestore.sourceMarkers)&&
    Array.isArray(sourceAndRestore.restoredMarkers)&&
    rebuilt?.selectedPool&&rebuilt?.rebuiltPool&&
    quarantineStore?.tenantId===tenantId&&
    typeof quarantineStore.inspect==='function'&&
    Array.isArray(humanApprovals)&&humanApprovals.length===2&&
    reviewers&&typeof now==='function',
    'tenant-pinned signed WAL, restored writes, PG replica and dual approvals required');
  const wal=verifyR64WalArchive({
    ...archive,tenantId,now
  });
  const boundary=verifyR64PitrBoundary({
    ...sourceAndRestore,tenantId,archiveReceipt:wal,now
  });
  const replica=await assessR64RebuiltStandby({
    ...rebuilt,now
  });
  const quarantined=await quarantineStore.inspect({
    incidentId,nodeId:oldNodeId
  });
  const approved=verifyR61DualApprovals({
    tenantId,incidentId,epoch,
    evidenceSha256:boundary.boundaryReceiptSha256,
    s3Version:null,action:'investigate',
    approvals:humanApprovals,reviewers,now
  });
  const blockers=[];
  if(boundary.incidentId!==incidentId||
    boundary.systemId!==wal.systemId||
    replica.systemId!==wal.systemId)
    blockers.push('PITR, WAL archive and new follower do not share incident/system identity');
  if(quarantined?.format!=='osmanx-r63-quarantine-inspection-v1'||
    quarantined.tenantId!==tenantId||
    quarantined.incidentId!==incidentId||
    quarantined.nodeId!==oldNodeId||
    quarantined.systemId!==wal.systemId||
    quarantined.quarantined!==true||
    quarantined.chainVerified!==true||
    quarantined.oldPrimaryRejoinAllowed!==false||
    !SHA.test(quarantined.sourceEvidenceSha256||'')||
    quarantined.sourceEvidenceSha256!==boundary.boundaryReceiptSha256||
    quarantined.selectedTimeline!==replica.selectedTimeline||
    quarantined.oldTimeline>=replica.selectedTimeline)
    blockers.push('old-primary persistent quarantine or WAL branch not verified');
  if(approved.readonlyAuthorizationVerified!==true||
    approved.distinctPublicKeys!==2)
    blockers.push('two independent human offline signatures not verified');
  if(replica.freshReplicaDataVerified!==true||
    replica.replicaInRecovery!==true)
    blockers.push('replacement old node is not on a replay-verified read-only replica');
  const report={
    format:'osmanx-r64-recovery-readonly-review-v1',tenantId,incidentId,
    epoch,walArchiveEvidenceSha256:wal.archiveEvidenceSha256,
    restoredBoundaryEvidenceSha256:boundary.boundaryReceiptSha256,
    selectedTimeline:replica.selectedTimeline,
    appendedQuarantineTip:quarantined.chainTip||null,
    blockers,syntheticLabEvidenceReadyForExternalReview:blockers.length===0,
    signedArchiveVerified:wal.signatureVerified,
    selectedTransactionPreserved:boundary.selectedTransactionRecovered,
    postTargetTransactionExcluded:boundary.intentionallyLaterTransactionExcluded,
    rebuiltStandbyReadOnly:replica.replicaInRecovery,
    independentHumanReviewers:approved.distinctPublicKeys,
    independentExternalWitnessCertified:false,
    realGitHubCiProvenanceReverified:false,
    archivedWalOffsiteCustodyCertified:false,
    productionPitrCertified:false,
    productionRpoCertified:false,
    mustRetainOldPrimaryQuarantine:true,
    mayUnquarantineOldPrimary:false,mayRejoinOldPrimary:false,
    mayPromoteReplica:false,mayWriteS3:false,
    mayRestoreCustomerData:false,mayDeploy:false,
    mayMergeMain:false,productionCutoverAllowed:false
  };
  return Object.freeze({...report,reportSha256:digest(report)});
}
