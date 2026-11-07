import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createR55FenceClient,createR55FenceReceiver} from '../src/migration/r55-fence.mjs';

const A='a'.repeat(24),B='b'.repeat(24),TENANT='d'.repeat(24);
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'ox-r55-fence-'));
  const token=randomBytes(32).toString('hex'),secret=randomBytes(32);
  let time=Date.now(),server;
  const start=async()=>{
    server=createServer(createR55FenceReceiver({
      root:join(root,'fence'),token,secret,now:()=>time
    }));
    await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  };
  await start();
  const endpoint=()=> 'http://127.0.0.1:'+server.address().port+'/';
  const client=()=>createR55FenceClient({
    endpoint:endpoint(),token,secret,tenant:TENANT,
    allowSyntheticLoopback:true
  });
  return {root,secret,token,endpoint,client,
    advance(ms){time+=ms;},
    async restart(){await new Promise(ok=>server.close(ok));await start();},
    async close(){await new Promise(ok=>server.close(ok));await rm(root,{recursive:true,force:true});}};
}
test('R5.5 remote fencing denies a second host while first owns lease',async()=>{
  const f=await fixture();try{
    const a=f.client(),b=f.client();
    const lease=await a.acquire(A,{ttlMs:10000});
    assert.equal(lease.epoch,1);
    assert.equal((await a.assertCurrent(lease)).remoteFencingVerified,true);
    await assert.rejects(b.acquire(B,{ttlMs:10000}),/authority denied 409/);
    const renewed=await a.renew(lease,{ttlMs:10000});
    assert.equal(renewed.epoch,1);
    assert.equal((await a.release(renewed)).released,true);
    const next=await b.acquire(B,{ttlMs:10000});
    assert.equal(next.epoch,2);
    await assert.rejects(a.assertCurrent(lease),/authority denied 409/);
    await b.release(next);
  }finally{await f.close();}
});
test('R5.5 crashed worker lease expires and old epoch cannot renew after new holder acquires',async()=>{
  const f=await fixture();try{
    const a=f.client(),b=f.client();
    const old=await a.acquire(A,{ttlMs:1000});
    f.advance(2000);
    const next=await b.acquire(B,{ttlMs:10000});
    assert.equal(next.epoch,old.epoch+1);
    await assert.rejects(a.renew(old),/authority denied 409/);
    await assert.rejects(a.release(old),/authority denied 409/);
    await b.release(next);
  }finally{await f.close();}
});
test('R5.5 independent authority state survives receiver process restart',async()=>{
  const f=await fixture();try{
    const a=f.client();
    const first=await a.acquire(A,{ttlMs:10000});
    await f.restart();
    const c=f.client();
    assert.equal((await c.assertCurrent(first)).epoch,first.epoch);
    await assert.rejects(c.acquire(B,{ttlMs:10000}),/authority denied 409/);
    await c.release(first);
    const second=await c.acquire(B,{ttlMs:10000});
    assert.equal(second.epoch,2);await c.release(second);
  }finally{await f.close();}
});
test('R5.5 unauthorized bearer and wrong independent HMAC key are refused',async()=>{
  const f=await fixture();try{
    const unauthorized=createR55FenceClient({
      endpoint:f.endpoint(),token:randomBytes(32).toString('hex'),
      secret:f.secret,tenant:TENANT,allowSyntheticLoopback:true
    });
    await assert.rejects(unauthorized.acquire(A),/authority denied 401/);
    const badKey=createR55FenceClient({
      endpoint:f.endpoint(),token:f.token,secret:randomBytes(32),
      tenant:TENANT,allowSyntheticLoopback:true});
    await assert.rejects(badKey.acquire(A),/authority denied 409/);
    const genuine=f.client();
    const accepted=await genuine.acquire(A);
    await genuine.release(accepted);
  }finally{await f.close();}
});
test('R5.5 tampered HMAC state cannot reset epoch or grant stale publisher',async()=>{
  const f=await fixture();try{
    const c=f.client();
    await c.acquire(A);
    const path=join(f.root,'fence',TENANT+'.json');
    const content=await readFile(path,'utf8');
    await writeFile(path,content.replace('"epoch":1','"epoch":0'));
    await assert.rejects(c.acquire(B),/authority denied 409/);
  }finally{await f.close();}
});
