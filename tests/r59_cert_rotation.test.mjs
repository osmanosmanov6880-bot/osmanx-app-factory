import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {execFileSync} from 'node:child_process';
import {randomBytes,createHash,generateKeyPairSync,X509Certificate}
  from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {signR59PinManifest,createR59TrustWindow,
  verifyR59PinManifest,activateR59PgTrustGeneration}
  from '../src/migration/r59-cert-rotation.mjs';
import {createR58MtlsHandler,createR58MtlsClient}
  from '../src/migration/r58-mtls-coordinator.mjs';

const TENANT='f'.repeat(24);
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const certSha=b=>createHash('sha256').update(new X509Certificate(b).raw).digest('hex');
const WINDOW=3600000;
let clock=Date.now();
function signed({generation=1,clients,servers,issuedAt=clock-1000,
  expiresAt=clock+WINDOW}={}){
  return signR59PinManifest({privateKey,payload:{tenantId:TENANT,
    generation,issuedAt,expiresAt,clients,servers}});
}
const P=(sha256,notBefore=clock-1000,notAfter=clock+WINDOW)=>({
  sha256,notBefore,notAfter
});
test('R5.9 trusted Ed25519 signed two-pin overlap expires old client and keeps new one',
  ()=>{
    const old='a'.repeat(64),next='b'.repeat(64),server='c'.repeat(64);
    const manifest=signed({generation:2,clients:[
      P(old,clock-1000,clock+1000),
      P(next,clock-1000,clock+WINDOW)
    ],servers:[P(server)]});
    const trust=createR59TrustWindow({
      tenantId:TENANT,publicKey,manifest,minGeneration:2,now:()=>clock
    });
    assert.deepEqual(trust.trustedClientPins(clock),[old,next]);
    assert.deepEqual(trust.trustedClientPins(clock+2000),[next]);
    assert.deepEqual(trust.trustedServerPins(clock),[server]);
    assert.throws(()=>trust.trustedClientPins(clock+WINDOW+100),/expired/);
  });
test('R5.9 signed certificate manifest blocks forged, rolled-back, cross-tenant pins',
  ()=>{
    const original=signed({generation:3,clients:[P('a'.repeat(64))],
      servers:[P('b'.repeat(64))]});
    assert.throws(()=>verifyR59PinManifest({
      manifest:{...original,generation:4},publicKey,tenantId:TENANT
    }),/invalid offline signature/);
    assert.throws(()=>verifyR59PinManifest({
      manifest:original,publicKey,tenantId:'d'.repeat(24)
    }),/wrong manifest/);
    assert.throws(()=>createR59TrustWindow({
      manifest:original,publicKey,tenantId:TENANT,minGeneration:4
    }),/rolled back/);
    assert.throws(()=>verifyR59PinManifest({
      manifest:{...original,clients:[P('c'.repeat(64))]},
      publicKey,tenantId:TENANT
    }),/invalid offline signature/);
  });
test('R5.9 duplicate pins, more than two pins, and incorrect windows fail signing',
  ()=>{
    assert.throws(()=>signed({clients:[
      P('a'.repeat(64)),P('a'.repeat(64))
    ],servers:[P('b'.repeat(64))]}),/duplicate/);
    assert.throws(()=>signed({clients:[
      P('a'.repeat(64)),P('b'.repeat(64)),P('c'.repeat(64))
    ],servers:[P('d'.repeat(64))]}),/one or two/);
    assert.throws(()=>signed({clients:[
      P('a'.repeat(64),clock+2000,clock+1000)
    ],servers:[P('b'.repeat(64))]}),/invalid certificate pin/);
  });
test('R5.9 generation persistence denies downgrade or same-generation rewrite',
  {skip:process.env.OX_R59_PG_E2E!=='YES'},async()=>{
    const tenantId=randomBytes(12).toString('hex');
    const pool=new pg.Pool({host:process.env.PGHOST||'127.0.0.1',
      port:Number(process.env.PGPORT||5432),
      user:process.env.PGUSER||'postgres',
      password:process.env.PGPASSWORD||'',
      database:process.env.PGDATABASE||'ox_r59',max:3});
    try{
      await pool.query(await readFile(
        new URL('../ops/r59/cert-generation.sql',import.meta.url),'utf8'));
      function make(generation,suffix){
        const manifest=signR59PinManifest({privateKey,payload:{
          tenantId,generation,issuedAt:clock-1000,expiresAt:clock+WINDOW,
          clients:[P(suffix.repeat(64))],
          servers:[P('b'.repeat(64))]
        }});
        return createR59TrustWindow({manifest,publicKey,tenantId});
      }
      const old=make(4,'a'),rewritten=make(4,'c'),newer=make(5,'d');
      await activateR59PgTrustGeneration({pool,tenantId,trustWindow:old});
      await assert.rejects(activateR59PgTrustGeneration({
        pool,tenantId,trustWindow:rewritten
      }),/same generation/);
      await activateR59PgTrustGeneration({pool,tenantId,trustWindow:newer});
      await assert.rejects(activateR59PgTrustGeneration({
        pool,tenantId,trustWindow:old
      }),/generation rollback/);
      const persisted=await pool.query(
        'SELECT generation FROM ox_r59_cert_generation WHERE tenant=$1',[tenantId]);
      assert.equal(Number(persisted.rows[0].generation),5);
    }finally{
      await pool.query('DELETE FROM ox_r59_cert_generation WHERE tenant=$1',
        [tenantId]).catch(()=>{});
      await pool.end();
    }
  });
