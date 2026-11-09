import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {runR62SyntheticSyncBarrier} from '../src/migration/r62-sync-barrier.mjs';
import {signR62FenceObservation} from '../src/migration/r62-fence-evidence.mjs';
import {observeR63PgPoolFaults} from '../src/migration/r63-pool-fault-guard.mjs';
const run=promisify(execFile),TENANT='a'.repeat(24),CHALLENGE='b'.repeat(32);
function mock({sync='remote_apply',standby=true,commitFailure=false,
  commitHang=false,found=true,delta='0'}={}){
  const query=async(sql)=>{
    if(sql.includes("current_setting"))return {rows:[{recovering:false,mode:sync}]};
    if(sql.includes('pg_current_wal_lsn'))return {rows:[{lsn:'0/1000'}]};
    if(sql==='COMMIT'&&commitFailure)throw Error('canceling statement due to statement timeout');
    if(sql==='COMMIT'&&commitHang)return new Promise(()=>{});
    return {rows:[]};
  };
  const primary={
    async connect(){return {query,release(){},on(){},off(){}};}
  };
  const secondary={async query(sql){
    if(sql==='SELECT pg_is_in_recovery() AS recovering')
      return {rows:[{recovering:standby}]};
    return {rows:[{recovering:standby,found,delta}]};
  }};
  return {primary,standby:secondary,tenantId:TENANT,
    challengeId:CHALLENGE,syntheticOnly:true};
}
test('R6.2 new remote_apply WAL challenge is observed on replaying standby',async()=>{
  const x=await runR62SyntheticSyncBarrier(mock());
  assert.equal(x.freshSynchronousCommitConfirmed,true);
  assert.equal(x.standbyReplayConfirmed,true);
  assert.equal(x.classification,'fresh-wal-replay-observed');
  assert.equal(x.mayPromote,false);
  assert.equal(x.mayClearPendingIntent,false);
});
test('R6.2 timed-out synchronous COMMIT is ambiguous, never a rollback certificate',async()=>{
  const x=await runR62SyntheticSyncBarrier(mock({commitFailure:true}));
  assert.equal(x.freshSynchronousCommitConfirmed,false);
  assert.equal(x.outcomeMayHaveCommittedLocally,true);
  assert.equal(x.classification,'unconfirmed-synchronous-commit');
  assert.equal(x.mayPromote,false);
});
test('R6.2 blackholed COMMIT has bounded independent deadline and cannot clear pending',
  {timeout:6000},async()=>{
    const start=Date.now();
    const x=await runR62SyntheticSyncBarrier({
      ...mock({commitHang:true}),timeoutMs:500
    });
    assert.equal(x.freshSynchronousCommitConfirmed,false);
    assert.equal(x.outcomeMayHaveCommittedLocally,true);
    assert.equal(x.mayPromote,false);
    assert.equal(x.mayClearPendingIntent,false);
    assert(Date.now()-start<5000);
  });
test('R6.2 wrong recovery mode, async leader, missing replay or invalid scope denied',
  async()=>{
    await assert.rejects(runR62SyntheticSyncBarrier(mock({sync:'on'})),
      /primary must run remote_apply/);
    await assert.rejects(runR62SyntheticSyncBarrier(mock({standby:false})),
      /standby is no longer in recovery/);
    const r=await runR62SyntheticSyncBarrier(mock({found:false}));
    assert.equal(r.standbyReplayConfirmed,false);
    assert.equal(r.mayPromote,false);
    await assert.rejects(runR62SyntheticSyncBarrier({
      ...mock(),tenantId:'../other'
    }),/disposable lab/);
  });
const enabled=process.env.OX_R62_PARTITION_LAB==='YES'&&
  process.env.OX_R40_EPHEMERAL==='YES'&&
  process.env.OX_R59_LAB_ACK==='YES';
