import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {signR64PitrBoundary,verifyR64PitrBoundary}
  from '../src/migration/r64-pitr-boundary.mjs';
const TENANT='a'.repeat(24),CASE='b'.repeat(32),
  SYS='7392526296213040844',SHA='c'.repeat(64);
function fixture(){
  const now=Date.now(),kp=generateKeyPairSync('ed25519');
  const archiveReceipt={tenantId:TENANT,signatureVerified:true,
    archiveEvidenceSha256:SHA,
    baseBackupSha256:'d'.repeat(64),targetLsn:'0/2000'};
  const manifest=signR64PitrBoundary({privateKey:kp.privateKey,payload:{
    format:'osmanx-r64-pitr-boundary-v1',scope:'disposable-lab',
    tenantId:TENANT,incidentId:CASE,systemId:SYS,
    targetLsn:'0/2000',afterLsn:'0/3000',
    archiveEvidenceSha256:SHA,baseBackupSha256:'d'.repeat(64),
    nonce:randomBytes(16).toString('hex'),
    issuedAt:now-1000,expiresAt:now+90000
  }});
  return {manifest,publicKey:kp.publicKey,tenantId:TENANT,
    sourceMarkers:['baseline','selected','excluded'],
    restoredMarkers:['baseline','selected'],restoredSystemId:SYS,
    archiveReceipt,now:()=>now};
}
test('R6.4 signed PITR receipt attests selected present and later acknowledged transaction excluded',
  ()=>{
    const proof=verifyR64PitrBoundary(fixture());
    assert.equal(proof.selectedTransactionRecovered,true);
    assert.equal(proof.intentionallyLaterTransactionExcluded,true);
    assert.equal(proof.unknownCustomerWritesNotCounted,true);
    assert.equal(proof.industrialZeroRpoCertified,false);
    assert.equal(proof.productionCutoverAllowed,false);
});
test('R6.4 intentionally excluded transaction cannot appear in restored database',
  ()=>{
    const f=fixture();
    assert.throws(()=>verifyR64PitrBoundary({
      ...f,restoredMarkers:['baseline','selected','excluded']
    }),/includes late COMMIT/);
    assert.throws(()=>verifyR64PitrBoundary({
      ...f,restoredMarkers:['baseline']
    }),/lost selected COMMIT/);
    assert.throws(()=>verifyR64PitrBoundary({
      ...f,sourceMarkers:['baseline','selected']
    }),/source transaction receipts/);
});
test('R6.4 archive tampering, wrong target, forged signature and foreign tenant denied',
  ()=>{
    const f=fixture();
    assert.throws(()=>verifyR64PitrBoundary({
      ...f,archiveReceipt:{...f.archiveReceipt,
        archiveEvidenceSha256:'f'.repeat(64)}
    }),/not bound to the same target/);
    assert.throws(()=>verifyR64PitrBoundary({
      ...f,manifest:{...f.manifest,afterLsn:'0/4000'}
    }),/invalid offline PITR boundary signature/);
    assert.throws(()=>verifyR64PitrBoundary({
      ...f,tenantId:'f'.repeat(24)
    }),/not bound to the same target/);
});
test('R6.4 post-target WAL must be strictly later than selected transaction',()=>{
  const f=fixture();
  assert.throws(()=>verifyR64PitrBoundary({
    ...f,manifest:{...f.manifest,afterLsn:'0/1000'}
  }),/late acknowledged COMMIT is not after/);
  assert.throws(()=>verifyR64PitrBoundary({
    ...f,now:()=>Date.now()+200000
  }),/expired or future/);
});
