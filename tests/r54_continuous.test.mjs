import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {crmDb} from '../src/crm/db.mjs';
import {installR53Capture,readR53Committed} from '../src/migration/r53-commit-journal.mjs';
import {r53WitnessTenant} from '../src/migration/r53-incremental.mjs';
import {createR48WitnessClient,createR48WitnessReceiver} from '../src/migration/r48-witness.mjs';
import {runR54SyncWindow,runR54PollingWorker} from '../src/migration/r54-continuous-worker.mjs';
import {withR54ExclusivePublisher} from '../src/migration/r54-publisher-lease.mjs';
import {r47TenantToken} from '../src/migration/r47-offsite.mjs';
const projectId='11111111-1111-4111-8111-111111111111';
const stamp='2026-11-07T00:00:00.000Z';
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'ox-r54-drain-'));
  const db=crmDb(join(root,'isolated.sqlite'));
  installR53Capture(db,{syntheticOnly:true});
  const vault={projectId,manifestSha256:'a'.repeat(64),
    catalogKey:randomBytes(32)};
  const deltaKey=randomBytes(32),bucket=new Map();
  const settings={putFailures:0,wormFailure:false};
  const remote={
    async assertBucketControls(){return {versioningEnabled:true,objectLockEnabled:true};},
    async get(key){
      if(!bucket.has(key))throw Error('R4.8 S3 denied: GET status 404');
      return Buffer.from(bucket.get(key));
    },
    async put(key,value){
      if(settings.putFailures>0){
        settings.putFailures--;const e=Error('temporary transport failure');
        e.code='ECONNREFUSED';throw e;
      }
      bucket.set(key,Buffer.from(value));return true;
    },
    async inspectR49Worm(key){
      if(settings.wormFailure)throw Error('object has no COMPLIANCE retention');
      if(!bucket.has(key))throw Error('object missing');
      return {objectLockVerified:true,retentionMode:'COMPLIANCE',
        versionId:'local-synthetic-v1',versioned:true};
    }
  };
  const token=randomBytes(32).toString('hex'),secret=randomBytes(32);
  const server=createServer(createR48WitnessReceiver({
    root:join(root,'witness'),token,secret}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const witness=createR48WitnessClient({
    endpoint:'http://127.0.0.1:'+server.address().port+'/',
    token,secret,tenant:r53WitnessTenant(vault.catalogKey,projectId),
    allowSyntheticLoopback:true});
  const options={sourceDb:db,vault,remote,witness,deltaKey,
    baselineArchiveId:'e'.repeat(32),
    leaseDirectory:join(root,'lease'),syntheticOnly:true,maxBatches:1};
  return {root,db,bucket,settings,options,
    async close(){db.close();await new Promise(resolve=>server.close(resolve));
      await rm(root,{recursive:true,force:true});}};
}
function many(db,count){
  const insert=db.prepare('INSERT INTO tasks(id,title,created_at,updated_at) VALUES(?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  try{
    for(let i=0;i<count;i++)insert.run(randomUUID(),'Synthetic '+i,stamp,stamp);
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
test('R5.4 300 committed events drain across 250/50 witnessed WORM segments',async()=>{
  const f=await fixture();
  try{
    many(f.db,300);
    const page=readR53Committed(f.db,{limit:250,syntheticOnly:true});
    assert.equal(page.events.length,250);
    assert.equal(page.hasMore,true);
    assert.equal(page.latestCommittedSequence,300);
    assert.equal(page.unappliedCount,300);
    const first=await runR54SyncWindow(f.options);
    assert.equal(first.publishedEvents,250);
    assert.equal(first.outstandingCommittedEvents,50);
    assert.equal(first.caughtUp,false);
    assert.equal(first.alertRequired,true);
    assert.equal(first.witnessedSequence,250);
    assert.equal(first.realTransactionRpoSecondsMeasured,false);
    const second=await runR54SyncWindow({...f.options,
      maxBatches:2,verifyFullHistory:true});
    assert.equal(second.publishedEvents,50);
    assert.equal(second.witnessedSequence,300);
    assert.equal(second.outstandingCommittedEvents,0);
    assert.equal(second.caughtUp,true);
    assert.equal(second.alertRequired,false);
    assert.equal(second.fullHistoryAuthenticated,true);
    const retry=await runR54SyncWindow(f.options);
    assert.equal(retry.publishedEvents,0);
    assert.equal(retry.witnessedSequence,300);
    assert.equal(retry.productionCutoverAllowed,false);
  }finally{await f.close();}
});
test('R5.4 retries a bounded transient outage and resumes from external witness',async()=>{
  const f=await fixture();try{
    many(f.db,2);f.settings.putFailures=1;
    const r=await runR54SyncWindow({...f.options,maxRetries:2,retryBaseMs:1});
    assert.equal(r.retryCount,1);
    assert.equal(r.witnessedSequence,2);
    assert.equal(r.caughtUp,true);
    assert.equal(r.sourcePrimaryMutatedByPublisher,false);
  }finally{await f.close();}
});
test('R5.4 irrecoverable WORM failure cannot be marked as zero lag',async()=>{
  const f=await fixture();try{
    many(f.db,3);f.settings.wormFailure=true;
    await assert.rejects(runR54SyncWindow(f.options),/no COMPLIANCE retention/);
    f.settings.wormFailure=false;
    // The failed upload has not been published as a remotely witnessed head.
    const recovered=await runR54SyncWindow(f.options);
    assert.equal(recovered.witnessedSequence,3);
    assert.equal(recovered.caughtUp,true);
  }finally{await f.close();}
});
test('R5.4 tampering or dropping journal rows is refused before S3 publication',async()=>{
  const f=await fixture();try{
    many(f.db,3);
    f.db.exec('DELETE FROM ox_r53_events WHERE seq=2');
    await assert.rejects(runR54SyncWindow(f.options),
      /journal sequence gap, corruption/);
    assert.equal(f.bucket.size,0);
  }finally{await f.close();}
});
test('R5.4 cooperative worker stops on signal and accepts only signed cycle envelopes',async()=>{
  const controller=new AbortController();let calls=0;
  const envelope={format:'osmanx-r54-delivery-window-v1',
    witnessedSequence:8,outstandingCommittedEvents:0,productionCutoverAllowed:false};
  const result=await runR54PollingWorker({
    signal:controller.signal,maxCycles:100,intervalMs:25,
    cycle:async()=>{calls++;return envelope;},
    onCycle:async()=>{if(calls===2)controller.abort();}
  });
  assert.equal(result.completedCycles,2);
  assert.equal(result.stoppedOnSignal,true);
  assert.equal(result.lastWitnessedSequence,8);
  await assert.rejects(runR54PollingWorker({signal:new AbortController().signal,
    cycle:async()=>({...envelope,productionCutoverAllowed:true}),maxCycles:1}),
    /unverified CDC cycle/);
});
test('R5.4 local tenant publisher lease rejects simultaneous worker',async()=>{
  const f=await fixture();try{
    const token=r47TenantToken(f.options.vault.catalogKey,projectId);
    let release,entered;
    const held=new Promise(resolve=>{release=resolve;});
    const signal=new Promise(resolve=>{entered=resolve;});
    const task=withR54ExclusivePublisher({
      directory:f.options.leaseDirectory,tenantToken:token,syntheticOnly:true
    },async()=>{entered();await held;return 'ok';});
    await signal;
    await assert.rejects(withR54ExclusivePublisher({
      directory:f.options.leaseDirectory,tenantToken:token,syntheticOnly:true
    },async()=>'unexpected'),/another publisher owns tenant lease/);
    release();
    assert.equal(await task,'ok');
    assert.equal(await withR54ExclusivePublisher({
      directory:f.options.leaseDirectory,tenantToken:token,syntheticOnly:true
    },async()=>'recovered'),'recovered');
  }finally{await f.close();}
});