function config(port){
  return {host:'127.0.0.1',port,user:'postgres',
    password:'r59-disposable-pg',database:'ox_r59',
    connectionTimeoutMillis:5000,statement_timeout:15000,max:3};
}
test('R6.2 REAL Docker network partition: old primary still alive, sync COMMIT not acknowledged, no promotion',
  {skip:!enabled,timeout:60000},async()=>{
    const primary=new pg.Pool(config(5543)),standby=new pg.Pool(config(5544));
    const tenantId=randomBytes(12).toString('hex');
    // Disconnected standby can emit an async idle pg.Pool socket error
    // after the Docker network is severed. Record it: this is evidence of
    // network failure, never proof the former primary was fenced.
    const primaryFaults=observeR63PgPoolFaults({pool:primary,role:'primary'});
    const standbyFaults=observeR63PgPoolFaults({pool:standby,role:'standby'});
    let disconnected=false;
    try{
      await primary.query(await readFile(
        new URL('../ops/r62/barrier-schema.sql',import.meta.url),'utf8'));
      const before=await runR62SyntheticSyncBarrier({
        primary,standby,tenantId,
        challengeId:randomBytes(16).toString('hex'),
        syntheticOnly:true
      });
      assert.equal(before.standbyReplayConfirmed,true);
      const live=(await primary.query('SELECT pg_is_in_recovery() AS standby'))
        .rows[0].standby;
      assert.equal(live,false);
      await run('docker',['network','disconnect','-f',
        'ox-r59-net','pg-r59-standby'],{timeout:15000});
      disconnected=true;
      const state=await run('docker',[
        'inspect','-f','{{.State.Running}}','pg-r59-primary'
      ],{timeout:15000});
      assert.equal(state.stdout.trim(),'true');
      // Disconnected Docker containers may lose the host-mapped PG port.
      // Inspect standby from INSIDE the actual container without trusting
      // a stale network connection or pretending the partition is healed.
      const follower=await run('docker',[
        'exec','pg-r59-standby','psql','-U','postgres','-d','ox_r59',
        '-tAc','SELECT pg_is_in_recovery()'
      ],{timeout:15000});
      assert.equal(follower.stdout.trim(),'t');
      const partitionedStandby={async query(sql){
        assert.equal(sql,'SELECT pg_is_in_recovery() AS recovering');
        return {rows:[{recovering:true}]};
      }};
      const after=await runR62SyntheticSyncBarrier({
        primary,standby:partitionedStandby,tenantId,
        challengeId:randomBytes(16).toString('hex'),
        timeoutMs:1500,syntheticOnly:true
      });
      assert.equal(after.freshSynchronousCommitConfirmed,false);
      assert.equal(after.classification,'unconfirmed-synchronous-commit');
      assert.equal(after.outcomeMayHaveCommittedLocally,true);
      assert.equal(after.mayPromote,false);
      const key=generateKeyPairSync('ed25519');
      const timestamp=Date.now();
      const attempted={
        scope:'disposable-lab',tenantId,clusterId:randomBytes(12).toString('hex'),
        incidentId:randomBytes(16).toString('hex'),epoch:1,
        intentSha256:randomBytes(32).toString('hex'),
        challengeSha256:randomBytes(32).toString('hex'),
        primaryNode:'pg-r59-primary',standbyNode:'pg-r59-standby',
        requiredLsn:'0/1000',primaryPowerState:'unreachable',
        standbyInRecovery:true,standbyReplayVerified:false,
        role:'fence-observer',observerId:'fence_observer',
        nonce:randomBytes(16).toString('hex'),
        issuedAt:timestamp-100,expiresAt:timestamp+30000
      };
      assert.throws(()=>signR62FenceObservation({
        payload:attempted,privateKey:key.privateKey
      }),/non-terminated primary/);
    }finally{
      if(disconnected)await run('docker',['network','connect',
        'ox-r59-net','pg-r59-standby']).catch(()=>{});
      await Promise.all([primary.end().catch(()=>{}),
        standby.end().catch(()=>{})]);
      const observed=standbyFaults.stop();
      const former=primaryFaults.stop();
      assert.equal(observed.canPromote,false);
      assert.equal(former.canPromote,false);
    }
  });
