import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createR56PointerCoordinator} from '../src/migration/r56-coordinator.mjs';

const TENANT='d'.repeat(24),A='a'.repeat(24),B='b'.repeat(24);
const etag=b=>'"'+createHash('sha256').update(b).digest('hex')+'"';
async function fixture({fault=()=>{},delayPut=()=>{}}={}){
  const root=await mkdtemp(join(tmpdir(),'ox-r56-'));
  let current=Date.now(),version=0,head=null,puts=0;
  const remote={
    async assertBucketControls(){return {objectLockEnabled:true,versioningEnabled:true};},
    async put(key,body,{ifMatch=null,ifNoneMatch=false}={}){
      assert.equal(key,'r53/head.json');puts++;
      await delayPut();
      if(ifNoneMatch&&head!==null)throw Error('CAS 412');
      if(ifMatch&&(head===null||etag(head)!==ifMatch))throw Error('CAS 412');
      head=Buffer.from(body);version++;
      return true;
    },
    async getWithMetadata(){
      if(head===null)throw Error('R4.8 S3 denied: GET status 404');
      return {body:Buffer.from(head),etag:etag(head),versionId:'synthetic-'+version};
    },
    async inspectR49Worm(){
      return {objectLockVerified:true,retentionMode:'COMPLIANCE',versionId:'synthetic-'+version};
    }
  };
  const make=()=>createR56PointerCoordinator({root:join(root,'state'),remote,now:()=>current,fault});
  return {remote,make,clock(ms){current+=ms;},get puts(){return puts;},
    get head(){return head;},close:()=>rm(root,{recursive:true,force:true})};
}
const acquire=(c,holder=A)=>c.acquire({tenant:TENANT,holder,ttlMs:1000});
test('R5.6 coordinator owns only conditional head PUT and confirms exact version',async()=>{
  const f=await fixture();try{
    const c=f.make(),lease=await acquire(c),body=Buffer.from('signed-checkpoint-A');
    const receipt=await c.publish({lease,body,ifNoneMatch:true,operation:'1'.repeat(32)});
    assert.equal(receipt.confirmed,true);
    assert.equal(receipt.sha256,createHash('sha256').update(body).digest('hex'));
    assert.equal(f.puts,1);
    const second=await c.publish({lease,body,ifNoneMatch:true,operation:'1'.repeat(32)});
    assert.equal(second.replayed,true);assert.equal(f.puts,1);
    await c.release(lease);
  }finally{await f.close();}
});
test('R5.6 slow S3 PUT prevents another lease even after TTL expires',async()=>{
  let started,unblock;
  const began=new Promise(ok=>{started=ok;});
  const gate=new Promise(ok=>{unblock=ok;});
  const f=await fixture({delayPut:async()=>{started();await gate;}});
  try{
    const c=f.make(),lease=await acquire(c);
    const writing=c.publish({lease,body:Buffer.from('signed-checkpoint-A'),ifNoneMatch:true});
    await began;f.clock(2000);
    let acquired=false;
    const contender=acquire(c,B).then(x=>{acquired=true;return x;});
    await Promise.resolve();
    assert.equal(acquired,false,'contender must wait for S3 write');
    unblock();await writing;
    const next=await contender;
    assert.equal(next.epoch,2);assert.equal(f.puts,1);
    await assert.rejects(c.assertCurrent(lease),/stale/);
    await c.release(next);
  }finally{unblock?.();await f.close();}
});
test('R5.6 lost response after committed write is recovered after coordinator restart',async()=>{
  let fail=true;
  const f=await fixture({fault:stage=>{
    if(stage==='after-put'&&fail){fail=false;throw Error('simulated crash after S3 accepted PUT');}
  }});
  try{
    const c=f.make(),lease=await acquire(c),body=Buffer.from('signed-checkpoint-B');
    await assert.rejects(c.publish({lease,body,ifNoneMatch:true,operation:'2'.repeat(32)}),/simulated crash/);
    assert.equal(f.puts,1);
    const restarted=f.make();
    const restored=await restarted.recover(TENANT);
    assert.equal(restored.committed.sha256,etag(body).slice(1,-1));
    f.clock(2000);
    const fresh=await acquire(restarted,B);
    assert.equal(fresh.epoch,2);
    await restarted.release(fresh);
  }finally{await f.close();}
});
test('R5.6 unknown write with no matching HEAD fails closed',async()=>{
  const f=await fixture({fault:stage=>{
    if(stage==='after-intent')throw Error('crash before PUT');
  }});
  try{
    const c=f.make(),lease=await acquire(c);
    await assert.rejects(c.publish({lease,body:Buffer.from('intended'),ifNoneMatch:true}),/crash before PUT/);
    await assert.rejects(f.make().recover(TENANT),/ambiguous checkpoint/);
    f.clock(2000);
    await assert.rejects(acquire(f.make(),B),/ambiguous checkpoint/);
    assert.equal(f.puts,0);
  }finally{await f.close();}
});
test('R5.6 CAS conflict blocks receipt and subsequent work until investigation',async()=>{
  const f=await fixture();try{
    const c=f.make(),lease=await acquire(c);
    await c.publish({lease,body:Buffer.from('first'),ifNoneMatch:true});
    await assert.rejects(c.publish({lease,body:Buffer.from('second'),ifNoneMatch:true}),/CAS 412/);
    await assert.rejects(c.recover(TENANT),/ambiguous checkpoint/);
  }finally{await f.close();}
});
test('R5.6 refuses stale holder and invalid unconditional writes',async()=>{
  const f=await fixture();try{
    const c=f.make(),lease=await acquire(c);
    await assert.rejects(c.publish({lease,body:Buffer.from('unconditional')}),/strict conditional/);
    f.clock(2000);
    await assert.rejects(c.publish({lease,body:Buffer.from('expired'),ifNoneMatch:true}),/stale/);
    const fresh=await acquire(c,B);
    await assert.rejects(c.publish({lease,body:Buffer.from('late'),ifNoneMatch:true}),/stale/);
    await c.release(fresh);
  }finally{await f.close();}
});
