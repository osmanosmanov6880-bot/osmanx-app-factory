// R6.4 combined independently reverified recovery evidence.
// Requires live query sources, archived full WAL bytes, Ed25519 reporter
// signature, signed human reviewers and a rebuilt follower observation.
// It only permits human forensic review, never automatic recovery.
import {createHash} from 'node:crypto';
import {verifyR64WalArchive} from './r64-wal-archive.mjs';
import {verifyR64NamedPitrReplay} from './r64-pitr-target.mjs';
import {verifyR64RecoveryBudget} from './r64-recovery-budget.mjs';
import {inspectR64ReplicaRebootstrap} from './r64-rebootstrap.mjs';
import {verifyR61DualApprovals} from './r61-dual-approval.mjs';
const TENANT=/^[a-f0-9]{24}$/,INCIDENT=/^[a-f0-9]{32}$/,
  SHA=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
function deny(ok,why){if(!ok)throw Error('R6.4 integrated review refused: '+why);}
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export async function assessR64IsolatedRecovery({
  tenantId,incidentId,epoch,pinnedCommitSha,
  archive,pointInTime,rebootstrap,budget,
  approvals,reviewers,now=()=>Date.now()
}={}){
  deny(TENANT.test(tenantId||'')&&INCIDENT.test(incidentId||'')&&
    COMMIT.test(pinnedCommitSha||'')&&
    Number.isSafeInteger(epoch)&&epoch>=1&&epoch<=1000000&&
    archive?.packet&&archive?.reader&&
    pointInTime?.source?.query&&pointInTime?.restored?.query&&
    rebootstrap&&budget?.packet&&
    Array.isArray(approvals)&&reviewers&&typeof now==='function',
    'pinned isolated archive, PG pools, rebuilt follower and offline reviews required');
  const wal=await verifyR64WalArchive({
    packet:archive.packet,publicKey:archive.publicKey,
    tenantId,systemId:archive.systemId,
    baseBackupSha256:archive.baseBackupSha256,
    reader:archive.reader,now
  });
  const replay=await verifyR64NamedPitrReplay({
    ...pointInTime,tenantId,archiveReceipt:wal,now
  });
  const rebuilt=inspectR64ReplicaRebootstrap({
    ...rebootstrap,tenantId,now
  });
  const loss=verifyR64RecoveryBudget({
    packet:budget.packet,publicKey:budget.publicKey,
    tenantId,archiveInventorySha256:wal.archiveInventorySha256,
    checkpointSha256:archive.baseBackupSha256,
    targetLsn:wal.targetLsn,now
  });
  // The reporter may be trusted but the signed count itself is not proof.
  // Query both real PG sources again and bind counts to the signed packet.
  const [sourceCount,restoredCount]=await Promise.all([
    pointInTime.source.query(
      'SELECT count(*)::integer AS n FROM ox_r64_pitr_event WHERE tenant=$1',
      [tenantId]),
    pointInTime.restored.query(
      'SELECT count(*)::integer AS n FROM ox_r64_pitr_event WHERE tenant=$1',
      [tenantId])
  ]);
  const sourceEvents=sourceCount.rows?.[0]?.n,
    restoredEvents=restoredCount.rows?.[0]?.n;
  deny(Number.isSafeInteger(sourceEvents)&&
    Number.isSafeInteger(restoredEvents)&&
    sourceEvents===budget.packet.sourceCommittedEvents&&
    restoredEvents===budget.packet.recoveredEvents&&
    restoredEvents===budget.packet.targetCommittedEvents,
    'independent PostgreSQL event counters differ from signed recovery budget');
  const evidenceSha256=digest({
    tenantId,incidentId,epoch,pinnedCommitSha,
    archive:wal.archiveInventorySha256,
    pitrTarget:replay.targetName,
    recoveryMs:replay.recoveryDurationMs,
    count:loss.deliberatelyExcludedPostTargetEvents,
    rebuild:rebuilt.classification
  });
  const human=verifyR61DualApprovals({
    tenantId,incidentId,epoch,evidenceSha256,
    s3Version:null,action:'investigate',approvals,reviewers,now
  });
  const missing=[];
  if(rebuilt.labRebootstrapEvidenceComplete!==true||
    rebuilt.oldPrimaryIsolationExternallyCertified!==false)
    missing.push('separate follower rebuild does not have coherent lab evidence');
  if(loss.labBudgetSatisfied!==true)
    missing.push('signed synthetic recovery time/loss budget exceeded');
  if(replay.isolatedNamedPointInTimeRecoveryVerified!==true)
    missing.push('named PostgreSQL target was not independently replay verified');
  if(human.distinctPublicKeys!==2)
    missing.push('two independent human signers missing');
  const result={
    format:'osmanx-r64-isolated-recovery-review-v1',tenantId,
    incidentId,epoch,pinnedCommitSha,evidenceSha256,
    verifiedArchivedWalSegments:wal.verifiedSegments,
    trueNamedPitrBeforeAfterVerified:replay.preTargetWalCommitReplayed&&
      replay.postTargetWalCommitExcluded,
    postTargetExcludedEvents:loss.deliberatelyExcludedPostTargetEvents,
    labRestoreElapsedMs:loss.laboratoryRecoveryMs,
    oldPrimaryQuarantined:rebuilt.mayRestartOldPrimary===false,
    rebuiltFollowerReceivedPostBackupWal:rebuilt.committedProbeReplayed,
    signedReviewers:human.distinctPublicKeys,
    missing,
    syntheticLabEvidenceComplete:missing.length===0,
    independentCISourceProvenanceNotVerifiedByThisModule:true,
    independentPowerFencingNotCertified:true,
    fullCustomerRecoveryNotVerified:true,
    offsiteArchiveCustodyNotVerified:true,
    separateSecurityAcceptanceRequired:true,
    mayClearPending:false,mayRejoinOldPrimary:false,
    mayPromoteReplica:false,mayUpdateS3:false,
    mayDeploy:false,mayMergeMain:false,
    industrialZeroRpoCertified:false,productionCutoverAllowed:false
  };
  return Object.freeze({...result,reportSha256:digest(result)});
}