test('R5.9 actual TLS accepts two client certificates during rotation and rejects retired pin',
  {timeout:25000},async()=>{
    const dir=await mkdtemp(join(tmpdir(),'ox-r59-cert-'));
    let server;
    try{
      const ssl=(...args)=>execFileSync('openssl',args,{cwd:dir,stdio:'pipe'});
      ssl('req','-x509','-newkey','rsa:2048','-nodes','-days','2',
        '-keyout','ca.key','-out','ca.pem','-subj','/CN=R59 Synthetic CA');
      await writeFile(join(dir,'server.ext'),
        'subjectAltName=IP:127.0.0.1,DNS:localhost\nextendedKeyUsage=serverAuth\n');
      await writeFile(join(dir,'client.ext'),'extendedKeyUsage=clientAuth\n');
      for(const [name,cn,ext] of [
        ['server','localhost','server.ext'],
        ['old','R59 Old Publisher','client.ext'],
        ['new','R59 New Publisher','client.ext']]){
        ssl('req','-newkey','rsa:2048','-nodes','-keyout',name+'.key',
          '-out',name+'.csr','-subj','/CN='+cn);
        ssl('x509','-req','-in',name+'.csr','-CA','ca.pem','-CAkey','ca.key',
          '-CAcreateserial','-days','2','-sha256','-extfile',ext,
          '-out',name+'.pem');
      }
      const [ca,serverCert,serverKey,oldCert,oldKey,newCert,newKey]=
        await Promise.all([
          'ca.pem','server.pem','server.key','old.pem','old.key',
          'new.pem','new.key'
        ].map(x=>readFile(join(dir,x))));
      let now=Date.now(),nextEpoch=0;
      const manifest=signR59PinManifest({privateKey,payload:{
        tenantId:TENANT,generation:8,issuedAt:now-1000,
        expiresAt:now+WINDOW,
        clients:[
          {sha256:certSha(oldCert),notBefore:now-1000,notAfter:now+2000},
          {sha256:certSha(newCert),notBefore:now-1000,notAfter:now+WINDOW}
        ],
        servers:[{sha256:certSha(serverCert),notBefore:now-1000,
          notAfter:now+WINDOW}]
      }});
      const trust=createR59TrustWindow({
        manifest,publicKey,tenantId:TENANT,now:()=>now
      });
      const key=randomBytes(32);
      const nonces=new Set();
      const coordinator={
        syntheticOnly:true,
        async acquire({holder}){
          return {tenant:TENANT,holder,epoch:++nextEpoch,
            leaseId:randomBytes(16).toString('hex'),
            expiresAt:now+30000,syntheticOnly:true};
        }
      };
      server=https.createServer({cert:serverCert,key:serverKey,ca,
        requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2'},
        createR58MtlsHandler({
          tenantId:TENANT,coordinator,
          nonceStore:{tenantId:TENANT,async consume(nonce){
            if(nonces.has(nonce))throw Error('replay');
            nonces.add(nonce);
          }},
          sharedKey:key,clientFingerprintSha256:certSha(oldCert),
          trustedClientPins:trust.trustedClientPins,now:()=>now
        }));
      await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
      function client(cert,privateKeyValue){
        return createR58MtlsClient({
          endpoint:'https://127.0.0.1:'+server.address().port+'/',
          tenantId:TENANT,sharedKey:key,ca,cert,key:privateKeyValue,
          serverFingerprintSha256:certSha(serverCert),
          trustedServerPins:trust.trustedServerPins,now:()=>now
        });
      }
      const oldClient=client(oldCert,oldKey),newClient=client(newCert,newKey);
      const holder='e'.repeat(24);
      assert.equal((await oldClient.acquire(holder)).holder,holder);
      assert.equal((await newClient.acquire(holder)).holder,holder);
      now+=3000;
      await assert.rejects(oldClient.acquire(holder),
        /unexpected HTTP status|remote operation denied/);
      assert.equal((await newClient.acquire(holder)).holder,holder);
    }finally{
      await new Promise(ok=>server?server.close(ok):ok());
      await rm(dir,{recursive:true,force:true});
    }
  });
