import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createR63PgQuarantine,verifyR63QuarantineEvents}
  from '../src/migration/r63-pg-quarantine.mjs';
const TENANT='a'.repeat(24),CLUSTER='b'.repeat(24),
  CASE='c'.repeat(32),NODE='pg-r59-primary',EVIDENCE='d'.repeat(64),
  SYSTEM='7392526296213040844',ACTOR='recovery_reviewer';
const enabled=process.env.OX_R63_PG_E2E==='YES'&&
  process.env.OX_R40_EPHEMERAL==='YES';
function conf(){
  return {host:process.env.PGHOST||'127.0.0.1',
    port:Number(process.env.PGPORT||5432),
    user:process.env.PGUSER||'postgres',
    password:process.env.PGPASSWORD||'',
    database:process.env.PGDATABASE||'ox_r63',max:4,
    connectionTimeoutMillis:5000,statement_timeout:10000};
}
const args=(caseId=CASE)=>({
  incidentId:caseId,nodeId:NODE,systemId:SYSTEM,
  oldTimeline:1,newTimeline:2,evidenceSha256:EVIDENCE
});
test('R6.3 PG15/16 idempotent immutable node quarantine across 2 pools and HMAC reviewed chain',
  {skip:!enabled,timeout:30000},async()=>{
    const p1=new pg.Pool(conf()),p2=new pg.Pool(conf()),
      tenantId=randomBytes(12).toString('hex'),
      clusterId=randomBytes(12).toString('hex'),
      incidentId=randomBytes(16).toString('hex'),
      hmacKey=randomBytes(32),first=args(incidentId);
    try{
      await p1.query(await readFile(
        new URL('../ops/r63/quarantine-schema.sql',import.meta.url),'utf8'));
      const a=createR63PgQuarantine({
        pool:p1,tenantId,clusterId,hmacKey
      });
      const b=createR63PgQuarantine({
        pool:p2,tenantId,clusterId,hmacKey
      });
      const opened=await Promise.all([a,b].map(x=>x.quarantine(first)));
      assert.deepEqual(opened.map(x=>x.created).sort(),[false,true]);
      await assert.rejects(a.quarantine({
        ...first,newTimeline:3
      }),/different timeline evidence/);
      const reviews=await Promise.all([a,b].map(x=>x.review({
        incidentId,nodeId:NODE,action:'inspect',
        actor:ACTOR,evidenceSha256:EVIDENCE
      })));
      assert.deepEqual(reviews.map(x=>x.replayed).sort(),[false,true]);
      assert.deepEqual(reviews.map(x=>x.seq),[1,1]);
      const second=await a.review({
        incidentId,nodeId:NODE,action:'rebootstrap-required',
        actor:ACTOR,evidenceSha256:EVIDENCE
      });
      assert.equal(second.seq,2);
      const info=await b.inspect({incidentId,nodeId:NODE});
      assert.equal(info.quarantined,true);
      assert.equal(info.oldPrimaryRejoinAllowed,false);
      assert.equal(info.chainVerified,true);
      assert.equal(info.reviewEvents,2);
      assert.equal(info.oldTimeline,1);
      assert.equal(info.selectedTimeline,2);
      await assert.rejects(p1.query(
        'UPDATE ox_r63_node_quarantine SET selected_timeline=3 WHERE tenant=$1',
        [tenantId]),/immutable/);
      await assert.rejects(p1.query(
        'DELETE FROM ox_r63_quarantine_review WHERE tenant=$1',
        [tenantId]),/immutable/);
      const replaced=await p2.query(
        'SELECT count(*)::integer AS n FROM ox_r63_node_quarantine WHERE tenant=$1',
        [tenantId]);
      assert.equal(replaced.rows[0].n,1);
    }finally{
      await Promise.all([p1.end(),p2.end()]);
    }
  });
test('R6.3 offline verification rejects reordered, forged and missing HMAC event',
  ()=>{
    const key=randomBytes(32),one={
      tenant:TENANT,cluster_id:CLUSTER,incident_id:CASE,
      node_id:NODE,seq:3,action:'inspect',actor:ACTOR,
      evidence_sha:EVIDENCE,prev_mac:'0'.repeat(64),
      event_mac:'f'.repeat(64),at_ms:Date.now()
    };
    assert.throws(()=>verifyR63QuarantineEvents({
      events:[one],tenantId:TENANT,clusterId:CLUSTER,
      incidentId:CASE,nodeId:NODE,hmacKey:key
    }),/missing, reordered or forged/);
    assert.throws(()=>verifyR63QuarantineEvents({
      events:[],tenantId:TENANT,clusterId:CLUSTER,
      incidentId:CASE,nodeId:NODE,hmacKey:randomBytes(16)
    }),/bounded tenant-pinned/);
  });
test('R6.3 cannot instantiate unscoped writer or foreign tenant',()=>{
  assert.throws(()=>createR63PgQuarantine({
    pool:{connect(){}},tenantId:'../other',
    clusterId:CLUSTER,hmacKey:randomBytes(32)
  }),/isolated pool/);
  assert.throws(()=>createR63PgQuarantine({
    pool:{connect(){}},tenantId:TENANT,
    clusterId:CLUSTER,hmacKey:randomBytes(16)
  }),/isolated pool/);
});
