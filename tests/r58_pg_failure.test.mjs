// R5.8 executable PostgreSQL backend-kill drill, NOT a full HA/failover test.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createR57PgCoordinator} from '../src/migration/r57-pg-coordinator.mjs';
import {createR58PgNonceStore} from '../src/migration/r58-nonce-store.mjs';
const enabled=process.env.OX_R58_PG_E2E==='YES';
const H1='a'.repeat(24),H2='b'.repeat(24);
const sha=b=>createHash('sha256').update(b).digest('hex');
function config(){return {
  host:process.env.PGHOST||'127.0.0.1',
  port:Number(process.env.PGPORT||5432),
  user:process.env.PGUSER||'postgres',
  password:process.env.PGPASSWORD||'',
  database:process.env.PGDATABASE||'ox_r58',max:4,
  connectionTimeoutMillis:5000,statement_timeout:12000
};}
async function fixture(){
  const pool=new pg.Pool(config()),secondary=new pg.Pool(config());
  const tenantId=randomBytes(12).toString('hex');
  await pool.query(await readFile(new URL('../ops/r57/schema.sql',import.meta.url),'utf8'));
  await pool.query(await readFile(new URL('../ops/r58/nonce-schema.sql',import.meta.url),'utf8'));
  let bytes=null,version=0,puts=0;
  const remote={
    tenantPrefix:tenantId+'/',role:'pointer-coordinator-only',
    async assertBucketControls(){return {objectLockEnabled:true,versioningEnabled:true};},
    async put(key,body,{ifNoneMatch=false,ifMatch=null}={}){
      assert.equal(key,'r53/head.json');
      if(ifNoneMatch&&bytes)throw Error('CAS conflict');
      if(ifMatch&&bytes&&'"'+sha(bytes)+'"'!==ifMatch)throw Error('CAS conflict');
      bytes=Buffer.from(body);version++;puts++;return true;
    },
    async getWithMetadata(){
      if(!bytes)throw Error('R4.8 S3 denied: GET status 404');
      return {body:Buffer.from(bytes),etag:'"'+sha(bytes)+'"',
        versionId:'synthetic-v'+version};
    },
    async inspectR49Worm(){
      return {objectLockVerified:true,retentionMode:'COMPLIANCE',
        versionId:'synthetic-v'+version};
    }
  };
  return {tenantId,pool,secondary,remote,get puts(){return puts;},
    async close(){
      await secondary.query('DELETE FROM ox_r58_request_nonce WHERE tenant=$1',[tenantId]).catch(()=>{});
      await secondary.query('DELETE FROM ox_r57_checkpoint_control WHERE tenant=$1',[tenantId]).catch(()=>{});
      await Promise.all([pool.end(),secondary.end()]);
    }};
}
test('R5.8 PostgreSQL durable nonce rejects replay from independent pool after restart',
  {skip:!enabled},async()=>{
    const f=await fixture();try{
      const first=createR58PgNonceStore({pool:f.pool,tenantId:f.tenantId});
      const second=createR58PgNonceStore({pool:f.secondary,tenantId:f.tenantId});
      const id=randomBytes(16).toString('hex');
      const settled=await Promise.allSettled([first.consume(id),second.consume(id)]);
      assert.equal(settled.filter(x=>x.status==='fulfilled').length,1);
      assert.equal(settled.filter(x=>x.status==='rejected').length,1);
      await assert.rejects(second.consume(id),/duplicate request ID/);
    }finally{await f.close();}
  });
test('R5.8 killing PostgreSQL backend during final checkpoint ack leaves durable pending intent',
  {skip:!enabled,timeout:30000},async()=>{
    const f=await fixture();try{
      let fired=false;
      const poisoned={
        async connect(){
          const raw=await f.pool.connect();
          return {
            on(event,listener){raw.on(event,listener);return this;},
            off(event,listener){raw.off(event,listener);return this;},
            async query(sql,args){
              if(!fired&&typeof sql==='string'&&
                sql.includes('committed_op=$2')&&
                sql.includes('pending_op=NULL')){
                fired=true;
                const who=await raw.query('SELECT pg_backend_pid() AS pid');
                const killed=await f.secondary.query(
                  'SELECT pg_terminate_backend($1) AS killed',[who.rows[0].pid]);
                assert.equal(killed.rows[0].killed,true);
              }
              return raw.query(sql,args);
            },
            release(error){raw.release(error);}
          };
        }
      };
      const first=createR57PgCoordinator({
        pool:poisoned,privilegedRemote:f.remote,tenantId:f.tenantId,
        syntheticOnly:true
      });
      const other=createR57PgCoordinator({
        pool:f.secondary,privilegedRemote:f.remote,tenantId:f.tenantId,
        syntheticOnly:true
      });
      const lease=await first.acquire({tenant:f.tenantId,holder:H1,ttlMs:20000});
      const signed=Buffer.from('synthetic-checkpoint-commit-finalization');
      await assert.rejects(first.publish({
        lease,body:signed,ifNoneMatch:true,operation:'e'.repeat(32)
      }));
      assert.equal(fired,true);
      assert.equal(f.puts,1);
      const state=await other.inspect(f.tenantId);
      assert.equal(state.pending,true);
      await assert.rejects(other.acquire({
        tenant:f.tenantId,holder:H2,ttlMs:20000
      }),/unresolved S3 intent/);
      const restored=await other.recover(f.tenantId);
      assert.equal(restored.reconciled,true);
      assert.equal(restored.committed.sha256,sha(signed));
      await assert.rejects(other.assertCurrent(lease),/stale/);
      const next=await other.acquire({
        tenant:f.tenantId,holder:H2,ttlMs:20000
      });
      assert.equal(next.epoch,2);
      await other.release(next);
    }finally{await f.close();}
  });
