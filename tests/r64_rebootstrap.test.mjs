import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {readR63PgTimeline}
  from '../src/migration/r63-timeline-rejoin.mjs';
import {inspectR64ReplicaRebootstrap}
  from '../src/migration/r64-rebootstrap.mjs';
const exec=promisify(execFile),id=()=>randomBytes(16).toString('hex'),
  hash=b=>createHash('sha256').update(b).digest('hex'),
  SYSTEM='7392526296213040844';
function snap(nodeId,timeline,extra={}){
  return {nodeId,systemId:SYSTEM,timelineId:timeline,
    prevTimelineId:timeline-1||1,checkpointLsn:'0/1000',
    redoLsn:'0/1000',inRecovery:false,observedAt:Date.now()-1000,
    ...extra};
}
function fixture(options={}){
  return {tenantId:'a'.repeat(24),
    oldPrimarySnapshot:snap('pg-r59-primary',1),
    selectedPrimarySnapshot:snap('pg-r59-standby',2),
    requiredSystemId:SYSTEM,oldPrimaryRunning:false,
    rebuiltReplica:{nodeId:'pg-r64-rebuilt',inRecovery:true,
      systemId:SYSTEM,timeline:2,replayLsn:'0/3000'},
    sourceProbeHash:'a'.repeat(64),replicaProbeHash:'a'.repeat(64),
    ...options};
}
test('R6.4 physically stopped former primary + successor timeline + streamed new replica are lab-only',
  ()=>{
    const report=inspectR64ReplicaRebootstrap(fixture());
    assert.equal(report.labRebootstrapEvidenceComplete,true);
    assert.equal(report.classification,'isolated-rebootstrap-demonstrated');
    assert.equal(report.mayRestartOldPrimary,false);
    assert.equal(report.mayClearOldQuarantine,false);
    assert.equal(report.mayPromoteReplica,false);
    assert.equal(report.productionCutoverAllowed,false);
});
test('R6.4 refuses still-running former primary and stale timeline or missing replay',
  ()=>{
    for(const [change,expected] of [
      [{oldPrimaryRunning:true},'old-primary-still-active'],
      [{selectedPrimarySnapshot:snap('pg-r59-standby',1)},
        'wrong-replica-lineage'],
      [{rebuiltReplica:{...fixture().rebuiltReplica,timeline:1}},
        'wrong-replica-lineage'],
      [{replicaProbeHash:'b'.repeat(64)},'new-replica-replay-mismatch']
    ]){
      const r=inspectR64ReplicaRebootstrap(fixture(change));
      assert.equal(r.classification,expected);
      assert.equal(r.labRebootstrapEvidenceComplete,false);
      assert.equal(r.mayRestartOldPrimary,false);
    }
  });
const enabled=process.env.OX_R64_REBOOTSTRAP_LAB==='YES'&&
  process.env.OX_R40_EPHEMERAL==='YES'&&
  process.env.OX_R59_LAB_ACK==='YES';
const docker=async(args,timeout=30000)=>(
  await exec('docker',args,{timeout,maxBuffer:4*1024*1024})).stdout;
function conf(port){return {host:'127.0.0.1',port,
  user:'postgres',password:'r59-disposable-pg',database:'ox_r59',
  max:3,connectionTimeoutMillis:5000,statement_timeout:12000};}
