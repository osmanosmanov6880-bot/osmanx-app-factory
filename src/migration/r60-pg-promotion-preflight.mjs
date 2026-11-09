// R6.0: read-only PG promotion preflight. Never issues pg_promote,
// docker kill, leadership claim or network VIP reassignment.
import {createHash} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,SHA=/^[a-f0-9]{64}$/,
  OP=/^[a-f0-9]{32}$/,LSN=/^[0-9A-F]+\/[0-9A-F]+$/;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function deny(ok,why){if(!ok)throw Error('R6.0 PG preflight refused: '+why);}
function normalized(row){
  deny(row&&Number.isSafeInteger(Number(row.epoch))&&
    Number(row.epoch)>=1&&OP.test(row.pending_op||'')&&
    SHA.test(row.pending_sha||'')&&Number.isSafeInteger(Number(row.pending_epoch))&&
    Number(row.pending_epoch)===Number(row.epoch),
    'missing or mismatched persisted fenced checkpoint intent');
  return {epoch:Number(row.epoch),operation:row.pending_op,
    pendingSha256:row.pending_sha,pendingEpoch:Number(row.pending_epoch),
    previousVersion:row.pending_before_version||null};
}
export async function inspectR60PgPromotionPreflight({
  primary,standby,tenantId,requiredLsn,replicaName='r59-standby'
}={}){
  deny(primary?.query&&standby?.query&&TENANT.test(tenantId||'')&&
    LSN.test(requiredLsn||'')&&/^[a-z][a-z0-9-]{2,48}$/.test(replicaName),
    'pinned primary/standby, tenant, required WAL LSN and replica required');
  // Observe primary and replica in close succession. A diagnostic snapshot
  // is NOT a substitute for proper fencing, consensus, or an STONITH proof.
  const primaryState=await primary.query(
    "SELECT pg_is_in_recovery() AS recovering, current_setting('synchronous_commit') AS commit_mode, current_setting('synchronous_standby_names') AS standby_names"
  );
  const state=primaryState.rows?.[0];
  deny(state?.recovering===false&&state.commit_mode==='remote_apply'&&
    String(state.standby_names||'').includes(replicaName),
    'primary is not in synchronous remote_apply mode');
  const leader=await primary.query(
    'SELECT application_name,state,sync_state,pg_wal_lsn_diff(replay_lsn,$1::pg_lsn)::text AS replay_delta FROM pg_stat_replication WHERE application_name=$2',
    [requiredLsn,replicaName]);
  deny(leader.rows?.length===1&&
    leader.rows[0].state==='streaming'&&
    ['sync','quorum'].includes(leader.rows[0].sync_state)&&
    leader.rows[0].replay_delta!==null&&
    Number(leader.rows[0].replay_delta)>=0,
    'primary has no synchronous fully caught-up standby');
  const secondary=await standby.query(
    'SELECT pg_is_in_recovery() AS recovering,pg_last_wal_replay_lsn()::text AS replay_lsn,pg_wal_lsn_diff(pg_last_wal_replay_lsn(),$1::pg_lsn)::text AS replay_delta',
    [requiredLsn]);
  const b=secondary.rows?.[0];
  deny(b?.recovering===true&&LSN.test(b.replay_lsn||'')&&
    b.replay_delta!==null&&Number(b.replay_delta)>=0,
    'replica WAL not durably replayed or is already promoted');
  const sql='SELECT epoch,pending_op,pending_sha,pending_epoch,pending_before_version FROM ox_r57_checkpoint_control WHERE tenant=$1';
  const [source,copy]=await Promise.all([
    primary.query(sql,[tenantId]),standby.query(sql,[tenantId])
  ]);
  deny(source.rows?.length===1&&copy.rows?.length===1,
    'checkpoint row absent on primary or standby');
  const a=normalized(source.rows[0]),c=normalized(copy.rows[0]);
  deny(hash(a)===hash(c),'replica checkpoint intent differs from primary');
  return Object.freeze({
    format:'osmanx-r60-pg-preflight-v1',tenantId,requiredLsn,
    primaryCommitMode:'remote_apply',
    standbySyncState:leader.rows[0].sync_state,
    pendingIntentSha256:a.pendingSha256,
    pendingGeneration:a.epoch,
    pendingOperation:a.operation,
    primaryStandbyIntentMatching:true,
    streamingStandbyReplayConfirmed:true,
    eligibleForIsolatedFailoverDrill:true,
    oldPrimaryFencedByThisCheck:false,
    splitBrainAbsenceProven:false,
    automaticPromotionAllowed:false,
    productionCutoverAllowed:false
  });
}
