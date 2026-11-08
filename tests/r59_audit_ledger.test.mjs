import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createR59PgAuditLedger,verifyR59AuditRows}
  from '../src/migration/r59-audit-ledger.mjs';

const enabled=process.env.OX_R59_PG_E2E==='YES';
const config=()=>({
  host:process.env.PGHOST||'127.0.0.1',port:Number(process.env.PGPORT||5432),
  user:process.env.PGUSER||'postgres',password:process.env.PGPASSWORD||'',
  database:process.env.PGDATABASE||'ox_r59',max:6,
  connectionTimeoutMillis:5000,statement_timeout:10000
});
test('R5.9 two PG pools preserve chain sequence, SQL immutability and tamper proof',
  {skip:!enabled,timeout:30000},async()=>{
    const pool=new pg.Pool(config()),other=new pg.Pool(config());
    const tenantId=randomBytes(12).toString('hex'),signingKey=randomBytes(32);
    try{
      await pool.query(await readFile(
        new URL('../ops/r59/audit-schema.sql',import.meta.url),'utf8'));
      const a=createR59PgAuditLedger({pool,tenantId,signingKey});
      const b=createR59PgAuditLedger({pool:other,tenantId,signingKey});
      const writes=Array.from({length:24},(_,i)=>
        (i%2?a:b).append({
          kind:'checkpoint.review',
          actor:i%2?'operator_beta':'operator_alpha',
          evidenceSha256:randomBytes(32).toString('hex')
        }));
      const accepted=await Promise.all(writes);
      const sequences=accepted.map(v=>v.seq).sort((x,y)=>x-y);
      assert.deepEqual(sequences,Array.from({length:24},(_,i)=>i+1));
      const inspected=await a.verify();
      assert.equal(inspected.verified,true);
      assert.equal(inspected.count,24);
      await assert.rejects(other.query(
        "UPDATE ox_r59_audit_chain SET actor='forged_user' WHERE tenant=$1",
        [tenantId]),/append-only/);
      await assert.rejects(other.query(
        'DELETE FROM ox_r59_audit_chain WHERE tenant=$1',[tenantId]),
        /append-only/);
      const state=await other.query(
        'SELECT tenant,seq,prev_mac,mac,kind,actor,evidence_sha,event_nonce,at_ms FROM ox_r59_audit_chain WHERE tenant=$1 ORDER BY seq',
        [tenantId]);
      const tip=(await other.query(
        'SELECT seq,mac FROM ox_r59_audit_tip WHERE tenant=$1',[tenantId]))
        .rows[0];
      const tampered=state.rows.map(x=>({...x}));
      tampered[12].actor='forged_user';
      assert.throws(()=>verifyR59AuditRows({
        rows:tampered,tip,tenantId,signingKey
      }),/broken, reordered or forged/);
      assert.throws(()=>verifyR59AuditRows({
        rows:state.rows,tip,tenantId,signingKey:randomBytes(32)
      }),/broken, reordered or forged/);
      assert.throws(()=>verifyR59AuditRows({
        rows:state.rows.slice(1),tip,tenantId,signingKey
      }),/broken, reordered or forged/);
      assert.throws(()=>verifyR59AuditRows({
        rows:state.rows,tip,tenantId,signingKey,maxRows:10
      }),/invalid audit review configuration/);
      const later=await b.append({
        kind:'operator.review',actor:'operator_gamma',
        evidenceSha256:randomBytes(32).toString('hex')
      });
      assert.equal(later.seq,25);
      assert.equal((await a.verify()).count,25);
    }finally{
      // Isolation-only cleanup requires disposable PG superuser.
      await pool.query('DELETE FROM ox_r59_audit_tip WHERE tenant=$1',
        [tenantId]).catch(()=>{});
      // Immutable audit triggers deliberately prevent DELETE, so isolated
      // test database is destroyed by the CI service, not modified here.
      await Promise.all([pool.end(),other.end()]);
    }
  });
