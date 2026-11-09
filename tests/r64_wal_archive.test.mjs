import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {makeR64WalSegmentRecord,signR64WalArchive,verifyR64WalArchive}
  from '../src/migration/r64-wal-archive.mjs';
const SIZE=16*1024*1024,TENANT='a'.repeat(24),
  SYSTEM='7392526296213040844',BACKUP='d'.repeat(64),
  FIRST='000000010000000000000001',
  SECOND='000000010000000000000002';
function fixture(){
  const pair=generateKeyPairSync('ed25519'),now=Date.now(),
    data=new Map([[FIRST,Buffer.alloc(SIZE,0x17)],
      [SECOND,Buffer.alloc(SIZE,0x27)]]);
  const payload={format:'osmanx-r64-wal-archive-v1',
    scope:'disposable-lab',tenantId:TENANT,systemId:SYSTEM,
    timeline:1,baseBackupSha256:BACKUP,targetLsn:'0/01200000',
    segments:[...data].map(([name,bytes])=>
      makeR64WalSegmentRecord({name,bytes})),
    issuer:'recovery_auditor',nonce:randomBytes(16).toString('hex'),
    issuedAt:now-1000,expiresAt:now+100000};
  const packet=signR64WalArchive({payload,privateKey:pair.privateKey});
  const verify=async o=>verifyR64WalArchive({
    packet,publicKey:pair.publicKey,tenantId:TENANT,systemId:SYSTEM,
    baseBackupSha256:BACKUP,reader:async name=>data.get(name),
    now:()=>now,...o
  });
  return {pair,now,data,payload,packet,verify};
}
test('R6.4 signed, bytewise verified contiguous 16MiB WAL timeline is diagnostic only',
  async()=>{
    const f=fixture(),result=await f.verify();
    assert.equal(result.verifiedSegments,2);
    assert.equal(result.targetLsn,'0/01200000');
    assert.equal(result.fullSegmentHashesVerified,true);
    assert.equal(result.walPitrCompleted,false);
    assert.equal(result.mayRestoreCustomerData,false);
    assert.equal(result.productionCutoverAllowed,false);
  });
test('R6.4 altered byte, missing file and truncated archive fail closed',async()=>{
  const f=fixture();f.data.get(FIRST)[234]=0x33;
  await assert.rejects(f.verify(),/tampered WAL segment/);
  const second=fixture();second.data.delete(SECOND);
  await assert.rejects(second.verify(),/missing, truncated/);
  const short=fixture();short.data.set(FIRST,Buffer.alloc(1024));
  await assert.rejects(short.verify(),/missing, truncated/);
});
test('R6.4 rejects a gap, wrong timeline, duplicate and uncovered target LSN',()=>{
  const f=fixture();
  for(const replace of [
    {...f.payload,segments:[f.payload.segments[0],{
      ...f.payload.segments[1],name:'000000010000000000000003'}]},
    {...f.payload,segments:[f.payload.segments[0],{
      ...f.payload.segments[1],name:'000000020000000000000002'}]},
    {...f.payload,segments:[f.payload.segments[0],f.payload.segments[0]]},
    {...f.payload,targetLsn:'0/10000000'}
  ]){
    assert.throws(()=>signR64WalArchive({
      payload:replace,privateKey:f.pair.privateKey
    }),/WAL archive refused/);
  }
});
test('R6.4 rejects expired, copied, unsigned and cross-tenant archive attestations',
  async()=>{
    const f=fixture();
    await assert.rejects(f.verify({now:()=>f.now+300000}),/expired/);
    await assert.rejects(f.verify({tenantId:'e'.repeat(24)}),
      /foreign cluster/);
    const forged={...f.packet,targetLsn:'0/01300000'};
    await assert.rejects(f.verify({packet:forged}),/signature mismatch/);
    await assert.rejects(f.verify({publicKey:generateKeyPairSync(
      'ed25519').publicKey}),/signature mismatch/);
  });
test('R6.4 WAL filename traversal, lower-case and non-16MiB bytes cannot enter manifest',
  ()=>{
    const f=fixture();
    assert.throws(()=>makeR64WalSegmentRecord({
      name:'../'+FIRST,bytes:Buffer.alloc(SIZE)
    }),/exact full/);
    assert.throws(()=>makeR64WalSegmentRecord({
      name:FIRST.toLowerCase().replace('A','a')+'x',
      bytes:Buffer.alloc(SIZE)
    }),/exact full/);
    assert.throws(()=>makeR64WalSegmentRecord({
      name:FIRST,bytes:Buffer.alloc(2048)
    }),/exact full/);
    assert.equal(f.packet.segments.length,2);
  });
