// R6.2 only: fresh synchronous WAL barrier for an isolated PG lab.
// A timed-out COMMIT is AMBIGUOUS: never interpret it as a rolled-back
// transaction or proof that a former primary is safely fenced.
import {createHash} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,CHALLENGE=/^[a-f0-9]{32}$/,
  LSN=/^[0-9A-F]+\/[0-9A-F]+$/;
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function deny(ok,msg){if(!ok)throw Error('R6.2 WAL barrier refused: '+msg);}
export async function runR62SyntheticSyncBarrier({
  primary,standby,tenantId,challengeId,
  timeoutMs=2500,syntheticOnly=false
}={}){
  deny(syntheticOnly===true&&primary?.connect&&standby?.query&&
    TENANT.test(tenantId||'')&&CHALLENGE.test(challengeId||'')&&
    Number.isInteger(timeoutMs)&&timeoutMs>=500&&timeoutMs<=5000,
    'disposable lab PostgreSQL pools and fresh challenge required');
  const connection=await primary.connect();
  let transaction=false,broken=null,ack=false;
  const onError=e=>{broken=e;};
  connection.on?.('error',onError);
  try{
    const check=await connection.query(
      "SELECT pg_is_in_recovery() AS recovering, current_setting('synchronous_commit') AS mode");
    deny(check.rows?.[0]?.recovering===false&&
      check.rows?.[0]?.mode==='remote_apply',
      'primary must run remote_apply and cannot be a standby');
    const follower=await standby.query(
      'SELECT pg_is_in_recovery() AS recovering');
    deny(follower.rows?.[0]?.recovering===true,
      'standby is no longer in recovery');
    try{
      await connection.query('BEGIN');transaction=true;
      await connection.query('SET LOCAL statement_timeout = '+timeoutMs);
      await connection.query(
        'INSERT INTO ox_r62_sync_barrier(tenant,challenge_id) VALUES($1,$2)',
        [tenantId,challengeId]);
      await connection.query('COMMIT');transaction=false;ack=true;
    }catch(e){
      if(transaction)await connection.query('ROLLBACK').catch(()=>{});
      if(/connection terminated|ECONNRESET|57P01/i.test(
        String(e?.message||'')+' '+String(e?.code||'')))broken=e;
      return Object.freeze({
        format:'osmanx-r62-sync-barrier-v1',tenantId,challengeId,
        freshSynchronousCommitConfirmed:false,
        outcomeMayHaveCommittedLocally:true,
        classification:'unconfirmed-synchronous-commit',
        observedLsn:null,standbyReplayConfirmed:false,
        mayPromote:false,mayClearPendingIntent:false,
        productionCutoverAllowed:false
      });
    }
    deny(ack,'no confirmed synchronous COMMIT');
    const lsn=(await connection.query(
      'SELECT pg_current_wal_lsn()::text AS lsn')).rows?.[0]?.lsn;
    deny(LSN.test(lsn||''),'invalid server WAL position');
    const observed=await standby.query(
      'SELECT pg_is_in_recovery() AS recovering, pg_wal_lsn_diff(pg_last_wal_replay_lsn(), $1::pg_lsn)::text AS delta, EXISTS(SELECT 1 FROM ox_r62_sync_barrier WHERE tenant=$2 AND challenge_id=$3) AS found',
      [lsn,tenantId,challengeId]);
    const row=observed.rows?.[0];
    const verified=row?.recovering===true&&
      row.found===true&&row.delta!==null&&Number(row.delta)>=0;
    return Object.freeze({
      format:'osmanx-r62-sync-barrier-v1',tenantId,challengeId,
      freshSynchronousCommitConfirmed:true,
      outcomeMayHaveCommittedLocally:true,
      classification:verified?'fresh-wal-replay-observed':
        'replay-proof-incomplete',
      observedLsn:lsn,standbyReplayConfirmed:verified,
      proofSha256:sha({tenantId,challengeId,lsn,verified}),
      mayPromote:false,mayClearPendingIntent:false,
      productionCutoverAllowed:false
    });
  }finally{
    try{connection.release(broken||undefined);}
    finally{connection.off?.('error',onError);}
  }
}
