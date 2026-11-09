// R6.1 strictly read-only, multi-source recovery assessment.
// PostgreSQL/S3/witness have no shared atomic snapshot. No automated
// reconcile, S3 PUT, release, restore, lease or production action.
import {createHash} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,ID=/^[a-f0-9]{32}$/,
  SHA=/^[a-f0-9]{64}$/,VERSION=/^[a-zA-Z0-9_.-]{1,256}$/;
const digest=value=>createHash('sha256').update(
  JSON.stringify(value)).digest('hex');
function deny(ok,reason){
  if(!ok)throw Error('R6.1 recovery assessment refused: '+reason);
}
function readPending(row){
  deny(row&&Number.isSafeInteger(Number(row.epoch))&&
    Number(row.epoch)>=1,'invalid PostgreSQL checkpoint epoch');
  const pending=row.pending_op!==null&&row.pending_op!==undefined;
  if(pending)deny(ID.test(row.pending_op)&&
    SHA.test(row.pending_sha||'')&&
    Number(row.pending_epoch)===Number(row.epoch)&&
    (row.pending_before_version===null||
      VERSION.test(row.pending_before_version||'')),
    'incomplete durable pending S3 intent');
  return {epoch:Number(row.epoch),pending,
    operation:pending?row.pending_op:null,
    sha256:pending?row.pending_sha:null,
    beforeVersion:pending?row.pending_before_version:null};
}
export function createR61RecoveryAssessment({
  tenantId,pool,forensics,witness,auditAnchor,auditObjectKey,
  manifestSha256,now=()=>Date.now()
}={}){
  deny(TENANT.test(tenantId||'')&&pool?.query&&
    forensics?.tenantId===tenantId&&forensics?.readonly===true&&
    typeof forensics.investigate==='function'&&
    typeof witness?.current==='function'&&
    typeof witness?.verify==='function'&&
    auditAnchor?.tenantId===tenantId&&
    typeof auditAnchor.verifyAgainstLedger==='function'&&
    typeof auditObjectKey==='string'&&
    /^r60\/audit\/[a-f0-9]{64}\.json$/.test(auditObjectKey)&&
    SHA.test(manifestSha256||'')&&typeof now==='function',
    'tenant-pinned read-only S3, PG, witness and independent WORM auditor required');
  async function current(){
    const r=await pool.query(
      'SELECT epoch,pending_op,pending_sha,pending_epoch,pending_before_version FROM ox_r57_checkpoint_control WHERE tenant=$1',
      [tenantId]);
    deny(r.rows?.length===1,'checkpoint authority tenant row absent');
    return readPending(r.rows[0]);
  }
  async function assess({incidentId}={}){
    deny(ID.test(incidentId||''),'opaque incident ID required');
    const pgBefore=await current();
    let forensic=null,anchor=null,audit=null,witnessResult=null,
      witnessFailure=false,auditFailure=false,forensicFailure=false;
    if(pgBefore.pending){
      try{
        forensic=await forensics.investigate({
          pendingSha256:pgBefore.sha256,
          previousVersionId:pgBefore.beforeVersion
        });
        deny(forensic?.tenantId===tenantId&&
          forensic?.canUnquarantine===false&&
          Array.isArray(forensic.reviewedVersions)&&
          Array.isArray(forensic.matchingPendingVersions)&&
          forensic.reviewedVersions.length<=100,
          'untrusted S3 forensic inventory');
      }catch{forensicFailure=true;}
    }
    try{
      anchor=await witness.current();
      if(anchor)deny(Number.isSafeInteger(anchor.entries)&&anchor.entries>=1&&
        SHA.test(anchor.catalogSha256||'')&&
        anchor.manifestSha256===manifestSha256,
        'witness returned inconsistent manifest');
    }catch{witnessFailure=true;}
    try{
      audit=await auditAnchor.verifyAgainstLedger(auditObjectKey);
      deny(audit?.anchored===true&&audit?.providerWormVerified===true&&
        audit?.productionCutoverAllowed===false,
        'auditor did not verify WORM tip');
    }catch{auditFailure=true;}
    if(anchor&&pgBefore.pending&&!witnessFailure&&
      anchor.catalogSha256===pgBefore.sha256){
      try{
        witnessResult=await witness.verify({
          catalogSha256:pgBefore.sha256,
          manifestSha256,entries:anchor.entries
        });
        deny(witnessResult?.anchorVerified===true&&
          witnessResult.catalogSha256===pgBefore.sha256,
          'independent witness verification missing');
      }catch{witnessFailure=true;}
    }
    const pgAfter=await current();
    deny(digest(pgBefore)===digest(pgAfter),
      'checkpoint authority changed during non-atomic evidence collection');
    const matches=forensic?.matchingPendingVersions||[],
      matched=matches.length===1&&
        forensic.reviewedVersions.some(v=>
          v.versionId===matches[0]&&v.isLatest===true&&
          v.sha256===pgBefore.sha256&&
          v.retentionMode==='COMPLIANCE');
    let classification='no-pending-intent';
    if(pgBefore.pending){
      classification=forensicFailure?'s3-forensics-unavailable':
        !matched?'ambiguous-s3-version':
        witnessFailure||!anchor||
        anchor.catalogSha256!==pgBefore.sha256||
        !witnessResult?'witness-not-aligned':
        auditFailure?'audit-anchor-unavailable':
        'consistent-evidence-manual-review';
    }
    const report={
      format:'osmanx-r61-recovery-assessment-v1',tenantId,incidentId,
      issuedAt:now(),epoch:pgBefore.epoch,
      pendingOpSha256:pgBefore.sha256,
      pendingOperation:pgBefore.operation,
      classification,
      s3VerifiedVersion:matched?matches[0]:null,
      witnessVerified:Boolean(witnessResult&&!witnessFailure),
      auditWormVerified:Boolean(audit&&!auditFailure),
      sourceObservationsNonAtomic:true,
      stateUnchangedDuringObservation:true,
      needsIndependentHumanReview:true,
      mayClearPendingIntent:false,mayWriteS3:false,
      mayRestoreCustomerData:false,mayPromotePg:false,
      productionCutoverAllowed:false
    };
    return Object.freeze({...report,reportSha256:digest(report)});
  }
  return Object.freeze({tenantId,assess,syntheticOnly:true,
    readOnly:true,productionCutoverAllowed:false});
}
