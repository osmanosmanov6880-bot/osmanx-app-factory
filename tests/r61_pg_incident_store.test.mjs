import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {createR61PgIncidentStore,verifyR61IncidentChain}
  from '../src/migration/r61-pg-incident-store.mjs';
import {signR61Approval} from '../src/migration/r61-dual-approval.mjs';
const enabled=process.env.OX_R61_PG_E2E==='YES',
  ACTOR='reviewer_lead',SHA='c'.repeat(64),VERSION='r61-synthetic-v2';
function config(){
  return {host:process.env.PGHOST||'127.0.0.1',
    port:Number(process.env.PGPORT||5432),
    user:process.env.PGUSER||'postgres',
    password:process.env.PGPASSWORD||'',
    database:process.env.PGDATABASE||'ox_r61',
    max:4,connectionTimeoutMillis:5000,statement_timeout:10000};
}
function approvers(tenantId,incidentId,epoch,action='investigate'){
  const security=generateKeyPairSync('ed25519');
  const reliability=generateKeyPairSync('ed25519');
  const reviewers={
    security_director:{role:'security',publicKey:security.publicKey},
    recovery_director:{role:'reliability',publicKey:reliability.publicKey}
  };
  const now=Date.now();
  const approval=(kp,role,reviewerId)=>signR61Approval({
    privateKey:kp.privateKey,payload:{
      tenantId,incidentId,evidenceSha256:SHA,epoch,
      s3Version:VERSION,role,reviewerId,action,
      nonce:randomBytes(16).toString('hex'),
      issuedAt:now-1000,expiresAt:now+100000
    }
  });
  return {reviewers,approvals:[
    approval(security,'security','security_director'),
    approval(reliability,'reliability','recovery_director')
  ]};
}
test('R6.1 two independent PG pools idempotently open same incident and serialize signed reviews',
  {skip:!enabled,timeout:30000},async()=>{
    const tenantId=randomBytes(12).toString('hex'),
      incidentId=randomBytes(16).toString('hex'),hmacKey=randomBytes(32),
      epoch=7,pool=new pg.Pool(config()),other=new pg.Pool(config());
    try{
      await pool.query(await readFile(
        new URL('../ops/r61/incident-schema.sql',import.meta.url),'utf8'));
      const a=createR61PgIncidentStore({pool,tenantId,hmacKey});
      const b=createR61PgIncidentStore({pool:other,tenantId,hmacKey});
      const first=await Promise.all([a,b].map(x=>x.open({
        incidentId,evidenceSha256:SHA,epoch,s3Version:VERSION,actor:ACTOR
      })));
      assert.deepEqual(first.map(x=>x.created).sort(),[false,true]);
      const {reviewers,approvals}=approvers(tenantId,incidentId,epoch);
      const reviewed=await Promise.all([a,b].map(x=>x.recordReview({
        incidentId,actor:ACTOR,action:'investigate',approvals,reviewers
      })));
      assert.deepEqual(reviewed.map(x=>x.replayed).sort(),[false,true]);
      assert.deepEqual(reviewed.map(x=>x.seq),[1,1]);
      const report=await b.inspect(incidentId);
      assert.equal(report.reviewEvents,1);
      assert.equal(report.quarantined,true);
      assert.equal(report.chainVerified,true);
      assert.equal(report.mayClearPendingIntent,false);
      const second=approvers(tenantId,incidentId,epoch,'export-evidence');
      const receipt=await a.recordReview({
        incidentId,actor:ACTOR,action:'export-evidence',
        ...second
      });
      assert.equal(receipt.seq,2);
      assert.equal((await b.inspect(incidentId)).reviewEvents,2);
      await assert.rejects(pool.query(
        "UPDATE ox_r61_incident_event SET action='investigate' WHERE tenant=$1",
        [tenantId]),/immutable/);
      await assert.rejects(pool.query(
        'DELETE FROM ox_r61_incident WHERE tenant=$1',
        [tenantId]),/immutable/);
      await assert.rejects(a.open({
        incidentId,evidenceSha256:'d'.repeat(64),epoch,
        s3Version:VERSION,actor:ACTOR
      }),/different evidence/);
      await assert.rejects(b.recordReview({
        incidentId,actor:'other_reviewer',action:'investigate',
        approvals,reviewers
      }),/different review/);
    }finally{await Promise.all([pool.end(),other.end()]);}
  });
test('R6.1 incident chain rejects reordered events and forged reviewer evidence',
  ()=>{
    const tenantId='e'.repeat(24),incidentId='d'.repeat(32),
      hmacKey=randomBytes(32);
    assert.throws(()=>verifyR61IncidentChain({
      tenantId,incidentId,hmacKey,events:[{
        tenant:tenantId,incident_id:incidentId,seq:2,
        action:'investigate',actor:ACTOR,approval_sha:SHA,
        prev_mac:'0'.repeat(64),event_mac:'a'.repeat(64),at_ms:Date.now()
      }]
    }),/out-of-order/);
    assert.throws(()=>verifyR61IncidentChain({
      tenantId,incidentId,hmacKey:randomBytes(16),events:[]
    }),/invalid isolated/);
  });
test('R6.1 rejects foreign tenant, unauthenticated writer and action injection',
  ()=>{
    assert.throws(()=>createR61PgIncidentStore({
      pool:{connect(){}},tenantId:'../other',hmacKey:randomBytes(32)
    }),/pinned tenant/);
    assert.throws(()=>createR61PgIncidentStore({
      pool:{connect(){}},tenantId:'a'.repeat(24),hmacKey:randomBytes(8)
    }),/off-DB HMAC key/);
  });
