// R6.2: fail-closed analysis of a bounded, versioned S3 WORM pointer.
// Input is the verified output of R6.0 read-only version forensics and
// separately authenticated witness. NEVER performs S3 writes or PG recovery.
import {createHash} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,HEX=/^[a-f0-9]{64}$/,
  VERSION=/^[A-Za-z0-9_.-]{1,256}$/;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function deny(ok,msg){if(!ok)throw Error('R6.2 S3 lineage refused: '+msg);}
function checkVersion(v,when){
  deny(v&&VERSION.test(v.versionId||'')&&HEX.test(v.sha256||'')&&
    typeof v.isLatest==='boolean'&&
    v.retentionMode==='COMPLIANCE'&&
    typeof v.lastModified==='string'&&
    Number.isFinite(Date.parse(v.lastModified))&&
    typeof v.retainedUntil==='string'&&
    Number.isFinite(Date.parse(v.retainedUntil))&&
    Date.parse(v.retainedUntil)>when+5*60000,
    'untrusted or unretained S3 object version');
  return {versionId:v.versionId,sha256:v.sha256,
    isLatest:v.isLatest,lastModified:v.lastModified,
    retainedUntil:v.retainedUntil};
}
export function examineR62S3Lineage({
  tenantId,pending,committed=null,forensics,
  witness=null,witnessVerified=false,now=()=>Date.now()
}={}){
  deny(TENANT.test(tenantId||'')&&pending&&
    Number.isSafeInteger(pending.epoch)&&pending.epoch>=1&&
    pending.epoch<=1000000&&HEX.test(pending.sha256||'')&&
    (pending.beforeVersion===null||
      VERSION.test(pending.beforeVersion||''))&&
    forensics?.format==='osmanx-r60-version-forensic-v1'&&
    forensics.tenantId===tenantId&&
    forensics.canUnquarantine===false&&
    forensics.requiresManualWitnessReview===true&&
    Array.isArray(forensics.reviewedVersions)&&
    forensics.reviewedVersions.length>0&&
    forensics.reviewedVersions.length<=100&&
    Array.isArray(forensics.matchingPendingVersions)&&
    forensics.matchingPendingVersions.length<=100&&
    typeof now==='function',
    'tenant-pinned pending intent and exact bounded R6.0 forensic inventory required');
  deny(committed===null||
    (committed&&VERSION.test(committed.versionId||'')&&
      HEX.test(committed.sha256||'')),
    'untrusted persisted previously committed checkpoint');
  deny(witness===null||
    (witness&&HEX.test(witness.catalogSha256||'')&&
      Number.isSafeInteger(witness.entries)&&witness.entries>=1),
    'invalid independent witnessed version');
  deny(typeof witnessVerified==='boolean',
    'missing independently verified witness status');
  const when=now(),versions=forensics.reviewedVersions
    .map(v=>checkVersion(v,when));
  const seen=new Set();
  for(const item of versions){
    deny(!seen.has(item.versionId),'duplicate version ID in history');
    seen.add(item.versionId);
  }
  const latest=versions.filter(x=>x.isLatest);
  deny(latest.length===1,'missing or conflicting latest retained pointer');
  const candidates=versions.filter(x=>
    x.sha256===pending.sha256&&x.versionId!==pending.beforeVersion);
  const candidateIds=forensics.matchingPendingVersions;
  deny(candidateIds.length===candidates.length&&
    new Set(candidateIds).size===candidateIds.length&&
    candidateIds.every(id=>candidates.some(x=>x.versionId===id)),
    'forensic candidate set cannot be altered independently');
  const before=pending.beforeVersion?
    versions.find(x=>x.versionId===pending.beforeVersion):null;
  const previousConsistent=committed===null||
    Boolean(before&&before.versionId===committed.versionId&&
      before.sha256===committed.sha256);
  let classification='coherent-manual-review';
  if(pending.beforeVersion&&!before)classification='missing-previous-version';
  else if(!previousConsistent)classification='previous-commit-mismatch';
  else if(candidates.length>1)classification='multiple-retained-candidates';
  else if(candidates.length===0)classification='pending-version-unobserved';
  else if(!latest.some(x=>x.versionId===candidates[0].versionId))
    classification='superseded-or-forked-pointer';
  else if(!witnessVerified||witness?.catalogSha256!==pending.sha256)
    classification='independent-witness-not-aligned';
  const result={
    format:'osmanx-r62-lineage-analysis-v1',tenantId,
    classification,pendingEpoch:pending.epoch,pendingSha256:pending.sha256,
    latestVersionId:latest[0].versionId,
    selectedPendingVersionId:candidates.length===1?
      candidates[0].versionId:null,
    previousVersionConfirmed:previousConsistent,
    observedWormVersions:versions.length,
    independentWitnessVerified:witnessVerified&&
      witness?.catalogSha256===pending.sha256,
    ambiguous:classification!=='coherent-manual-review',
    requiresOperatorReview:true,mayClearPendingIntent:false,
    mayAdvanceCheckpoint:false,mayWriteS3:false,
    productionCutoverAllowed:false
  };
  return Object.freeze({...result,evidenceSha256:digest(result)});
}
