import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {scanR64LocalWalArchive}
  from '../src/migration/r64-wal-archive-evidence.mjs';
import {createR65DualWormCustody}
  from '../src/migration/r65-dual-worm-custody.mjs';
const enabled=process.env.OX_R65_DUAL_MINIO_E2E==='YES'&&
  process.env.OX_R65_LAB_ACK==='YES'&&
  process.env.OX_R40_EPHEMERAL==='YES';
function stores(){
  return [
    {storeId:'first-process',
      endpoint:process.env.OX_R65_MINIO_A_ENDPOINT,
      bucket:process.env.OX_R65_MINIO_A_BUCKET,
      region:'us-east-1',
      accessKey:process.env.OX_R65_MINIO_A_KEY,
      secretKey:process.env.OX_R65_MINIO_A_SECRET},
    {storeId:'second-process',
      endpoint:process.env.OX_R65_MINIO_B_ENDPOINT,
      bucket:process.env.OX_R65_MINIO_B_BUCKET,
      region:'us-east-1',
      accessKey:process.env.OX_R65_MINIO_B_KEY,
      secretKey:process.env.OX_R65_MINIO_B_SECRET}
  ];
}
test('R6.5 refuse same S3 endpoint, missing distinct keys and unknown tenant',
  ()=>{
    const origin={storeId:'first-process',endpoint:'http://127.0.0.1:9000/',
      bucket:'lab-r65-primary',region:'us-east-1',accessKey:'R65LABACCA1',
      secretKey:'R65_LAB_SECRET_FIRST_PROCESS_NO_REAL_DATA_2026'};
    assert.throws(()=>createR65DualWormCustody({
      tenantId:'a'.repeat(24),allowSyntheticLoopback:true,
      stores:[origin,{...origin,storeId:'second-process',
        accessKey:'R65LABACCB2'}]
    }),/separate S3 server endpoints/);
    assert.throws(()=>createR65DualWormCustody({
      tenantId:'a'.repeat(24),allowSyntheticLoopback:true,
      stores:[origin,{...origin,storeId:'second-process',
        endpoint:'http://127.0.0.1:9001/'}]
    }),/distinct store ID and SigV4 key/);
    assert.throws(()=>createR65DualWormCustody({
      tenantId:'../wrong',stores:[origin,origin]
    }),/exact tenant and two isolated S3 stores/);
  });
test('R6.5 real TWO MinIO processes preserve COMPLIANCE-locked WAL after source folder disappears',
  {skip:!enabled,timeout:90000},async()=>{
    const tenantId=randomBytes(12).toString('hex');
    const origin=await mkdtemp(join(tmpdir(),'ox-r65-source-'));
    const restore=join(tmpdir(),'ox-r65-recovered-'+randomBytes(8).toString('hex'));
    const a='000000010000000000000000',b='000000010000000000000001';
    try{
      await writeFile(join(origin,a),Buffer.alloc(16*1024*1024,0x45));
      await writeFile(join(origin,b),Buffer.alloc(16*1024*1024,0x46));
      const inventory=await scanR64LocalWalArchive({
        directory:origin
      });
      const dual=createR65DualWormCustody({
        tenantId,stores:stores(),allowSyntheticLoopback:true
      });
      const check=await dual.assertBoth();
      assert.equal(check.independentProcessEndpoints,2);
      const receipts=await dual.uploadArchive({
        directory:origin,inventory
      });
      assert.equal(receipts.length,4);
      assert(receipts.every(x=>x.retentionMode==='COMPLIANCE'));
      assert.equal(new Set(receipts.map(x=>x.storeId)).size,2);
      assert(receipts.every(x=>Date.parse(x.retainedUntil)>Date.now()+3600000));
      const bad=receipts.map(x=>({...x}));
      bad[0].versionId='forged-version-id';
      await assert.rejects(dual.downloadVerified({
        inventory,receipts:bad
      }),/tampered, newer|unretained/);
      await assert.rejects(dual.downloadVerified({
        inventory,receipts:receipts.slice(1)
      }),/both custody receipts/);
      await rm(origin,{recursive:true,force:true});
      const result=await dual.restoreToFreshDirectory({
        directory:restore,inventory,receipts
      });
      assert.equal(result.restoredSegments,2);
      assert.equal(result.bothWormCopiesReread,true);
      assert.equal(result.localSourceArchiveNotRequired,true);
      assert.equal(result.productionCutoverAllowed,false);
      const left=await readFile(join(restore,a));
      const right=await readFile(join(restore,b));
      assert.equal(left.length,16*1024*1024);
      assert.equal(right.length,16*1024*1024);
      assert.equal(left[10],0x45);
      assert.equal(right[10],0x46);
    }finally{
      await Promise.all([rm(origin,{recursive:true,force:true}),
        rm(restore,{recursive:true,force:true})]);
    }
  });
