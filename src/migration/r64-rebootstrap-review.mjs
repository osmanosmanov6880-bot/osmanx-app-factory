// R6.4: inspect a freshly re-bootstrapped PostgreSQL STANDBY.
// This module never invokes pg_rewind, pg_promote, pg_basebackup or
// rewrites any existing data directory; only a disposable lab may do so.
import {readR63PgTimeline} from './r63-timeline-rejoin.mjs';
const NODE=/^[a-z][a-z0-9-]{2,48}$/,
  LSN=/^[0-9A-F]+\/[0-9A-F]+$/;
function deny(ok,msg){if(!ok)throw Error('R6.4 rebootstrap refused: '+msg);}
export async function assessR64RebuiltStandby({
  selectedPool,rebuiltPool,
  selectedNode='pg-r59-standby',
  rebuiltNode='pg-r64-rebuilt-old',
  requiredLsn,
  now=()=>Date.now()
}={}){
  deny(selectedPool?.query&&rebuiltPool?.query&&
    NODE.test(selectedNode||'')&&NODE.test(rebuiltNode||'')&&
    selectedNode!==rebuiltNode&&LSN.test(requiredLsn||'')&&
    typeof now==='function',
    'separate live PostgreSQL source/replica and required replay LSN');
  const [source,copy]=await Promise.all([
    readR63PgTimeline({pool:selectedPool,nodeId:selectedNode,now}),
    readR63PgTimeline({pool:rebuiltPool,nodeId:rebuiltNode,now})
  ]);
  deny(source.inRecovery===false&&copy.inRecovery===true&&
    source.systemId===copy.systemId&&
    source.timelineId>=2&&copy.timelineId===source.timelineId,
    'recreated PostgreSQL is not a matching read-only follower of the new timeline');
  const state=await rebuiltPool.query(
    'SELECT pg_is_in_recovery() AS recovering,'+
    ' current_setting($2) AS default_transaction_read_only,'+
    ' pg_last_wal_replay_lsn()::text AS replay_lsn,'+
    ' pg_wal_lsn_diff(pg_last_wal_replay_lsn(),$1::pg_lsn)::text AS delta',
    [requiredLsn,'default_transaction_read_only']);
  const follower=state.rows?.[0];
  deny(follower?.recovering===true&&
    LSN.test(follower.replay_lsn||'')&&
    follower.delta!==null&&Number(follower.delta)>=0,
    'rebuilt follower has not replayed the required WAL or became writable');
  return Object.freeze({
    format:'osmanx-r64-rebootstrap-review-v1',
    selectedNode,rebuiltNode,
    systemId:source.systemId,
    selectedTimeline:source.timelineId,
    rebuiltTimeline:copy.timelineId,
    sourceNotInRecovery:true,
    replicaInRecovery:true,
    requiredLsn,replayedLsn:follower.replay_lsn,
    replayDifferenceBytes:Number(follower.delta),
    freshReplicaDataVerified:true,
    externalPowerFenceCertified:false,
    oldPrimaryReused:false,
    rebootstrapEvidenceComplete:true,
    mayPromoteReplica:false,mayUnquarantineOldPrimary:false,
    productionCutoverAllowed:false
  });
}
