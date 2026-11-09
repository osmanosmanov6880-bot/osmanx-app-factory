// R6.4 target-named WAL point-in-time replay verifier.
// Source and restored records are queried from separate, real PG pools.
// This is an ISOLATED drill; no customer restore, leader election or RPO claim.
const TENANT=/^[a-f0-9]{24}$/,ID=/^[a-f0-9]{32}$/,
  SHA=/^[a-f0-9]{64}$/,SYSTEM=/^[0-9]{10,32}$/,
  NAME=/^r64_[a-z0-9_]{4,48}$/;
function deny(ok,why){if(!ok)throw Error('R6.4 PITR validation refused: '+why);}
async function events(db,tenantId,preId,postId){
  const result=await db.query(
    'SELECT event_id,payload_sha FROM ox_r64_pitr_event '+
    'WHERE tenant=$1 AND event_id=ANY($2::varchar[]) ORDER BY event_id',
    [tenantId,[preId,postId]]);
  deny(Array.isArray(result.rows)&&result.rows.length<=2,
    'untrusted PITR event query');
  const seen=new Map();
  for(const row of result.rows){
    deny((row.event_id===preId||row.event_id===postId)&&
      SHA.test(row.payload_sha||'')&&!seen.has(row.event_id),
      'foreign/duplicate replay event');
    seen.set(row.event_id,row.payload_sha);
  }
  return seen;
}
async function identity(db){
  const result=await db.query(
    'SELECT pg_is_in_recovery() AS recovering,'+
    ' s.system_identifier::text AS system_id,'+
    ' c.timeline_id::integer AS timeline '+
    'FROM pg_control_system() s CROSS JOIN pg_control_checkpoint() c'
  );
  deny(result.rows?.length===1&&
    typeof result.rows[0].recovering==='boolean'&&
    SYSTEM.test(result.rows[0].system_id||'')&&
    Number.isInteger(result.rows[0].timeline)&&
    result.rows[0].timeline>=1,
    'cannot prove restored database identity');
  return result.rows[0];
}
export async function verifyR64NamedPitrReplay({
  source,restored,tenantId,targetName,preId,postId,
  preSha256,postSha256,archiveReceipt,expectedSystemId,
  restoreStartedAt,now=()=>Date.now()
}={}){
  deny(source?.query&&restored?.query&&source!==restored&&
    TENANT.test(tenantId||'')&&NAME.test(targetName||'')&&
    ID.test(preId||'')&&ID.test(postId||'')&&preId!==postId&&
    SHA.test(preSha256||'')&&SHA.test(postSha256||'')&&
    SYSTEM.test(expectedSystemId||'')&&
    Number.isSafeInteger(restoreStartedAt)&&restoreStartedAt>0&&
    typeof now==='function',
    'separate PG sources, exact restore point and committed event IDs required');
  deny(archiveReceipt?.format==='osmanx-r64-verified-wal-archive-v1'&&
    archiveReceipt.tenantId===tenantId&&
    archiveReceipt.systemId===expectedSystemId&&
    archiveReceipt.fullSegmentHashesVerified===true&&
    archiveReceipt.walPitrCompleted===false&&
    archiveReceipt.verifiedSegments>=1,
    'replayed archive must have verified exact segment bytes');
  const [sourceIdentity,recoveredIdentity,original,copy]=await Promise.all([
    identity(source),identity(restored),
    events(source,tenantId,preId,postId),
    events(restored,tenantId,preId,postId)
  ]);
  deny(sourceIdentity.system_id===expectedSystemId&&
    sourceIdentity.recovering===false&&
    recoveredIdentity.system_id===expectedSystemId&&
    recoveredIdentity.recovering===false,
    'source or restored PostgreSQL is not an independent writable cluster');
  deny(original.size===2&&original.get(preId)===preSha256&&
    original.get(postId)===postSha256,
    'source must contain both pre-target and post-target commits');
  deny(copy.size===1&&copy.get(preId)===preSha256&&!copy.has(postId),
    'PITR did not replay pre-target WAL or incorrectly included post-target commit');
  const endedAt=now();
  deny(Number.isSafeInteger(endedAt)&&endedAt>=restoreStartedAt&&
    endedAt-restoreStartedAt<=20*60*1000,
    'unbounded or invalid PITR duration');
  return Object.freeze({
    format:'osmanx-r64-pitr-target-reviewed-v1',
    tenantId,targetName,systemId:expectedSystemId,
    sourceTimeline:sourceIdentity.timeline,
    recoveredTimeline:recoveredIdentity.timeline,
    preTargetWalCommitReplayed:true,
    postTargetWalCommitExcluded:true,
    verifiedArchiveSegments:archiveReceipt.verifiedSegments,
    recoveryDurationMs:endedAt-restoreStartedAt,
    isolatedNamedPointInTimeRecoveryVerified:true,
    externalWalCustodyVerified:false,
    fullCustomerRestoreVerified:false,
    industrialRpoCertified:false,
    mayPublishRestoredNode:false,productionCutoverAllowed:false
  });
}
