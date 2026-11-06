import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sealR45Snapshot,openR45Snapshot} from '../src/migration/r45-sealed-backup.mjs';
import {verifyR45SignedSnapshot} from '../src/migration/r45-restore-drill.mjs';
import {appendR45Evidence,verifyR45Evidence} from '../src/migration/r45-evidence.mjs';
import {validateR45Options} from '../src/migration/r45-http.mjs';

const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const sha='0'.repeat(64),key=randomBytes(32),ctx={secret:key,projectId:id,manifestSha256:sha};
const payload=Buffer.from('SQLite format 3\0'.padEnd(1024,'!'));
const fakeEvidence=()=>({
  format:'osmanx-r45-backup-restore-drill-v1',syntheticOnly:true,
  verified:true,sourcePrimaryModified:false,productionCutoverAllowed:false,
  encryptedArchiveVerified:true,decryptedBytesVerified:true,
  manifestSha256:sha,encryptedSha256:'a'.repeat(64),financialTotalsHmac:'b'.repeat(64),
  finishedAt:'2026-11-06T00:00:00.000Z',snapshotSizeBytes:1024,
  signedTablesVerified:10,financialRecords:1,tenantToken:'private-tenant-token'
});
test('R4.5 AES-256-GCM round trip never embeds plaintext in saved ciphertext',()=>{
  const {envelope,envelopeSha256}=sealR45Snapshot(payload,ctx);
  assert.match(envelopeSha256,/^[a-f0-9]{64}$/);
  assert.equal(envelope.includes(Buffer.from('SQLite format 3')),false);
  assert.deepEqual(openR45Snapshot(envelope,ctx),payload);
  assert.notDeepEqual(sealR45Snapshot(payload,ctx).envelope,envelope,'Each archive must have random nonce and salt');
});
test('R4.5 refuses ciphertext modification, a corrupted authentication tag and a wrong key',()=>{
  const {envelope}=sealR45Snapshot(payload,ctx);
  for(const offset of [30,40,envelope.length-1]){
    const broken=Buffer.from(envelope);broken[offset]^=1;
    assert.throws(()=>openR45Snapshot(broken,ctx),/authentication failed/);
  }
  assert.throws(()=>openR45Snapshot(envelope,{...ctx,secret:randomBytes(32)}),/authentication failed/);
  assert.deepEqual(openR45Snapshot(envelope,ctx),payload,'Earlier failures must not corrupt the original ciphertext');
});
test('R4.5 binds sealed archive to the signed tenant and Ed25519 manifest hash',()=>{
  const {envelope}=sealR45Snapshot(payload,ctx);
  assert.throws(()=>openR45Snapshot(envelope,{...ctx,projectId:other}),/authentication failed/);
  assert.throws(()=>openR45Snapshot(envelope,{...ctx,manifestSha256:'1'.repeat(64)}),/authentication failed/);
  assert.throws(()=>sealR45Snapshot(payload,{...ctx,secret:Buffer.alloc(8)}),/32-byte external encryption key/);
  assert.throws(()=>openR45Snapshot(Buffer.from('garbage'),ctx),/invalid encrypted archive bounds/);
});
test('R4.5 signed data checker refuses a source with extra unsigned table',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE clients(id TEXT PRIMARY KEY); CREATE TABLE extra(id TEXT PRIMARY KEY)');
    const entry={role:'crm',tables:[{name:'clients',primary:['id'],
      columns:[{name:'id',type:'TEXT'}],rows:0,sha256:sha}]};
    assert.throws(()=>verifyR45SignedSnapshot(db,entry,{secret:key}),
      /table inventory differs from signed source/);
  }finally{db.close();}
});
test('R4.5 private evidence chain persists and detects tampering with the receipt',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ox-r45-evidence-'));
  try{
    const first=await appendR45Evidence({directory:dir,secret:key,receipt:fakeEvidence()});
    const second=await appendR45Evidence({directory:dir,secret:key,receipt:fakeEvidence()});
    assert.equal(first.sequence,1);assert.equal(second.sequence,2);
    assert.equal((await verifyR45Evidence({directory:dir,secret:key})).entries,2);
    await assert.rejects(verifyR45Evidence({directory:dir,secret:randomBytes(32)}),/HMAC mismatch/);
    const file=join(dir,'restore.jsonl'),original=await readFile(file,'utf8');
    await writeFile(file,original.replace('"financialRecords":1','"financialRecords":999'));
    await assert.rejects(verifyR45Evidence({directory:dir,secret:key}),/evidence hash changed/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('R4.5 journal refuses forged production cutover approvals or unverified receipts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ox-r45-unsafe-'));
  try{
    await assert.rejects(appendR45Evidence({directory:dir,secret:key,receipt:
      {...fakeEvidence(),productionCutoverAllowed:true}}),/unsafe restore evidence/);
    await assert.rejects(appendR45Evidence({directory:dir,secret:key,receipt:
      {...fakeEvidence(),encryptedArchiveVerified:false}}),/unsafe restore evidence/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('R4.5 refuses enablement without all predecessor trust and synthetic fixture gates',()=>{
  assert.equal(validateR45Options({}),null);
  assert.throws(()=>validateR45Options({OX_R45_BACKUP_DRILL:'YES'}),/isolated synthetic/);
  const env={
    OX_R45_BACKUP_DRILL:'YES',OX_R45_CONFIRM_SYNTHETIC:'YES',
    OX_R40_EPHEMERAL:'YES',OX_R40_PG_PREVIEW:'YES',
    OX_R42_PG_RECONCILIATION:'YES',OX_R43_SHADOW_REPLAY:'YES',
    OX_R43_CONFIRM_SYNTHETIC:'YES',OX_R44_CRITICAL_PARITY:'YES',
    OX_R44_CONFIRM_SYNTHETIC:'YES',
    OX_R42_JOURNAL_HMAC_KEY:key.toString('hex'),
    OX_R40_PG_BUNDLE:'/synthetic',OX_R40_PG_TRUST_KEY:'/synthetic-key'
  };
  assert.equal(validateR45Options(env).backupDrill,true);
  assert.equal(validateR45Options(env).productionCutoverAllowed,false);
  assert.throws(()=>validateR45Options({...env,OX_R44_CONFIRM_SYNTHETIC:'NO'}),/signed financial/);
});
