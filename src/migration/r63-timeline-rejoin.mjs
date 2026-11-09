// R6.3: PostgreSQL timeline / system-id comparison. Read-only.
// An old-primary snapshot from before shutdown is NOT proof it is
// physically powered off. A timeline mismatch prohibits blind rejoin.
const NODE=/^[a-z][a-z0-9-]{2,48}$/,
  SYS=/^[0-9]{10,32}$/,LSN=/^[0-9A-F]+\/[0-9A-F]+$/;
function deny(ok,why){if(!ok)throw Error('R6.3 timeline review refused: '+why);}
function normalize(v){
  deny(v&&NODE.test(v.nodeId||'')&&SYS.test(String(v.systemId||''))&&
    Number.isSafeInteger(v.timelineId)&&v.timelineId>=1&&v.timelineId<=65535&&
    Number.isSafeInteger(v.prevTimelineId)&&v.prevTimelineId>=0&&
    v.prevTimelineId<=65535&&LSN.test(v.checkpointLsn||'')&&
    LSN.test(v.redoLsn||'')&&
    typeof v.inRecovery==='boolean'&&Number.isSafeInteger(v.observedAt)&&
    v.observedAt>0,'invalid trusted PostgreSQL control snapshot');
  return {nodeId:v.nodeId,systemId:String(v.systemId),
    timelineId:v.timelineId,prevTimelineId:v.prevTimelineId,
    checkpointLsn:v.checkpointLsn,redoLsn:v.redoLsn,
    inRecovery:v.inRecovery,observedAt:v.observedAt};
}
export async function readR63PgTimeline({pool,nodeId,now=()=>Date.now()}={}){
  deny(pool?.query&&NODE.test(nodeId||'')&&typeof now==='function',
    'read-only PostgreSQL pool and fixed node identifier required');
  const sql='SELECT s.system_identifier::text AS system_id,'+
    ' c.timeline_id::integer AS timeline_id,'+
    ' c.prev_timeline_id::integer AS prev_timeline_id,'+
    ' c.checkpoint_lsn::text AS checkpoint_lsn,'+
    ' c.redo_lsn::text AS redo_lsn,'+
    ' pg_is_in_recovery() AS in_recovery'+
    ' FROM pg_control_system() s CROSS JOIN pg_control_checkpoint() c';
  const result=await pool.query(sql);
  deny(result.rows?.length===1,'cannot read unique PostgreSQL control state');
  const row=result.rows[0];
  return Object.freeze(normalize({nodeId,
    systemId:row.system_id,timelineId:Number(row.timeline_id),
    prevTimelineId:Number(row.prev_timeline_id),
    checkpointLsn:row.checkpoint_lsn,redoLsn:row.redo_lsn,
    inRecovery:row.in_recovery,observedAt:now()}));
}
export function assessR63PgTimelineRejoin({
  oldPrimary,selectedPrimary,requiredSystemId,now=()=>Date.now()
}={}){
  const old=normalize(oldPrimary),active=normalize(selectedPrimary);
  deny(SYS.test(String(requiredSystemId||''))&&
    old.nodeId!==active.nodeId,
    'same physical node or unpinned source cluster');
  const belongs=old.systemId===requiredSystemId&&
    active.systemId===requiredSystemId;
  let classification;
  if(!belongs)classification='foreign-postgresql-cluster';
  else if(active.inRecovery)classification='new-primary-is-still-replica';
  else if(active.timelineId>old.timelineId)
    classification='old-primary-timeline-stale';
  else if(active.timelineId===old.timelineId&&!old.inRecovery)
    classification='possible-dual-primary';
  else if(active.timelineId<old.timelineId)
    classification='selected-primary-timeline-behind';
  else classification='timeline-identity-inconclusive';
  const t=now();
  deny(Number.isSafeInteger(t)&&
    old.observedAt<=t&&active.observedAt<=t&&
    t-active.observedAt<300000,'future or stale selected-primary evidence');
  return Object.freeze({
    format:'osmanx-r63-timeline-fork-review-v1',
    requiredSystemId,
    oldPrimaryNode:old.nodeId,selectedPrimaryNode:active.nodeId,
    oldTimeline:old.timelineId,newTimeline:active.timelineId,
    classification,
    sameSystemId:belongs,
    oldPrimarySnapshotMayBeStale:true,
    newTimelineVerified:belongs&&!active.inRecovery&&
      active.timelineId>old.timelineId,
    requiresPhysicalFencingAndRebootstrap:true,
    possibleDualPrimary:classification==='possible-dual-primary',
    rejoinAllowed:false,pgRewindAllowed:false,
    automaticPromotionAllowed:false,productionCutoverAllowed:false
  });
}