async function localInsert(pool,tenant,probe,payload){
  const client=await pool.connect();let open=false;
  try{
    await client.query('BEGIN');open=true;
    await client.query('SET LOCAL synchronous_commit=local');
    await client.query(
      'INSERT INTO ox_r64_rebootstrap_probe(tenant,probe_id,payload_sha) '+
      'VALUES($1,$2,$3)',[tenant,probe,payload]);
    await client.query('COMMIT');open=false;
  }finally{
    if(open)await client.query('ROLLBACK').catch(()=>{});
    client.release();
  }
}
test('R6.4 ACTUAL PG15/16: kill old primary, promote standby, rebootstrap clean physical replica and stream new committed probe',
  {skip:!enabled,timeout:120000},async()=>{
    const version=process.env.OX_R59_POSTGRES_VERSION;
    assert(['15','16'].includes(version));
    const tenantId=id().slice(0,24),probe=id(),
      expected=hash('post-promotion-'+probe);
    const old=new pg.Pool(conf(5543)),
      selected=new pg.Pool(conf(5544));
    let rebuilt,created=false,volumeCreated=false,oldClosed=false;
    try{
      await old.query(await readFile(
        new URL('../ops/r64/rebootstrap-schema.sql',import.meta.url),'utf8'));
      const source=await readR63PgTimeline({
        pool:old,nodeId:'pg-r59-primary'});
      const before=await readR63PgTimeline({
        pool:selected,nodeId:'pg-r59-standby'});
      assert.equal(before.inRecovery,true);
      assert.equal(before.systemId,source.systemId);
      await old.end();oldClosed=true;
      await docker(['kill','-s','KILL','pg-r59-primary'],15000);
      const killed=String(await docker([
        'inspect','-f','{{.State.Running}}','pg-r59-primary'
      ],10000)).trim();
      assert.equal(killed,'false');
      const out=String(await docker([
        'exec','pg-r59-standby','psql','-U','postgres','-d','ox_r59',
        '-tAc','SELECT pg_promote(wait => true, wait_seconds => 30)'
      ],38000)).trim();
      assert.equal(out,'t');
      await localInsert(selected,tenantId,id(),hash('init'));
      const leader=await readR63PgTimeline({
        pool:selected,nodeId:'pg-r59-standby'
      });
      assert.equal(leader.inRecovery,false);
      assert(leader.timelineId>source.timelineId);
      await docker(['volume','create','ox-r64-rebuilt'],15000);
      volumeCreated=true;
      const script='set -euo pipefail; '+
        'chown postgres:postgres /replica; chmod 0700 /replica; '+
        'gosu postgres env PGPASSWORD=r59-only-disposable-repl '+
        'pg_basebackup -h pg-r59-standby -p 5432 -U r59_repl '+
        '-D /replica -Fp -Xs -R --checkpoint=fast';
      await docker(['run','--rm','--network','ox-r59-net',
        '-v','ox-r64-rebuilt:/replica',
        '--entrypoint','bash','postgres:'+version,
        '-ec',script],65000);
      await docker(['run','-d','--name','pg-r64-rebuilt',
        '--network','ox-r59-net',
        '-p','127.0.0.1:5564:5432',
        '-v','ox-r64-rebuilt:/var/lib/postgresql/data',
        'postgres:'+version],20000);
      created=true;rebuilt=new pg.Pool(conf(5564));
      let connected=false;
      for(let i=0;i<90;i++){
        try{
          const v=await rebuilt.query(
            'SELECT pg_is_in_recovery() AS recovering');
          if(v.rows[0].recovering===true){connected=true;break;}
        }catch{}
        await new Promise(ok=>setTimeout(ok,180));
      }
      assert.equal(connected,true,'reconstructed PG standby did not start');
      // This probe was NOT present in the initial physical backup.
      // Replay after startup demonstrates a real streaming subscriber.
      await localInsert(selected,tenantId,probe,expected);
      let replicaProbe=null;
      for(let i=0;i<120;i++){
        const q=await rebuilt.query(
          'SELECT payload_sha FROM ox_r64_rebootstrap_probe '+
          'WHERE tenant=$1 AND probe_id=$2',[tenantId,probe]);
        if(q.rows.length===1){replicaProbe=q.rows[0].payload_sha;break;}
        await new Promise(ok=>setTimeout(ok,100));
      }
      const sourceProbe=(await selected.query(
        'SELECT payload_sha FROM ox_r64_rebootstrap_probe '+
        'WHERE tenant=$1 AND probe_id=$2',[tenantId,probe])).rows[0]?.payload_sha;
      assert.equal(sourceProbe,expected);
      assert.equal(replicaProbe,expected);
      const newState=await readR63PgTimeline({
        pool:rebuilt,nodeId:'pg-r64-rebuilt'
      });
      const replayLsn=(await rebuilt.query(
        'SELECT pg_last_wal_replay_lsn()::text AS lsn'
      )).rows[0].lsn;
      const status=inspectR64ReplicaRebootstrap({
        tenantId,oldPrimarySnapshot:source,
        selectedPrimarySnapshot:leader,
        requiredSystemId:source.systemId,
        oldPrimaryRunning:false,
        rebuiltReplica:{nodeId:'pg-r64-rebuilt',
          systemId:newState.systemId,
          timeline:newState.timelineId,
          inRecovery:newState.inRecovery,replayLsn},
        sourceProbeHash:sourceProbe,replicaProbeHash:replicaProbe
      });
      assert.equal(status.labRebootstrapEvidenceComplete,true);
      assert.equal(status.mayRestartOldPrimary,false);
      assert.equal(status.automaticFailbackAllowed,false);
      assert.equal(status.productionCutoverAllowed,false);
      const stillDead=String(await docker([
        'inspect','-f','{{.State.Running}}','pg-r59-primary'
      ])).trim();
      assert.equal(stillDead,'false');
    }finally{
      await Promise.all([
        oldClosed?Promise.resolve():old.end().catch(()=>{}),
        selected.end().catch(()=>{}),rebuilt?.end().catch(()=>{})
      ]);
      if(created)await docker(['rm','-f','pg-r64-rebuilt']).catch(()=>{});
      if(volumeCreated)await docker(['volume','rm',
        'ox-r64-rebuilt']).catch(()=>{});
    }
  });
