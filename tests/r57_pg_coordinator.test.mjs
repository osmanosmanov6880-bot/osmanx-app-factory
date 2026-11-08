import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createR57PgCoordinator} from '../src/migration/r57-pg-coordinator.mjs';
import {createR57ScopedS3Capabilities} from '../src/migration/r57-s3-scope.mjs';

const enabled=process.env.OX_R57_E2E==='YES';
const A='a'.repeat(24),B='b'.repeat(24);
const sha=b=>createHash('sha256').update(b).digest('hex');
const etag=b=>'"'+sha(b)+'"';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const config=()=>({
  host:process.env.PGHOST||'127.0.0.1',port:Number(process.env.PGPORT||5432),
  user:process.env.PGUSER||'postgres',password:process.env.PGPASSWORD||'',
  database:process.env.PGDATABASE||'ox_r57',max:5,
  connectionTimeoutMillis:5000,statement_timeout:10000
});
async function fixture(){
  const tenantId=randomBytes(12).toString('hex'),pool=new pg.Pool(config());
  const otherPool=new pg.Pool(config());
  await pool.query(await readFile(new URL('../ops/r57/schema.sql',import.meta.url),'utf8'));
  let body=null,version=0,putCalls=0,pausePut=null,corruptWorm=false,conflict=false;
  const raw={
    tenantPrefix:tenantId+'/',
    async assertBucketControls(){return {objectLockEnabled:true,versioningEnabled:true};},
    async put(key,bytes,{ifMatch=null,ifNoneMatch=false}={}){
      assert.match(key,/^r53\/(head\.json|segments\/[a-f0-9]{64}\.oxd)$/);
      putCalls++;
      if(pausePut)await pausePut();
      if(conflict){body=Buffer.from('concurrent external write');version++;conflict=false;}
      if(ifNoneMatch&&body!==null)throw Error('CAS conflict: 412');
      if(ifMatch&&(body===null||etag(body)!==ifMatch))throw Error('CAS conflict: 412');
      body=Buffer.from(bytes);version++;
      return true;
    },
    async get(key){
      if(body===null)throw Error('R4.8 S3 denied: GET status 404');
      return Buffer.from(body);
    },
    async getWithMetadata(){
      if(body===null)throw Error('R4.8 S3 denied: GET status 404');
      return {body:Buffer.from(body),etag:etag(body),versionId:'test-v'+version};
    },
    async inspectR49Worm(){
      return {objectLockVerified:!corruptWorm,retentionMode:'COMPLIANCE',
        versionId:'test-v'+version};
    }
  };
  const caps=createR57ScopedS3Capabilities({transport:raw,tenantId});
  const make=(fault=()=>{},secondary=false)=>createR57PgCoordinator({
    pool:secondary?otherPool:pool,privilegedRemote:caps.coordinator,tenantId,
    syntheticOnly:true,fault
  });
  return {tenantId,pool,otherPool,caps,make,
    get putCalls(){return putCalls;},
    pause(fn){pausePut=fn;},
    corrupt(){corruptWorm=true;},
    race(){conflict=true;},
    get currentBody(){return body;},
    async close(){
      await Promise.all([pool,otherPool].map(async p=>{
        await p.query('DELETE FROM ox_r57_checkpoint_control WHERE tenant=$1',[tenantId]);
      })).catch(()=>{});
      await Promise.all([pool.end(),otherPool.end()]);
    }};
}
const take=(c,id,holder=A,ttlMs=1000)=>c.acquire({tenant:id,holder,ttlMs});
test('R5.7 two independent PostgreSQL pools serialize epochs and reject stale sender',
  {skip:!enabled},async()=>{
    const f=await fixture();try{
      const a=f.make(),b=f.make(()=>{},true);
      const first=await take(a,f.tenantId);
      await assert.rejects(take(b,f.tenantId,B),/another publisher/);
      await a.release(first);
      const second=await take(b,f.tenantId,B);
      assert.equal(second.epoch,first.epoch+1);
      await assert.rejects(a.assertCurrent(first),/stale/);
      await b.release(second);
    }finally{await f.close();}
  });
