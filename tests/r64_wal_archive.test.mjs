import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,symlink,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {scanR64LocalWalArchive,signR64WalArchive,verifyR64WalArchive}
  from '../src/migration/r64-wal-archive-evidence.mjs';
const TENANT='a'.repeat(24),SYS='7392526296213040844',
  A='000000010000000000000000',B='000000010000000000000001',
  C='000000010000000000000002';
async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'ox-r64-wal-'));
  await writeFile(join(directory,A),Buffer.from('aaaa'));
  await writeFile(join(directory,B),Buffer.from('bbbb'));
  const kp=generateKeyPairSync('ed25519'),now=Date.now(),
    segments=await scanR64LocalWalArchive({directory,segmentBytes:4});
  const manifest=signR64WalArchive({privateKey:kp.privateKey,
    payload:{format:'osmanx-r64-wal-archive-v1',scope:'disposable-lab',
      tenantId:TENANT,systemId:SYS,timeline:1,targetLsn:'0/1000',
      baseBackupSha256:'f'.repeat(64),segmentBytes:4,
      segments,nonce:randomBytes(16).toString('hex'),
      issuedAt:now-1000,expiresAt:now+90000
    }
  });
  return {directory,kp,now,segments,manifest,
    async dispose(){await rm(directory,{recursive:true,force:true});}};
}
test('R6.4 two physically reread WAL segments match independent signed archive',
  async()=>{
    const f=await fixture();
    try{
      const inspected=verifyR64WalArchive({
        manifest:f.manifest,publicKey:f.kp.publicKey,
        observedSegments:await scanR64LocalWalArchive({
          directory:f.directory,segmentBytes:4
        }),tenantId:TENANT,now:()=>f.now
      });
      assert.equal(inspected.sourceBytesReread,true);
      assert.equal(inspected.observedSegments,2);
      assert.equal(inspected.signatureVerified,true);
      assert.equal(inspected.completeWalRangeIndependentlyProven,false);
      assert.equal(inspected.offsiteImmutableCustodyVerified,false);
      assert.equal(inspected.productionCutoverAllowed,false);
    }finally{await f.dispose();}
  });
test('R6.4 changed archived WAL bytes and signature refuse verification',
  async()=>{
    const f=await fixture();
    try{
      await writeFile(join(f.directory,B),Buffer.from('bbbb'));
      await writeFile(join(f.directory,B),Buffer.from('bbbc'));
      const revised=await scanR64LocalWalArchive({
        directory:f.directory,segmentBytes:4});
      assert.throws(()=>verifyR64WalArchive({
        manifest:f.manifest,publicKey:f.kp.publicKey,
        observedSegments:revised,tenantId:TENANT,now:()=>f.now
      }),/signed WAL inventory differs/);
      const forged={...f.manifest,targetLsn:'0/2000'};
      assert.throws(()=>verifyR64WalArchive({
        manifest:forged,publicKey:f.kp.publicKey,
        observedSegments:f.segments,tenantId:TENANT,now:()=>f.now
      }),/signature failed/);
    }finally{await f.dispose();}
});
test('R6.4 missing segment, gap, duplicate and cross-timeline evidence fail closed',
  async()=>{
    const f=await fixture();
    try{
      await unlink(join(f.directory,B));
      await writeFile(join(f.directory,C),Buffer.from('cccc'));
      await assert.rejects(scanR64LocalWalArchive({
        directory:f.directory,segmentBytes:4
      }),/gap/);
      const duplicate=[f.segments[0],f.segments[0]];
      assert.throws(()=>signR64WalArchive({
        privateKey:f.kp.privateKey,
        payload:{...f.manifest,segments:duplicate}
      }),/duplicate WAL/);
      assert.throws(()=>signR64WalArchive({
        privateKey:f.kp.privateKey,
        payload:{...f.manifest,segments:[f.segments[0],{
          ...f.segments[1],name:'000000020000000000000001'
        }]}
      }),/changed timeline/);
    }finally{await f.dispose();}
});
test('R6.4 symlink archive and truncated segment denied',async()=>{
  const f=await fixture();
  try{
    await unlink(join(f.directory,B));
    await symlink(join(f.directory,A),join(f.directory,B));
    await assert.rejects(scanR64LocalWalArchive({
      directory:f.directory,segmentBytes:4
    }),/link or wrong size/);
    await unlink(join(f.directory,B));
    await writeFile(join(f.directory,B),Buffer.from('bb'));
    await assert.rejects(scanR64LocalWalArchive({
      directory:f.directory,segmentBytes:4
    }),/truncated/);
  }finally{await f.dispose();}
});
test('R6.4 foreign tenant and expired archive receipt do not certify backup',
  async()=>{
    const f=await fixture();
    try{
      assert.throws(()=>verifyR64WalArchive({
        manifest:f.manifest,publicKey:f.kp.publicKey,
        observedSegments:f.segments,tenantId:'b'.repeat(24),
        now:()=>f.now
      }),/foreign|differs/);
      assert.throws(()=>verifyR64WalArchive({
        manifest:f.manifest,publicKey:f.kp.publicKey,
        observedSegments:f.segments,tenantId:TENANT,
        now:()=>f.now+200000
      }),/expired/);
    }finally{await f.dispose();}
});
