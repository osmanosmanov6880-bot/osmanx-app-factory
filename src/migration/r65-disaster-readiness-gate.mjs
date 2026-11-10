// R6.5 all-evidence forensic gate: explicitly READ ONLY.
// Re-fetches BOTH independent WORM objects, re-verifies signed manifest,
// measures actual acknowledged PG synthetic loss and two human signatures.
// This cannot authorize promotion, unquarantine, S3 writes or deployment.
import {createHash} from 'node:crypto';
import {verifyR65DualWalBundle}
  from './r65-dual-wal-bundle.mjs';
import {measureR65SyntheticRpo}
  from './r65-synthetic-rpo.mjs';
import {verifyR61DualApprovals}
  from './r61-dual-approval.mjs';
const TENANT=/^[a-f0-9]{24}$/,CASE=/^[a-f0-9]{32}$/;
function deny(ok,msg){if(!ok)throw Error('R6.5 disaster readiness refused: '+msg);}
export async function assessR65HumanOnlyRecovery({
  tenantId,incidentId,epoch,manifest,archivePublicKey,
  custody,acknowledged,restoredRows,
  failureAtMs,recoveryAtMs,sourceProcessDestroyed,
  humanApprovals,reviewers,now=()=>Date.now()
}={}){
  deny(TENANT.test(tenantId||'')&&CASE.test(incidentId||'')&&
    Number.isSafeInteger(epoch)&&epoch>=1&&epoch<=1000000&&
    custody?.tenantId===tenantId&&
    custody.storageProcessCount===2&&
    typeof custody.downloadVerified==='function'&&
    Array.isArray(humanApprovals)&&humanApprovals.length===2&&
    Array.isArray(acknowledged)&&Array.isArray(restoredRows)&&
    sourceProcessDestroyed===true&&typeof now==='function',
    'two live S3 stores, tenant-bound evidence, source loss and dual humans mandatory');
  const sealed=verifyR65DualWalBundle({
    manifest,publicKey:archivePublicKey,tenantId,now
  });
  deny(sealed.incidentId===incidentId,
    'signed WAL archive belongs to a different recovery incident');
  const data=await custody.downloadVerified({
    inventory:manifest.inventory,receipts:manifest.receipts
  });
  deny(Array.isArray(data)&&data.length===manifest.inventory.length,
    'two independent remote providers did not return complete WAL');
  try{
    for(const file of data){
      const item=manifest.inventory.find(x=>x.name===file.name);
      deny(item&&Buffer.isBuffer(file.body)&&
        file.body.length===item.size&&
        createHash('sha256').update(file.body).digest('hex')===item.sha256,
        'remote archive bytes are corrupted or incomplete');
    }
  }finally{
    for(const file of data)if(Buffer.isBuffer(file.body))file.body.fill(0);
  }
  const rpo=measureR65SyntheticRpo({
    tenantId,acknowledged,restoredRows,
    targetLsn:sealed.targetLsn,
    failureAtMs,recoveryAtMs,
    sourceProcessDestroyed:true,dualRemoteBytesVerified:true
  });
  const approved=verifyR61DualApprovals({
    tenantId,incidentId,epoch,evidenceSha256:sealed.evidenceSha256,
    s3Version:null,action:'investigate',
    approvals:humanApprovals,reviewers,now
  });
  deny(approved.distinctPublicKeys===2&&
    approved.readonlyAuthorizationVerified===true,
    'independent security and reliability reviewer signatures required');
  const report={
    format:'osmanx-r65-human-only-disaster-review-v1',
    tenantId,incidentId,epoch,
    walEvidenceSha256:sealed.evidenceSha256,
    dualS3WormObjectCopiesReread:true,
    signedWalManifestVerified:true,
    independentS3ProcessEndpoints:2,
    independentSignedHumanReviewers:approved.distinctPublicKeys,
    sourceCrashClaimSuppliedByLab:true,
    sourceCrashExternallyCertified:false,
    acknowledgedSyntheticTransactions:rpo.acknowledgedTransactions,
    restoredSyntheticTransactions:rpo.recoveredTransactions,
    missingSyntheticAcknowledgements:rpo.lostAcknowledgedTransactions,
    observedAckGapMs:rpo.observedAckGapMs,
    measuredRestoreMs:rpo.failureToRestoreMs,
    syntheticLabEvidenceReadyForHumanReview:true,
    fullServiceRecoveryValidated:false,
    endToEndSourceSqliteRpoCertified:false,
    geographicallyIsolatedWalCustodyCertified:false,
    independentExternalAuditCertified:false,
    industryZeroRpoCertified:false,
    mayPromote:false,mayRejoinOldPrimary:false,
    mayUnquarantineOldPrimary:false,mayClearPending:false,
    mayWriteS3:false,mayRestoreCustomerData:false,
    mayMergeMain:false,mayDeploy:false,
    productionCutoverAllowed:false
  };
  const digest=createHash('sha256').update(JSON.stringify(report)).digest('hex');
  return Object.freeze({...report,reportSha256:digest});
}
