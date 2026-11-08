// Real OpenSSL-generated TLS chain; no fake TLS sockets in these tests.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {randomBytes,createHash,X509Certificate} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createR58MtlsClient,createR58MtlsHandler,signR58Request}
  from '../src/migration/r58-mtls-coordinator.mjs';

const TENANT='e'.repeat(24),HOLDER='a'.repeat(24),key=randomBytes(32);
const hash=b=>createHash('sha256').update(b).digest('hex');
let fx;
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'ox-r58-tls-'));
  function ssl(...args){execFileSync('openssl',args,{cwd:dir,stdio:'pipe'});}
  ssl('req','-x509','-newkey','rsa:2048','-sha256','-nodes','-days','2',
    '-keyout','ca.key','-out','ca.pem','-subj','/CN=R58 Test CA');
  await writeFile(join(dir,'server.ext'),
    'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n');
  await writeFile(join(dir,'client.ext'),'extendedKeyUsage=clientAuth\n');
  for(const [name,cn,ext] of [
    ['server','localhost','server.ext'],['client','R58 Test Publisher','client.ext'],
    ['other','R58 Other Publisher','client.ext']]){
    ssl('req','-newkey','rsa:2048','-nodes','-keyout',name+'.key',
      '-out',name+'.csr','-subj','/CN='+cn);
    ssl('x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key',
      '-CAcreateserial','-days','2','-sha256','-extfile',ext,'-out',name+'.pem');
  }
  const [ca,serverCert,serverKey,clientCert,clientKey,otherCert,otherKey]=
    await Promise.all(['ca.pem','server.pem','server.key','client.pem','client.key',
      'other.pem','other.key'].map(name=>readFile(join(dir,name))));
  const serverPin=hash(new X509Certificate(serverCert).raw);
  const clientPin=hash(new X509Certificate(clientCert).raw);
  const seen=new Set();
  const nonceStore={tenantId:TENANT,
    async consume(nonce){
      if(seen.has(nonce))throw Error('duplicate nonce');
      seen.add(nonce);return true;
    }};
  let count=0,epoch=0,active=null;
  const coordinator={
    syntheticOnly:true,
    async acquire({tenant,holder,ttlMs}){
      assert.equal(tenant,TENANT);
      epoch++;
      active={tenant,holder,epoch,leaseId:randomBytes(16).toString('hex'),
        expiresAt:Date.now()+ttlMs,syntheticOnly:true};
      return active;
    },
    async renew(lease){assert.equal(lease.epoch,active?.epoch);return active;},
    async assertCurrent(lease){
      if(lease.epoch!==active?.epoch)throw Error('stale');
      return {remoteFencingVerified:true,epoch};
    },
    async release(){active=null;return {released:true};},
    async publish({body,operation}){
      count++;
      return {confirmed:true,sha256:hash(body),operation};
    },
    async recover(){return {ambiguous:false,syntheticOnly:true};},
    async inspect(){return {epoch,pending:false,syntheticOnly:true};}
  };
  const server=https.createServer({cert:serverCert,key:serverKey,ca,
    requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'},
  createR58MtlsHandler({tenantId:TENANT,coordinator,nonceStore,
    sharedKey:key,clientFingerprintSha256:clientPin}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,endpoint='https://127.0.0.1:'+port+'/';
  const client=(params={})=>createR58MtlsClient({
    endpoint,tenantId:TENANT,sharedKey:key,ca,cert:clientCert,
    key:clientKey,serverFingerprintSha256:serverPin,...params
  });
  async function post(envelope,{cert=clientCert,privateKey=clientKey,
    path='/v1/r58/'+TENANT}={}){
    const payload=Buffer.from(JSON.stringify(envelope));
    return new Promise((resolve,reject)=>{
      const req=https.request({hostname:'127.0.0.1',port,ca,cert,key:privateKey,
        path,method:'POST',rejectUnauthorized:true,
        headers:{'content-type':'application/json','content-length':String(payload.length)}},
      res=>{
        const chunks=[];
        res.on('data',b=>chunks.push(b));
        res.on('end',()=>resolve({status:res.statusCode,
          body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));
      });
      req.on('error',reject);req.end(payload);
    });
  }
  return {dir,client,post,server,otherCert,otherKey,clientCert,clientKey,
    ca,serverPin,clientPin,endpoint,get publishCount(){return count;},
    async close(){
      await new Promise(ok=>server.close(ok));
      await rm(dir,{force:true,recursive:true});
    }};
}
before(async()=>{fx=await fixture();});
after(async()=>{await fx?.close();});
test('R5.8 real mTLS + pinned server + signed HMAC exchanges checkpoint operations',
  async()=>{
    const c=fx.client();
    const lease=await c.acquire(HOLDER,{ttlMs:3000});
    assert.equal(lease.holder,HOLDER);
    assert.equal((await c.assertCurrent(lease)).remoteFencingVerified,true);
    const body=Buffer.from('signed-only-checkpoint');
    const published=await c.publish({
      lease,body,ifNoneMatch:true,operation:'b'.repeat(32)});
    assert.equal(published.sha256,hash(body));
    assert.equal((await c.inspect(TENANT)).pending,false);
    assert.equal((await c.recover(TENANT)).ambiguous,false);
    assert.equal((await c.release(lease)).released,true);
    assert.equal(fx.publishCount,1);
});
test('R5.8 TLS rejects a CA-trusted but non-pinned client certificate',async()=>{
  const other=fx.client({cert:fx.otherCert,key:fx.otherKey});
  await assert.rejects(other.acquire(HOLDER),/unexpected HTTP status|socket hang up/);
});
test('R5.8 TLS rejects a mismatched pinned server certificate',async()=>{
  const c=fx.client({serverFingerprintSha256:'1'.repeat(64)});
  await assert.rejects(c.acquire(HOLDER),/pin mismatch|certificate|socket/);
});
test('R5.8 signed request rejects bad shared secret after successful TLS',async()=>{
  const bad=fx.client({sharedKey:randomBytes(32)});
  await assert.rejects(bad.acquire(HOLDER),/unexpected HTTP status/);
});
test('R5.8 consumed nonce cannot be replayed even through a fresh TLS connection',
  async()=>{
    const envelope=signR58Request(key,{
      tenant:TENANT,nonce:'f'.repeat(32),issuedAt:Date.now(),
      op:'inspect',payload:{}
    });
    const first=await fx.post(envelope);
    const second=await fx.post(envelope);
    assert.equal(first.status,200);
    assert.equal(second.status,409);
    assert.equal(second.body.errorCode,'operation_refused');
});
test('R5.8 rejects stale signed requests and unknown RPC operation',async()=>{
  const expired=signR58Request(key,{
    tenant:TENANT,nonce:'c'.repeat(32),issuedAt:Date.now()-100000,
    op:'inspect',payload:{}
  });
  assert.equal((await fx.post(expired)).status,401);
  const other={...signR58Request(key,{
    tenant:TENANT,nonce:'d'.repeat(32),issuedAt:Date.now(),
    op:'inspect',payload:{}
  }),op:'executeSql'};
  assert.equal((await fx.post(other)).status,401);
});
test('R5.8 never accepts cross-tenant or arbitrary HTTP path',async()=>{
  const request=signR58Request(key,{
    tenant:TENANT,nonce:'a'.repeat(32),issuedAt:Date.now(),
    op:'inspect',payload:{}
  });
  assert.equal((await fx.post(request,{path:'/v1/r58/'+'b'.repeat(24)})).status,404);
  assert.equal((await fx.post(request,{path:'/admin/delete'})).status,404);
});
test('R5.8 forbids arbitrary SQL and oversize pointer payload',async()=>{
  const c=fx.client(),lease=await c.acquire(HOLDER);
  assert.throws(()=>c.publish({lease,body:Buffer.alloc(5000),
    ifNoneMatch:true}),/signed pointer buffer required/);
  const invalid=signR58Request(key,{
    tenant:TENANT,nonce:'1'.repeat(32),issuedAt:Date.now(),
    op:'publish',payload:{lease,bodyBase64:Buffer.alloc(4500).toString('base64'),
      operation:'2'.repeat(32),ifNoneMatch:true}
  });
  assert.equal((await fx.post(invalid)).status,409);
  await c.release(lease);
});
