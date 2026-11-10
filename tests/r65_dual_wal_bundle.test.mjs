import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {signR65DualWalBundle,verifyR65DualWalBundle}
  from '../src/migration/r65-dual-wal-bundle.mjs';
const T='a'.repeat(24),I='b'.repeat(32),
  SYS='7392526296213040844',SHA='c'.repeat(64);
function fixture(){
  const now=Date.now(),kp=generateKeyPairSync('ed25519');
  const inventory=[{name:'000000010000000000000000',
    sha256:SHA,size:16*1024*1024}];
  const receipts=['first-process','second-process'].map((storeId,i)=>({
    format:'osmanx-r65-wal-object-receipt-v1',
    tenantId:T,storeId,name:inventory[0].name,
    sha256:SHA,size:inventory[0].size,
    versionId:'version-'+i,
    etag:'"f31a9bc0a4d9e5"',
    retentionMode:'COMPLIANCE',
    retainedUntil:'2090-01-01T00:00:00.000Z'
  }));
  const payload={format:'osmanx-r65-dual-worm-bundle-v1',
    scope:'disposable-lab',tenantId:T,incidentId:I,
    systemId:SYS,timeline:1,targetLsn:'0/2020',
    baseBackupSha256:'e'.repeat(64),inventory,receipts,
    nonce:randomBytes(16).toString('hex'),
    issuedAt:now-1000,expiresAt:now+60000};
  const manifest=signR65DualWalBundle({
    payload,privateKey:kp.privateKey
  });
  return {payload,manifest,publicKey:kp.publicKey,now:()=>now};
}
test('R6.5 two independent retained WORM versions sealed to backup and WAL target',()=>{
  const f=fixture();
  const evidence=verifyR65DualWalBundle({
    manifest:f.manifest,publicKey:f.publicKey,tenantId:T,now:f.now
  });
  assert.equal(evidence.storeCount,2);
  assert.equal(evidence.receiptCount,2);
  assert.equal(evidence.signatureVerified,true);
  assert.equal(evidence.independentlyRereadFromProviders,false);
  assert.equal(evidence.offsiteGeographicCustodyCertified,false);
  assert.equal(evidence.productionCutoverAllowed,false);
});
test('R6.5 missing mirror, duplicate store, forged version or altered SHA fail closed',()=>{
  const f=fixture();
  assert.throws(()=>signR65DualWalBundle({
    payload:{...f.payload,receipts:f.payload.receipts.slice(1)},
    privateKey:generateKeyPairSync('ed25519').privateKey
  }),/complete custody inventory/);
  assert.throws(()=>signR65DualWalBundle({
    payload:{...f.payload,receipts:[
      f.payload.receipts[0],f.payload.receipts[0]
    ]},privateKey:generateKeyPairSync('ed25519').privateKey
  }),/duplicate WORM version/);
  assert.throws(()=>verifyR65DualWalBundle({
    manifest:{...f.manifest,receipts:[
      {...f.manifest.receipts[0],versionId:'another-version'},
      f.manifest.receipts[1]
    ]},publicKey:f.publicKey,tenantId:T,now:f.now
  }),/offline bundle signature|canonical signed WAL/);
  assert.throws(()=>verifyR65DualWalBundle({
    manifest:{...f.manifest,baseBackupSha256:'f'.repeat(64)},
    publicKey:f.publicKey,tenantId:T,now:f.now
  }),/offline bundle signature|canonical signed WAL/);
});
test('R6.5 wrong tenant, expired signature and short WORM retention rejected',()=>{
  const f=fixture();
  assert.throws(()=>verifyR65DualWalBundle({
    manifest:f.manifest,publicKey:f.publicKey,
    tenantId:'d'.repeat(24),now:f.now
  }),/canonical signed WAL bundle/);
  assert.throws(()=>verifyR65DualWalBundle({
    manifest:f.manifest,publicKey:f.publicKey,
    tenantId:T,now:()=>Date.now()+200000
  }),/expired/);
  assert.throws(()=>signR65DualWalBundle({
    payload:{...f.payload,receipts:f.payload.receipts.map(x=>({
      ...x,retainedUntil:'2020-01-01T00:00:00.000Z'
    }))},privateKey:generateKeyPairSync('ed25519').privateKey
  }),/retention not independently bound/);
});
