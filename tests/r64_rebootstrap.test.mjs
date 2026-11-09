import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {assessR64RebuiltStandby}
  from '../src/migration/r64-rebootstrap-review.mjs';
const run=promisify(execFile),
  enabled=process.env.OX_R64_REBUILD_E2E==='YES'&&
    process.env.OX_R40_EPHEMERAL==='YES'&&
    process.env.OX_R59_LAB_ACK==='YES';
const SYS='7392526296213040844';
function node(nodeId,timelineId,inRecovery){
  return {system_id:SYS,timeline_id:timelineId,
    prev_timeline_id:timelineId>1?timelineId-1:1,
    checkpoint_lsn:'0/5000',redo_lsn:'0/4000',
    in_recovery:inRecovery};
}
function fake({timeline=2,copyTimeline=2,
  followerRecovery=true,delta='10'}={}){
  const selectedPool={async query(sql){
    if(sql.includes('pg_control_'))return {rows:[node('selected',timeline,false)]};
    throw Error('unexpected query on source');
  }};
  const rebuiltPool={async query(sql){
    if(sql.includes('pg_control_'))
      return {rows:[node('rebuilt',copyTimeline,followerRecovery)]};
    return {rows:[{recovering:followerRecovery,replay_lsn:'0/5000',
      delta,default_transaction_read_only:'off'}]};
  }};
  return {selectedPool,rebuiltPool,requiredLsn:'0/4000'};
}
test('R6.4 observed new timeline and replay-confirmed physical follower never grant rejoin',
  async()=>{
    const status=await assessR64RebuiltStandby(fake());
    assert.equal(status.freshReplicaDataVerified,true);
    assert.equal(status.rebootstrapEvidenceComplete,true);
    assert.equal(status.replicaInRecovery,true);
    assert.equal(status.oldPrimaryReused,false);
    assert.equal(status.mayUnquarantineOldPrimary,false);
    assert.equal(status.mayPromoteReplica,false);
    assert.equal(status.productionCutoverAllowed,false);
  });
test('R6.4 wrong timeline, promoted replica and WAL lag fail closed',async()=>{
  for(const opts of [{copyTimeline:1},{followerRecovery:false},
    {delta:'-1'},{timeline:1}]){
    await assert.rejects(assessR64RebuiltStandby(fake(opts)));
  }
  await assert.rejects(assessR64RebuiltStandby({
    ...fake(),requiredLsn:'DROP DATABASE'
  }),/separate live PostgreSQL/);
});
function conf(port){
  return {host:'127.0.0.1',port,user:'postgres',
    password:'r59-disposable-pg',database:'ox_r59',max:3,
    connectionTimeoutMillis:5000,statement_timeout:12000};
}
async function docker(args,timeout=30000){
  return run('docker',args,{timeout,maxBuffer:4*1024*1024});
}
test('R6.4 ACTUAL PG15/16 rebootstrap former leader from promoted standby into NEW disposable volume',
  {skip:!enabled,timeout:115000},async()=>{
    const version=process.env.OX_R59_POSTGRES_VERSION;
    assert(['15','16'].includes(version));
    const old=new pg.Pool(conf(5543)),standby=new pg.Pool(conf(5544));
    let selected=null,rebuilt=null,createdVolume=false,createdNode=false;
    const tenantId=randomBytes(12).toString('hex');
    try{
      await old.query(await readFile(
        new URL('../ops/r57/schema.sql',import.meta.url),'utf8'));
      await old.query(
        'INSERT INTO ox_r57_checkpoint_control'+
        '(tenant,epoch,pending_op,pending_sha,pending_epoch,pending_create)'+
        ' VALUES($1,$2,$3,$4,$5,$6)',
        [tenantId,17,'a'.repeat(32),'b'.repeat(64),17,true]);
      const row=(await standby.query(
        'SELECT pending_op FROM ox_r57_checkpoint_control WHERE tenant=$1',
        [tenantId])).rows[0];
      assert.equal(row.pending_op,'a'.repeat(32));
      await old.end();
      await standby.end();
      const oldStopped=await docker(['kill','-s','KILL','pg-r59-primary'],15000);
      assert(oldStopped.stdout.includes('pg-r59-primary'));
      const promoted=await docker(['exec','pg-r59-standby','psql','-U',
        'postgres','-d','ox_r59','-tAc',
        'SELECT pg_promote(wait => true,wait_seconds => 30)'],38000);
      assert.equal(promoted.stdout.trim(),'t');
      selected=new pg.Pool(conf(5544));
      await selected.query('CREATE TABLE ox_r64_rejoin_probe(id integer PRIMARY KEY)');
      await selected.query('INSERT INTO ox_r64_rejoin_probe(id) VALUES($1)',[2026]);
      const requiredLsn=(await selected.query(
        'SELECT pg_current_wal_lsn()::text AS lsn'
      )).rows[0].lsn;
      await docker(['volume','create','ox-r64-rebuilt-old'],15000);
      createdVolume=true;
      const command='set -euo pipefail; chown postgres:postgres /rebuild; '+
        'chmod 0700 /rebuild; '+
        'gosu postgres env PGPASSWORD=r59-only-disposable-repl '+
        'pg_basebackup -h pg-r59-standby -U r59_repl '+
        '-D /rebuild -Fp -Xs -R --checkpoint=fast';
      await docker(['run','--rm','--network','ox-r59-net',
        '-v','ox-r64-rebuilt-old:/rebuild','--entrypoint','bash',
        'postgres:'+version,'-ec',command],65000);
      await docker(['run','-d','--name','pg-r64-rebuilt-old',
        '--network','ox-r59-net','-p','127.0.0.1:5566:5432',
        '-v','ox-r64-rebuilt-old:/var/lib/postgresql/data',
        'postgres:'+version],20000);
      createdNode=true;
      rebuilt=new pg.Pool(conf(5566));
      let report=null;
      for(let i=0;i<70;i++){
        try{
          report=await assessR64RebuiltStandby({
            selectedPool:selected,rebuiltPool:rebuilt,requiredLsn
          });
          break;
        }catch(e){
          if(i===69)throw e;
          await new Promise(ok=>setTimeout(ok,250));
        }
      }
      assert.equal(report.freshReplicaDataVerified,true);
      assert.equal(report.selectedTimeline,report.rebuiltTimeline);
      assert.equal(report.replicaInRecovery,true);
      assert.equal(report.replayDifferenceBytes>=0,true);
      const probe=(await rebuilt.query(
        'SELECT id FROM ox_r64_rejoin_probe')).rows[0].id;
      assert.equal(probe,2026);
      const persisted=(await rebuilt.query(
        'SELECT pending_op FROM ox_r57_checkpoint_control WHERE tenant=$1',
        [tenantId])).rows[0].pending_op;
      assert.equal(persisted,'a'.repeat(32));
      await assert.rejects(rebuilt.query(
        'INSERT INTO ox_r64_rejoin_probe VALUES(2027)'
      ),/read-only|recovery/);
      const oldState=await docker(['inspect','-f',
        '{{.State.Running}}','pg-r59-primary'],15000);
      assert.equal(oldState.stdout.trim(),'false');
      assert.equal(report.mayUnquarantineOldPrimary,false);
    }finally{
      await Promise.all([
        old.end().catch(()=>{}),standby.end().catch(()=>{}),
        selected?.end().catch(()=>{}),rebuilt?.end().catch(()=>{})
      ]);
      if(createdNode)await docker(['rm','-f','pg-r64-rebuilt-old']).catch(()=>{});
      if(createdVolume)await docker(['volume','rm',
        'ox-r64-rebuilt-old']).catch(()=>{});
    }
  });