test('R5.7 expired lease during blocked S3 PUT cannot grant next publisher',
  {skip:!enabled,timeout:30000},async()=>{
    const f=await fixture();
    let unblock,arrived;
    const gate=new Promise(resolve=>{unblock=resolve;});
    const started=new Promise(resolve=>{arrived=resolve;});
    f.pause(async()=>{arrived();await gate;});
    try{
      const first=f.make(),next=f.make(()=>{},true),lease=await take(first,f.tenantId);
      const saving=first.publish({lease,body:Buffer.from('signed-checkpoint-1'),
        ifNoneMatch:true});
      await started;await sleep(1150);
      await assert.rejects(take(next,f.tenantId,B),/unresolved S3 intent/);
      unblock();
      const receipt=await saving;
      assert.equal(receipt.confirmed,true);
      const newer=await take(next,f.tenantId,B);
      assert.equal(newer.epoch,2);
      await assert.rejects(first.assertCurrent(lease),/stale/);
      await next.release(newer);
    }finally{unblock?.();await f.close();}
  });
test('R5.7 crash AFTER S3 success is recovered by another process against WORM version',
  {skip:!enabled},async()=>{
    const f=await fixture();try{
      const first=f.make(stage=>{
        if(stage==='after-put')throw Error('synthetic process died after S3 PUT');
      }),other=f.make(()=>{},true),lease=await take(first,f.tenantId);
      const bytes=Buffer.from('signed-checkpoint-2');
      await assert.rejects(first.publish({lease,body:bytes,ifNoneMatch:true}),/process died/);
      assert.equal(f.putCalls,1);
      await assert.rejects(take(other,f.tenantId,B),/unresolved S3 intent/);
      const fixed=await other.recover(f.tenantId);
      assert.equal(fixed.reconciled,true);
      assert.equal(fixed.committed.sha256,sha(bytes));
      await first.release(lease);
      const second=await take(other,f.tenantId,B);
      assert.equal(second.epoch,2);await other.release(second);
    }finally{await f.close();}
  });
test('R5.7 crash BEFORE S3 write is quarantined, never assumed rolled back',
  {skip:!enabled},async()=>{
    const f=await fixture();try{
      const first=f.make(stage=>{
        if(stage==='after-intent')throw Error('synthetic crash before network write');
      }),second=f.make(()=>{},true),lease=await take(first,f.tenantId);
      await assert.rejects(first.publish({lease,body:Buffer.from('will-not-write'),
        ifNoneMatch:true}),/synthetic crash/);
      assert.equal(f.putCalls,0);
      await assert.rejects(second.recover(f.tenantId),/ambiguous S3 outcome/);
      await assert.rejects(take(second,f.tenantId,B),/unresolved S3 intent/);
      assert.equal((await second.inspect(f.tenantId)).pending,true);
    }finally{await f.close();}
  });
test('R5.7 remote CAS conflict after durable intent denies next lease',
  {skip:!enabled},async()=>{
    const f=await fixture();try{
      const first=f.make(),second=f.make(()=>{},true),lease=await take(first,f.tenantId);
      f.race();
      await assert.rejects(first.publish({lease,body:Buffer.from('signed-checkpoint'),
        ifNoneMatch:true}),/CAS conflict/);
      await assert.rejects(second.recover(f.tenantId),/ambiguous S3 outcome/);
      await assert.rejects(take(second,f.tenantId,B),/unresolved S3 intent/);
    }finally{await f.close();}
  });
test('R5.7 idempotent receipt and delayed response after confirmation never repeat S3 PUT',
  {skip:!enabled},async()=>{
    const f=await fixture();try{
      const first=f.make(stage=>{
        if(stage==='after-confirmation')throw Error('lost response after durable receipt');
      }),lease=await take(first,f.tenantId),body=Buffer.from('signed-checkpoint-3'),
        operation='9'.repeat(32);
      await assert.rejects(first.publish({lease,body,ifNoneMatch:true,operation}),/lost response/);
      const second=f.make(()=>{},true);
      const receipt=await second.publish({lease,body,ifNoneMatch:true,operation});
      assert.equal(receipt.replayed,true);
      assert.equal(f.putCalls,1);
      await second.release(lease);
    }finally{await f.close();}
  });
test('R5.7 absent WORM retention blocks completion and recovery',
  {skip:!enabled},async()=>{
    const f=await fixture();try{
      const first=f.make(),second=f.make(()=>{},true),lease=await take(first,f.tenantId);
      f.corrupt();
      await assert.rejects(first.publish({lease,body:Buffer.from('missing-worm'),
        ifNoneMatch:true}),/COMPLIANCE object lock/);
      await assert.rejects(second.recover(f.tenantId),/COMPLIANCE object lock/);
      await assert.rejects(take(second,f.tenantId,B),/unresolved S3 intent/);
    }finally{await f.close();}
  });
