import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createR48WitnessClient,createR48WitnessReceiver} from '../src/migration/r48-witness.mjs';
const tenant='a'.repeat(24),manifest='c'.repeat(64),first='d'.repeat(64),second='e'.repeat(64);
async function setup(){
  const root=await mkdtemp(join(tmpdir(),'ox-r48-witness-'));
  const secret=randomBytes(32),token=randomBytes(32).toString('hex');
  const server=createServer(createR48WitnessReceiver({root,token,secret}));
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const endpoint='http://127.0.0.1:'+server.address().port+'/';
  const client=createR48WitnessClient({endpoint,token,secret,tenant,allowSyntheticLoopback:true});
  return {root,client,secret,token,endpoint,
    close:async()=>{await new Promise(ok=>server.close(ok));await rm(root,{recursive:true,force:true});}};
}
test('R4.8 independent witness accepts monotonic signed catalogs and deduplicates identical publication',async()=>{
  const f=await setup();
  try{
    assert.equal(await f.client.current(),null);
    const start=await f.client.commit({catalogSha256:first,manifestSha256:manifest,entries:1});
    assert.equal(start.entries,1);
    const repeated=await f.client.commit({catalogSha256:first,manifestSha256:manifest,entries:1});
    assert.deepEqual(repeated,start);
    await f.client.commit({catalogSha256:second,manifestSha256:manifest,entries:3});
    assert.equal((await f.client.current()).previousHash,first);
    assert.equal((await f.client.verify({catalogSha256:second,manifestSha256:manifest,entries:3})).anchorVerified,true);
    await assert.rejects(f.client.verify({catalogSha256:first,manifestSha256:manifest,entries:1}),
      /older than or different from independent witness/);
    await assert.rejects(f.client.commit({catalogSha256:first,manifestSha256:manifest,entries:1}),
      /remote catalog must advance witness sequence/);
    await assert.rejects(f.client.commit({catalogSha256:'f'.repeat(64),
      manifestSha256:manifest,entries:3}),/remote catalog must advance witness sequence/);
  }finally{await f.close();}
});
test('R4.8 witness detects tampered independent checkpoint on disk',async()=>{
  const f=await setup();
  try{
    await f.client.commit({catalogSha256:first,manifestSha256:manifest,entries:1});
    const path=join(f.root,tenant+'.json'),original=await readFile(path,'utf8');
    await writeFile(path,original.replace(first,second));
    await assert.rejects(f.client.current(),/read witness status 409/);
  }finally{await f.close();}
});
test('R4.8 witness refuses wrong bearer, wrong HMAC key and non-loopback cleartext',async()=>{
  const f=await setup();
  try{
    await f.client.commit({catalogSha256:first,manifestSha256:manifest,entries:1});
    const badBearer=createR48WitnessClient({endpoint:f.endpoint,
      token:randomBytes(32).toString('hex'),secret:f.secret,tenant,allowSyntheticLoopback:true});
    await assert.rejects(badBearer.current(),/read witness status 404/);
    const badKey=createR48WitnessClient({endpoint:f.endpoint,token:f.token,
      secret:randomBytes(32),tenant,allowSyntheticLoopback:true});
    await assert.rejects(badKey.current(),/invalid witness signature/);
    assert.throws(()=>createR48WitnessClient({endpoint:'http://example.org/',
      token:f.token,secret:f.secret,tenant}),/fixed HTTPS witness required/);
  }finally{await f.close();}
});
