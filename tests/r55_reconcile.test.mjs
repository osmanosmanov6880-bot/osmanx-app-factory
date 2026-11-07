import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {crmDb} from '../src/crm/db.mjs';
import {installR53Capture} from '../src/migration/r53-commit-journal.mjs';
import {createR48WitnessReceiver,createR48WitnessClient}
  from '../src/migration/r48-witness.mjs';
import {r53WitnessTenant,inspectR53WitnessedCheckpoint}
  from '../src/migration/r53-incremental.mjs';
import {createR55FenceReceiver,createR55FenceClient}
  from '../src/migration/r55-fence.mjs';
import {runR55FencedPublisher} from '../src/migration/r55-reconcile.mjs';
import {commitR55SyntheticTransaction,measureR55SyntheticWitnessDelay,
  summarizeR55SyntheticDelays} from '../src/migration/r55-commit-latency.mjs';

const projectId='11111111-1111-4111-8111-111111111111';
const stamp=new Date().toISOString();
const HASH=bytes=>'"'+createHash('sha256').update(bytes).digest('hex')+'"';
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'ox-r55-reconcile-'));
  const db=crmDb(join(root,'synthetic.sqlite'));
  installR53Capture(db,{syntheticOnly:true});
  const vault={projectId,manifestSha256:'a'.repeat(64),catalogKey:randomBytes(32)};
  const deltaKey=randomBytes(32),objects=new Map(),seenVersions=new Map();
  const remote={
    async assertBucketControls(){return {objectLockEnabled:true,versioningEnabled:true};},
    async put(key,bytes,{ifMatch=null,ifNoneMatch=false}={}){
      if(ifNoneMatch&&objects.has(key))
        throw Error('R4.8 S3 denied: conditional CDC pointer compare-and-swap conflict');
      if(ifMatch&&(!objects.has(key)||HASH(objects.get(key))!==ifMatch))
        throw Error('R4.8 S3 denied: conditional CDC pointer compare-and-swap conflict');
      objects.set(key,Buffer.from(bytes));
      seenVersions.set(key,(seenVersions.get(key)||0)+1);
      return true;
    },
    async get(key){
      if(!objects.has(key))throw Error('R4.8 S3 denied: GET status 404');
      return Buffer.from(objects.get(key));
    },
    async getWithMetadata(key){
      const body=await remote.get(key);
      return {body,etag:HASH(body),
        versionId:'synthetic-'+seenVersions.get(key)};
    },
    async inspectR49Worm(key){
      if(!objects.has(key))throw Error('missing WORM object');
      return {objectLockVerified:true,retentionMode:'COMPLIANCE',
        versionId:'synthetic-'+seenVersions.get(key),versioned:true};
    }
  };
  const fenceToken=randomBytes(32).toString('hex'),fenceKey=randomBytes(32);
  const witnessToken=randomBytes(32).toString('hex'),witnessKey=randomBytes(32);
  const start=(handler)=>new Promise(resolve=>{
    const server=createServer(handler);
    server.listen(0,'127.0.0.1',()=>resolve(server));
  });
  const witnessServer=await start(createR48WitnessReceiver({
    root:join(root,'witness'),token:witnessToken,secret:witnessKey
  }));
  const fenceServer=await start(createR55FenceReceiver({
    root:join(root,'fence'),token:fenceToken,secret:fenceKey
  }));
  const witness=createR48WitnessClient({
    endpoint:'http://127.0.0.1:'+witnessServer.address().port+'/',
    token:witnessToken,secret:witnessKey,
    tenant:r53WitnessTenant(vault.catalogKey,projectId),
    allowSyntheticLoopback:true
  });
  const authority=createR55FenceClient({
    endpoint:'http://127.0.0.1:'+fenceServer.address().port+'/',
    token:fenceToken,secret:fenceKey,
    tenant:'d'.repeat(24),allowSyntheticLoopback:true
  });
  const args={sourceDb:db,vault,remote,witness,deltaKey,
    baselineArchiveId:'e'.repeat(32),authority,syntheticOnly:true};
  return {root,db,vault,remote,witness,authority,args,objects,
    async close(){
      db.close();
      await new Promise(ok=>witnessServer.close(ok));
      await new Promise(ok=>fenceServer.close(ok));
      await rm(root,{recursive:true,force:true});
    }};
}
function write(f,title='Synthetic committed record'){
  return commitR55SyntheticTransaction({
    sourceDb:f.db,syntheticOnly:true,
    transaction(db){
      db.prepare('INSERT INTO tasks(id,title,created_at,updated_at) VALUES(?,?,?,?)')
        .run(randomUUID(),title,stamp,stamp);
    }
  });
}
const args=(f,holder='b'.repeat(24))=>({...f.args,holder});
test('R5.5 fenced publisher measures SQLite COMMIT-return to witness without certifying zero RPO',async()=>{
  const f=await fixture();try{
    const marker=write(f);
    const pub=await runR55FencedPublisher(args(f));
    assert.equal(pub.publishedEvents,1);
    assert.equal(pub.checkpointSequence,1);
    assert.equal(pub.remoteFencingVerified,true);
    assert.equal(pub.conditionalS3HeadRequired,true);
    const measured=measureR55SyntheticWitnessDelay({
      marker,publication:pub,syntheticOnly:true});
    assert(measured.observedCommitResponseToVerifiedWitnessMs>=0);
    assert.equal(measured.realTransactionRpoSecondsMeasured,false);
    const stats=summarizeR55SyntheticDelays([measured]);
    assert.equal(stats.sampleCount,1);
    assert.equal(stats.zeroRpoCertified,false);
    const second=await runR55FencedPublisher(args(f,'c'.repeat(24)));
    assert.equal(second.publishedEvents,0);
    assert.equal(second.reconciliation.alreadyWitnessed,true);
    assert.equal(second.fencingEpoch,pub.fencingEpoch+1);
  }finally{await f.close();}
});
test('R5.5 S3 HEAD succeeded but witness commit did not occur: new fenced worker reconciles every committed row',async()=>{
  const f=await fixture();try{
    write(f,'Original');await runR55FencedPublisher(args(f));
    write(f,'New after checkpoint');
    const broken={...f.witness,commit:async()=>{throw Error('simulated independent witness outage');}};
    await assert.rejects(runR55FencedPublisher({
      ...args(f),witness:broken
    }),/simulated independent witness outage/);
    const current=await f.witness.current();
    assert.equal(current.entries,1);
    assert.equal(f.objects.has('r53/head.json'),true);
    const recovered=await runR55FencedPublisher(args(f,'c'.repeat(24)));
    assert.equal(recovered.reconciliation.recoveredOrphan,true);
    assert.equal(recovered.reconciliation.authenticatedS3AndLocalEventsCompared,true);
    assert.equal(recovered.checkpointSequence,2);
    assert.equal(recovered.publishedEvents,0);
    assert.equal((await f.witness.current()).entries,2);
    assert.equal(recovered.productionCutoverAllowed,false);
  }finally{await f.close();}
});
test('R5.5 witness committed but HTTP response lost: recovery is idempotent',async()=>{
  const f=await fixture();try{
    write(f);
    const broken={...f.witness,commit:async(options)=>{
      await f.witness.commit(options);
      throw Error('witness HTTP response disappeared after commit');
    }};
    await assert.rejects(runR55FencedPublisher({...args(f),witness:broken}),
      /witness HTTP response disappeared/);
    assert.equal((await f.witness.current()).entries,1);
    const recovered=await runR55FencedPublisher(args(f,'d'.repeat(24)));
    assert.equal(recovered.reconciliation.alreadyWitnessed,true);
    assert.equal(recovered.publishedEvents,0);
    assert.equal(recovered.checkpointSequence,1);
  }finally{await f.close();}
});
test('R5.5 orphan remote head with tampered encrypted segment is not acknowledged',async()=>{
  const f=await fixture();try{
    write(f);
    const broken={...f.witness,commit:async()=>{throw Error('ACK lost');}};
    await assert.rejects(runR55FencedPublisher({...args(f),witness:broken}),/ACK lost/);
    const segment=[...f.objects.keys()].find(k=>k.startsWith('r53/segments/'));
    f.objects.set(segment,Buffer.from('tampered ciphertext'));
    await assert.rejects(runR55FencedPublisher(args(f,'c'.repeat(24))),
      /digest mismatch/);
    assert.equal(await f.witness.current(),null);
  }finally{await f.close();}
});
test('R5.5 orphan head cannot bless business data different from local committed journal',async()=>{
  const f=await fixture();try{
    write(f);
    const broken={...f.witness,commit:async()=>{throw Error('ACK lost');}};
    await assert.rejects(runR55FencedPublisher({...args(f),witness:broken}),/ACK lost/);
    f.db.prepare('UPDATE ox_r53_events SET after_json=? WHERE seq=1')
      .run('{"id":"falsified"}');
    await assert.rejects(runR55FencedPublisher(args(f,'c'.repeat(24))),
      /locally committed CRM row|noncanonical captured row/);
    assert.equal(await f.witness.current(),null);
  }finally{await f.close();}
});
test('R5.5 concurrent pointer CAS denies a stale writer even with earlier valid ETag',async()=>{
  const f=await fixture();try{
    write(f);await runR55FencedPublisher(args(f));
    const old=await f.remote.getWithMetadata('r53/head.json');
    await f.remote.put('r53/head.json',Buffer.from('{"new_head":true}'),
      {ifMatch:old.etag});
    await assert.rejects(f.remote.put('r53/head.json',Buffer.from('stale'),
      {ifMatch:old.etag}),/compare-and-swap conflict/);
    await assert.rejects(runR55FencedPublisher(args(f,'c'.repeat(24))),
      /invalid signed head JSON/);
  }finally{await f.close();}
});
