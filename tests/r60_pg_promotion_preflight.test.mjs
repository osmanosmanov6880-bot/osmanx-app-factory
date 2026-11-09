import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {inspectR60PgPromotionPreflight}
  from '../src/migration/r60-pg-promotion-preflight.mjs';
const TENANT='d'.repeat(24),LSN='0/1000',
  row={epoch:'4',pending_op:'a'.repeat(32),pending_sha:'b'.repeat(64),
    pending_epoch:'4',pending_before_version:null};
function mocks({mode='remote_apply',sync='sync',replay=4,
  standbyRecovering=true,otherRow=row}={}){
  const primary={async query(query){
    if(query.includes('current_setting'))return {rows:[{
      recovering:false,commit_mode:mode,standby_names:'FIRST 1 (r59-standby)'
    }]};
    if(query.includes('pg_stat_replication'))return {rows:[{
      application_name:'r59-standby',state:'streaming',sync_state:sync,
      replay_delta:String(replay)
    }]};
    return {rows:[row]};
  }};
  const standby={async query(query){
    if(query.includes('pg_last_wal_replay_lsn'))return {rows:[{
      recovering:standbyRecovering,replay_lsn:'0/1200',
      replay_delta:String(replay)
    }]};
    return {rows:[otherRow]};
  }};
  return {primary,standby,tenantId:TENANT,requiredLsn:LSN};
}
test('R6.0 synchronous remote_apply PG promotion preflight is strictly read-only',
  async()=>{
    const result=await inspectR60PgPromotionPreflight(mocks());
    assert.equal(result.streamingStandbyReplayConfirmed,true);
    assert.equal(result.primaryStandbyIntentMatching,true);
    assert.equal(result.pendingGeneration,4);
    assert.equal(result.eligibleForIsolatedFailoverDrill,true);
    assert.equal(result.oldPrimaryFencedByThisCheck,false);
    assert.equal(result.automaticPromotionAllowed,false);
    assert.equal(result.productionCutoverAllowed,false);
  });
test('R6.0 refuses asynchronous PG primary and standby replay lag',async()=>{
  for(const options of [{mode:'on'},{sync:'async'},
    {replay:-1},{standbyRecovering:false}]){
    await assert.rejects(inspectR60PgPromotionPreflight(mocks(options)));
  }
});
test('R6.0 refuses mismatched or missing pending intent on replica',async()=>{
  for(const otherRow of [{...row,pending_op:'c'.repeat(32)},
    {...row,pending_sha:null},null]){
    await assert.rejects(inspectR60PgPromotionPreflight(mocks({
      otherRow
    })),/checkpoint|intent|absent/);
  }
});
test('R6.0 fixed opaque tenant and LSN reject cross-tenant injection',async()=>{
  await assert.rejects(inspectR60PgPromotionPreflight({
    ...mocks(),tenantId:'../../other'
  }),/pinned primary/);
  await assert.rejects(inspectR60PgPromotionPreflight({
    ...mocks(),requiredLsn:'1; DROP TABLE audit'
  }),/pinned primary/);
});
test('R6.0 real disposable PG15/16 confirms remote_apply and exact WAL intent',
  {skip:process.env.OX_R60_HA_E2E!=='YES',timeout:30000},async()=>{
    const conf=port=>({
      host:'127.0.0.1',port,user:'postgres',
      password:'r59-disposable-pg',database:'ox_r59',
      connectionTimeoutMillis:5000,statement_timeout:10000
    });
    const primary=new pg.Pool(conf(5543)),standby=new pg.Pool(conf(5544));
    const tenantId=randomBytes(12).toString('hex');
    try{
      await primary.query(await readFile(
        new URL('../ops/r57/schema.sql',import.meta.url),'utf8'));
      await primary.query(
        'INSERT INTO ox_r57_checkpoint_control(tenant,epoch,pending_op,pending_sha,pending_create,pending_epoch) VALUES($1,$2,$3,$4,$5,$6)',
        [tenantId,4,'b'.repeat(32),'c'.repeat(64),true,4]);
      const lsn=(await primary.query(
        'SELECT pg_current_wal_lsn()::text AS lsn'
      )).rows[0].lsn;
      let result=null;
      for(let i=0;i<30;i++){
        try{
          result=await inspectR60PgPromotionPreflight({
            primary,standby,tenantId,requiredLsn:lsn
          });break;
        }catch(e){
          if(i===29)throw e;
          await new Promise(ok=>setTimeout(ok,150));
        }
      }
      assert.equal(result.primaryCommitMode,'remote_apply');
      assert.equal(result.pendingGeneration,4);
      assert.equal(result.eligibleForIsolatedFailoverDrill,true);
      assert.equal(result.automaticPromotionAllowed,false);
    }finally{await Promise.all([primary.end(),standby.end()]);}
  });
