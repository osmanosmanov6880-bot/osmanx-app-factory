import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readR63PgTimeline,assessR63PgTimelineRejoin}
  from '../src/migration/r63-timeline-rejoin.mjs';
const run=promisify(execFile);
const SYSTEM='7392526296213040844',NOW=Date.now();
function snapshot(nodeId,timelineId,inRecovery=false,extra={}){
  return {nodeId,systemId:SYSTEM,timelineId,prevTimelineId:
    timelineId>1?timelineId-1:1,checkpointLsn:'0/3000',redoLsn:'0/2000',
    inRecovery,observedAt:NOW-1000,...extra};
}
test('R6.3 higher promoted timeline quarantines old-primary branch',()=>{
  const result=assessR63PgTimelineRejoin({
    oldPrimary:snapshot('pg-r59-primary',1),
    selectedPrimary:snapshot('pg-r59-standby',2),requiredSystemId:SYSTEM,
    now:()=>NOW
  });
  assert.equal(result.classification,'old-primary-timeline-stale');
  assert.equal(result.newTimelineVerified,true);
  assert.equal(result.rejoinAllowed,false);
  assert.equal(result.pgRewindAllowed,false);
  assert.equal(result.productionCutoverAllowed,false);
});
test('R6.3 equal timeline on two read-write nodes is potential split brain',()=>{
  const report=assessR63PgTimelineRejoin({
    oldPrimary:snapshot('pg-r59-primary',1),
    selectedPrimary:snapshot('pg-r59-standby',1),requiredSystemId:SYSTEM,
    now:()=>NOW
  });
  assert.equal(report.classification,'possible-dual-primary');
  assert.equal(report.possibleDualPrimary,true);
  assert.equal(report.automaticPromotionAllowed,false);
});
test('R6.3 wrong system id, old higher timeline and stale evidence fail closed',()=>{
  const foreign=assessR63PgTimelineRejoin({
    oldPrimary:snapshot('pg-r59-primary',1),
    selectedPrimary:snapshot('pg-r59-standby',2,false,
      {systemId:'1234567890123456789'}),requiredSystemId:SYSTEM,
    now:()=>NOW
  });
  assert.equal(foreign.classification,'foreign-postgresql-cluster');
  const regressed=assessR63PgTimelineRejoin({
    oldPrimary:snapshot('pg-r59-primary',3),
    selectedPrimary:snapshot('pg-r59-standby',2),requiredSystemId:SYSTEM,
    now:()=>NOW
  });
  assert.equal(regressed.classification,'selected-primary-timeline-behind');
  assert.throws(()=>assessR63PgTimelineRejoin({
    oldPrimary:snapshot('pg-r59-primary',1),
    selectedPrimary:snapshot('pg-r59-standby',2,false,
      {observedAt:NOW-600000}),
    requiredSystemId:SYSTEM,now:()=>NOW
  }),/stale selected-primary/);
});
test('R6.3 pg_control functions are inspected without write SQL',async()=>{
  const q=[];
  const v=await readR63PgTimeline({
    nodeId:'pg-r59-primary',now:()=>NOW,
    pool:{async query(sql){
      q.push(sql);
      return {rows:[{system_id:SYSTEM,timeline_id:1,
        prev_timeline_id:1,checkpoint_lsn:'0/3000',redo_lsn:'0/2000',
        in_recovery:false}]};
    }}
  });
  assert.equal(v.timelineId,1);
  assert(q[0].includes('pg_control_system()'));
  assert(q[0].includes('pg_control_checkpoint()'));
  assert(q.every(x=>x.startsWith('SELECT')));
});
const enabled=process.env.OX_R63_TIMELINE_LAB==='YES'&&
  process.env.OX_R40_EPHEMERAL==='YES'&&
  process.env.OX_R59_LAB_ACK==='YES';
function conf(port){
  return {host:'127.0.0.1',port,user:'postgres',
    password:'r59-disposable-pg',database:'ox_r59',max:2,
    connectionTimeoutMillis:5000,statement_timeout:12000};
}
test('R6.3 actual PG15/16 physically promoted standby has a newer timeline than stopped primary',
  {skip:!enabled,timeout:60000},async()=>{
    const old=new pg.Pool(conf(5543)),replica=new pg.Pool(conf(5544));
    let promoted;
    try{
      const baseline=await readR63PgTimeline({
        pool:old,nodeId:'pg-r59-primary'
      });
      const previous=await readR63PgTimeline({
        pool:replica,nodeId:'pg-r59-standby'
      });
      assert.equal(previous.inRecovery,true);
      assert.equal(baseline.systemId,previous.systemId);
      await old.end();
      await replica.end();
      await run('docker',['kill','-s','KILL','pg-r59-primary'],
        {timeout:15000});
      const outcome=await run('docker',[
        'exec','pg-r59-standby','psql','-U','postgres','-d','ox_r59',
        '-tAc','SELECT pg_promote(wait => true, wait_seconds => 30)'
      ],{timeout:38000});
      assert.equal(outcome.stdout.trim(),'t');
      promoted=new pg.Pool(conf(5544));
      await promoted.query('CHECKPOINT');
      const selected=await readR63PgTimeline({
        pool:promoted,nodeId:'pg-r59-standby'
      });
      const report=assessR63PgTimelineRejoin({
        oldPrimary:baseline,selectedPrimary:selected,
        requiredSystemId:baseline.systemId
      });
      assert.equal(selected.inRecovery,false);
      assert.equal(report.newTimelineVerified,true);
      assert.equal(report.classification,'old-primary-timeline-stale');
      assert.equal(report.rejoinAllowed,false);
      assert.equal(report.automaticPromotionAllowed,false);
    }finally{
      await promoted?.end().catch(()=>{});
      await old.end().catch(()=>{});
      await replica.end().catch(()=>{});
    }
  });
