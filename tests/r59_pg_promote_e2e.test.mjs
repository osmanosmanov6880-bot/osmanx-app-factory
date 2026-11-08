import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createR48S3Transport} from '../src/migration/r48-s3.mjs';
import {createR57ScopedS3Capabilities}
  from '../src/migration/r57-s3-scope.mjs';
import {createR57PgCoordinator}
  from '../src/migration/r57-pg-coordinator.mjs';

const run=promisify(execFile),SHA=b=>createHash('sha256').update(b).digest('hex');
const enabled=process.env.OX_R59_LAB_ACK==='YES'&&
  process.env.OX_R59_DOCKER_FAILOVER==='YES'&&
  process.env.OX_R40_EPHEMERAL==='YES';
function config(port){
  return {host:'127.0.0.1',port,user:'postgres',
    password:'r59-disposable-pg',database:'ox_r59',
    connectionTimeoutMillis:7000,statement_timeout:15000,max:3};
}
async function waitReplicated(standby,lsn){
  for(let i=0;i<100;i++){
    const result=await standby.query(
      'SELECT pg_wal_lsn_diff(pg_last_wal_replay_lsn(),$1::pg_lsn) AS lag',
      [lsn]);
    if(result.rows[0].lag!==null&&Number(result.rows[0].lag)>=0)return;
    await new Promise(ok=>setTimeout(ok,200));
  }
  throw Error('R5.9 physical replica never replayed durable pending intent WAL');
}
test('R5.9 actual primary container KILL and physical-standby promotion preserve checkpoint intent',
  {skip:!enabled,timeout:120000},async()=>{
    const tenantId=randomBytes(12).toString('hex');
    const primary=new pg.Pool(config(5543));
    const standbyRead=new pg.Pool(config(5544));
    let promoted=null,primaryClosed=false,standbyClosed=false;
    try{
      await primary.query(await readFile(
        new URL('../ops/r57/schema.sql',import.meta.url),'utf8'));
      const raw=createR48S3Transport({
        endpoint:'http://127.0.0.1:9000/',
        bucket:'r59-failover-worm',
        region:'us-east-1',
        accessKey:'R59CIACCESS01',
        secretKey:'R59_DISPOSABLE_MINIO_NEVER_PRODUCTION_2026',
        projectPrefix:tenantId+'/',allowSyntheticLoopback:true
      });
      const {coordinator:remote}=createR57ScopedS3Capabilities({
        transport:raw,tenantId
      });
      const first=createR57PgCoordinator({
        pool:primary,privilegedRemote:remote,tenantId,
        syntheticOnly:true,
        fault(stage){
          if(stage==='after-put')
            throw Error('synthetic coordinator lost after real MinIO PUT');
        }
      });
      const lease=await first.acquire({
        tenant:tenantId,holder:'a'.repeat(24),ttlMs:20000
      });
      const checkpoint=Buffer.from('R59 isolated signed checkpoint candidate');
      await assert.rejects(first.publish({
        lease,body:checkpoint,ifNoneMatch:true,operation:'d'.repeat(32)
      }),/coordinator lost/);
      const pending=await first.inspect(tenantId);
      assert.equal(pending.pending,true);
      const lsn=(await primary.query('SELECT pg_current_wal_lsn()::text AS lsn'))
        .rows[0].lsn;
      await waitReplicated(standbyRead,lsn);
      await primary.end();primaryClosed=true;
      await standbyRead.end();standbyClosed=true;
      await run('docker',['kill','-s','KILL','pg-r59-primary']);
      const promotion=await run('docker',[
        'exec','pg-r59-standby','psql','-U','postgres','-d','ox_r59',
        '-tAc','SELECT pg_promote(wait => true, wait_seconds => 30)'
      ],{timeout:35000});
      assert.equal(promotion.stdout.trim(),'t');
      promoted=new pg.Pool(config(5544));
      assert.equal((await promoted.query('SELECT pg_is_in_recovery() AS standby'))
        .rows[0].standby,false);
      const second=createR57PgCoordinator({
        pool:promoted,privilegedRemote:remote,tenantId,syntheticOnly:true
      });
      const before=await second.inspect(tenantId);
      assert.equal(before.pending,true);
      await assert.rejects(second.acquire({
        tenant:tenantId,holder:'b'.repeat(24),ttlMs:10000
      }),/unresolved S3 intent/);
      const reconciled=await second.recover(tenantId);
      assert.equal(reconciled.reconciled,true);
      assert.equal(reconciled.committed.sha256,SHA(checkpoint));
      await assert.rejects(second.assertCurrent(lease),/stale/);
      const newer=await second.acquire({
        tenant:tenantId,holder:'b'.repeat(24),ttlMs:10000
      });
      assert.equal(newer.epoch,lease.epoch+1);
      await second.release(newer);
      assert.equal((await second.inspect(tenantId)).pending,false);
    }finally{
      await promoted?.end().catch(()=>{});
      if(!primaryClosed)await primary.end().catch(()=>{});
      if(!standbyClosed)await standbyRead.end().catch(()=>{});
    }
  });
