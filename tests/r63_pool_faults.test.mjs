import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {observeR63PgPoolFaults}
  from '../src/migration/r63-pool-fault-guard.mjs';
test('R6.3 captures idle PG socket errors as evidence rather than uncaught event',()=>{
  const pool=new EventEmitter();
  const guard=observeR63PgPoolFaults({pool,role:'standby',limit:2,
    now:()=>12345});
  pool.emit('error',Object.assign(Error('Connection terminated unexpectedly'),
    {code:'ECONNRESET'}));
  const report=guard.snapshot();
  assert.equal(report.quarantineRequired,true);
  assert.equal(report.totalFaults,1);
  assert.equal(report.retainedFaults[0].code,'ECONNRESET');
  assert.equal(report.commitOutcomeConfirmed,false);
  assert.equal(report.canPromote,false);
  assert.equal(report.productionCutoverAllowed,false);
  guard.stop();
  assert.equal(pool.listenerCount('error'),0);
});
test('R6.3 bounded audit buffer never equates missing errors with a safe promotion',()=>{
  const pool=new EventEmitter();
  const guard=observeR63PgPoolFaults({pool,role:'primary',limit:2});
  assert.equal(guard.snapshot().canPromote,false);
  for(let i=0;i<9;i++)pool.emit('error',Error('synthetic failure '+i));
  assert.equal(guard.snapshot().totalFaults,9);
  assert.equal(guard.snapshot().retainedFaults.length,2);
  assert.equal(guard.snapshot().quarantineRequired,true);
  guard.stop();
});
test('R6.3 invalid role and missing pool event API denied',()=>{
  assert.throws(()=>observeR63PgPoolFaults({
    pool:new EventEmitter(),role:'unknown'
  }),/pinned PostgreSQL pool/);
  assert.throws(()=>observeR63PgPoolFaults({
    pool:{on(){}},role:'standby'
  }),/pinned PostgreSQL pool/);
});
