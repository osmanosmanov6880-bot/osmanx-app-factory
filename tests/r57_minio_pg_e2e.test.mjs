// Real disposable MinIO + PG + local SQLite + independent signed witness.
// Requires isolated CI flags. No production data, endpoints or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {crmDb} from '../src/crm/db.mjs';
import {installR53Capture} from '../src/migration/r53-commit-journal.mjs';
import {r53WitnessTenant} from '../src/migration/r53-incremental.mjs';
import {createR48S3Transport} from '../src/migration/r48-s3.mjs';
import {createR48WitnessReceiver,createR48WitnessClient}
  from '../src/migration/r48-witness.mjs';
import {commitR55SyntheticTransaction} from '../src/migration/r55-commit-latency.mjs';
import {createR57ScopedS3Capabilities} from '../src/migration/r57-s3-scope.mjs';
import {createR57PgCoordinator} from '../src/migration/r57-pg-coordinator.mjs';
import {runR56CoordinatorPublisher} from '../src/migration/r56-publisher.mjs';

const enabled=process.env.OX_R57_MINIO_E2E==='YES'&&
  process.env.OX_R40_EPHEMERAL==='YES';
const A='a'.repeat(24),B='b'.repeat(24);
const projectId='11111111-1111-4111-8111-111111111111';
const pgConfig={
  host:process.env.PGHOST||'127.0.0.1',
  port:Number(process.env.PGPORT||5432),
  user:process.env.PGUSER||'postgres',
  password:process.env.PGPASSWORD||'',
  database:process.env.PGDATABASE||'ox_r57',
  connectionTimeoutMillis:5000,statement_timeout:20000
};
async function fixture(){
  const tenantId=randomBytes(12).toString('hex');
  const root=await mkdtemp(join(tmpdir(),'ox-r57-real-minio-'));
  const pool=new pg.Pool(pgConfig);
  const otherPool=new pg.Pool(pgConfig);
  await pool.query(await readFile(new URL('../ops/r57/schema.sql',import.meta.url),'utf8'));
  const db=crmDb(join(root,'primary.sqlite'));
  installR53Capture(db,{syntheticOnly:true});
  const vault={projectId,manifestSha256:'a'.repeat(64),catalogKey:randomBytes(32)};
  const deltaKey=randomBytes(32),baselineArchiveId='e'.repeat(32);
  const token=randomBytes(32).toString('hex'),secret=randomBytes(32);
  const witnessServer=createServer(createR48WitnessReceiver({
    root:join(root,'witness'),token,secret
  }));
  await new Promise(ok=>witnessServer.listen(0,'127.0.0.1',ok));
  const witness=createR48WitnessClient({
    endpoint:'http://127.0.0.1:'+witnessServer.address().port+'/',
    token,secret,tenant:r53WitnessTenant(vault.catalogKey,projectId),
    allowSyntheticLoopback:true
  });
  const raw=createR48S3Transport({
    endpoint:process.env.OX_R57_MINIO_ENDPOINT||'http://127.0.0.1:9000/',
    bucket:process.env.OX_R57_MINIO_BUCKET,
    region:'us-east-1',
    accessKey:process.env.OX_R57_MINIO_ACCESS_KEY,
    secretKey:process.env.OX_R57_MINIO_SECRET_KEY,
    projectPrefix:tenantId+'/',allowSyntheticLoopback:true
  });
  const {publisher,coordinator}=createR57ScopedS3Capabilities({
    transport:raw,tenantId
  });
  const make=(pgPool,fault=()=>{})=>createR57PgCoordinator({
    pool:pgPool,privilegedRemote:coordinator,tenantId,syntheticOnly:true,fault
  });
  const args={sourceDb:db,vault,remote:publisher,witness,deltaKey,
    baselineArchiveId,syntheticOnly:true,tenant:tenantId,ttlMs:20000};
  function write(title){
    commitR55SyntheticTransaction({sourceDb:db,syntheticOnly:true,
      transaction(tx){
        const stamp=new Date().toISOString();
        tx.prepare('INSERT INTO tasks(id,title,created_at,updated_at) VALUES(?,?,?,?)')
          .run(randomUUID(),title,stamp,stamp);
      }});
  }
  return {root,tenantId,pool,otherPool,witness,make,args,write,
    async close(){
      db.close();
      await new Promise(ok=>witnessServer.close(ok));
      await pool.query('DELETE FROM ox_r57_checkpoint_control WHERE tenant=$1',
        [tenantId]).catch(()=>{});
      await Promise.all([pool.end(),otherPool.end()]);
      await rm(root,{recursive:true,force:true});
    }};
}
test('R5.7 PG15/16 + true COMPLIANCE MinIO + SQLite CDC + independent witness crash repair',
  {skip:!enabled,timeout:120000},async()=>{
    const f=await fixture();try{
      const first=f.make(f.pool);
      f.write('Original committed CRM row');
      const one=await runR56CoordinatorPublisher({
        ...f.args,coordinator:first,holder:A});
      assert.equal(one.publishedEvents,1);
      assert.equal(one.checkpointSequence,1);
      assert.equal(one.independentWitnessVerified,true);
      f.write('Second committed CRM row after checkpoint');
      let injected=true;
      const crashed=f.make(f.otherPool,stage=>{
        if(stage==='after-put'&&injected){
          injected=false;throw Error('simulated process loss after real MinIO PUT');
        }
      });
      await assert.rejects(runR56CoordinatorPublisher({
        ...f.args,coordinator:crashed,holder:B}),/simulated process loss/);
      assert.equal((await f.witness.current()).entries,1);
      const recovered=f.make(f.pool);
      const state=await recovered.recover(f.tenantId);
      assert.equal(state.reconciled,true);
      const final=await runR56CoordinatorPublisher({
        ...f.args,coordinator:recovered,holder:A});
      assert.equal(final.reconciliation.recoveredOrphan,true);
      assert.equal(final.checkpointSequence,2);
      assert.equal(final.publishedEvents,0);
      assert.equal((await f.witness.current()).entries,2);
      assert.equal(final.productionCutoverAllowed,false);
    }finally{await f.close();}
  });
