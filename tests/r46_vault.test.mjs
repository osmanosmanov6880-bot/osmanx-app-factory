import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createR46VaultBackup,readR46VaultBackup,listR46Vault,
  rotateR46VaultBackup,pruneR46Vault} from '../src/migration/r46-vault.mjs';
import {validateR46Options} from '../src/migration/r46-http.mjs';

const projectId='11111111-1111-4111-8111-111111111111',otherProject='22222222-2222-4222-8222-222222222222';
const manifestSha256='a'.repeat(64),catalogKey=randomBytes(32),v1=randomBytes(32),v2=randomBytes(32);
const payload=Buffer.concat([Buffer.from('SQLite format 3\0'),randomBytes(8192)]);
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'ox-r46-unit-'));
  return {dir,options:{directory:join(dir,'vault'),projectId,manifestSha256,catalogKey,
    keyRing:{activeId:'key_one',keys:{key_one:v1}}},
    async close(){await rm(dir,{recursive:true,force:true});}};
}
test('R4.6 persists authenticated encrypted backups across repeated vault opens',async()=>{
  const f=await fixture();
  try{
    const one=await createR46VaultBackup(f.options,{plaintext:payload});
    const two=await createR46VaultBackup(f.options,{plaintext:payload});
    assert.notEqual(one.record.id,two.record.id);
    assert.equal(one.record.keyId,'key_one');
    const index=await listR46Vault({...f.options});
    assert.equal(index.activeCount,2);
    assert(index.archives.every(x=>x.bytes>payload.length));
    assert.equal(index.productionCutoverAllowed,false);
    const recovered=await readR46VaultBackup({...f.options},{id:one.record.id});
    try{assert.deepEqual(recovered.plaintext,payload);}finally{recovered.plaintext.fill(0);}
    const file=await readFile(join(f.options.directory,one.record.id+'.oxb'));
    assert.equal(file.includes(Buffer.from('SQLite format 3\0')),false);
    if(process.platform!=='win32')assert.equal((await stat(join(f.options.directory,'catalog.jsonl'))).mode&0o077,0);
  }finally{await f.close();}
});
test('R4.6 encrypted archive refuses wrong decryption key and wrong signed tenant',async()=>{
  const f=await fixture();
  try{
    const saved=await createR46VaultBackup(f.options,{plaintext:payload});
    await assert.rejects(readR46VaultBackup({...f.options,
      keyRing:{activeId:'key_one',keys:{key_one:randomBytes(32)}}},{id:saved.record.id}),
      /archive authentication failed/);
    await assert.rejects(listR46Vault({...f.options,projectId:otherProject}),
      /catalog sequence or tenant binding changed/);
    await assert.rejects(listR46Vault({...f.options,manifestSha256:'b'.repeat(64)}),
      /catalog sequence or tenant binding changed/);
  }finally{await f.close();}
});
test('R4.6 catalog catches tampering while ciphertext hash catches archive modification',async()=>{
  const f=await fixture();
  try{
    const saved=await createR46VaultBackup(f.options,{plaintext:payload});
    const archive=join(f.options.directory,saved.record.id+'.oxb');
    const original=await readFile(archive);
    const forged=Buffer.from(original);forged[forged.length-1]^=1;
    await writeFile(archive,forged);
    await assert.rejects(readR46VaultBackup(f.options,{id:saved.record.id}),/SHA-256 mismatch/);
    await writeFile(archive,original);
    const catalog=join(f.options.directory,'catalog.jsonl'),body=await readFile(catalog,'utf8');
    await writeFile(catalog,body.replace('"keyId":"key_one"','"keyId":"key_two"'));
    await assert.rejects(listR46Vault(f.options),/catalog digest mismatch/);
  }finally{await f.close();}
});
test('R4.6 rotation requires a new key and retains the original until explicit prune',async()=>{
  const f=await fixture();
  try{
    const old=await createR46VaultBackup(f.options,{plaintext:payload});
    await assert.rejects(rotateR46VaultBackup(f.options,{id:old.record.id}),
      /rotation requires a different active key/);
    const upgraded={...f.options,keyRing:{activeId:'key_two',keys:{key_one:v1,key_two:v2}}};
    const rotated=await rotateR46VaultBackup(upgraded,{id:old.record.id});
    assert.equal(rotated.originalRetained,true);
    assert.equal(rotated.archive.keyId,'key_two');
    const index=await listR46Vault(upgraded);
    assert.equal(index.activeCount,2);
    for(const id of [old.record.id,rotated.archive.id]){
      const item=await readR46VaultBackup(upgraded,{id});
      try{assert.deepEqual(item.plaintext,payload);}finally{item.plaintext.fill(0);}
    }
    const third=await createR46VaultBackup(upgraded,{plaintext:payload});
    const pruned=await pruneR46Vault(upgraded,{keep:2});
    assert.equal(pruned.removed.length,1);
    assert.equal(pruned.removed[0].id,old.record.id);
    assert.equal((await listR46Vault(upgraded)).activeCount,2);
    await assert.rejects(readR46VaultBackup(upgraded,{id:old.record.id}),
      /not active or no longer retained/);
    await assert.rejects(pruneR46Vault(upgraded,{keep:1}),/retain at least two/);
    const item=await readR46VaultBackup(upgraded,{id:third.record.id});item.plaintext.fill(0);
  }finally{await f.close();}
});
test('R4.6 retention fails closed if any active archive is not decryptable',async()=>{
  const f=await fixture();
  try{
    const old=await createR46VaultBackup(f.options,{plaintext:payload});
    const upgraded={...f.options,keyRing:{activeId:'key_two',keys:{key_one:v1,key_two:v2}}};
    await rotateR46VaultBackup(upgraded,{id:old.record.id});
    await createR46VaultBackup(upgraded,{plaintext:payload});
    await assert.rejects(pruneR46Vault({...upgraded,keyRing:{
      activeId:'key_two',keys:{key_two:v2}}},{keep:2}),
      /archive key unavailable/);
    assert.equal((await listR46Vault(upgraded)).activeCount,3);
  }finally{await f.close();}
});
test('R4.6 refuses orphan archives and concurrent/stale writer lock files',async()=>{
  const f=await fixture();
  try{
    await createR46VaultBackup(f.options,{plaintext:payload});
    const orphan='e'.repeat(32)+'.oxb';
    await writeFile(join(f.options.directory,orphan),Buffer.from('untracked'));
    await assert.rejects(listR46Vault(f.options),/orphan or unexpected encrypted archive/);
    await rm(join(f.options.directory,orphan));
    const lock=join(f.options.directory,'.vault.lock');
    await writeFile(lock,Buffer.from('untrusted stale lock'));
    await assert.rejects(createR46VaultBackup(f.options,{plaintext:payload}),/EEXIST/);
    await rm(lock);
    assert.equal((await listR46Vault(f.options)).activeCount,1);
  }finally{await f.close();}
});
test('R4.6 is disabled by default and requires separate external keys',()=>{
  assert.equal(validateR46Options({}),null);
  assert.throws(()=>validateR46Options({OX_R46_VAULT:'YES'}),/isolated synthetic/);
  const base={OX_R46_VAULT:'YES',OX_R46_CONFIRM_SYNTHETIC:'YES',
    OX_R40_EPHEMERAL:'YES',OX_R40_PG_PREVIEW:'YES',
    OX_R42_PG_RECONCILIATION:'YES',OX_R43_SHADOW_REPLAY:'YES',
    OX_R43_CONFIRM_SYNTHETIC:'YES',OX_R44_CRITICAL_PARITY:'YES',
    OX_R44_CONFIRM_SYNTHETIC:'YES',OX_R45_BACKUP_DRILL:'YES',
    OX_R45_CONFIRM_SYNTHETIC:'YES',OX_R42_JOURNAL_HMAC_KEY:randomBytes(32).toString('hex'),
    OX_R40_PG_BUNDLE:'/private/synthetic',OX_R40_PG_TRUST_KEY:'/private/trusted-public.pem',
    OX_R46_ACTIVE_KEY_ID:'key_one',OX_R46_ACTIVE_KEY_HEX:v1.toString('hex'),
    OX_R46_CATALOG_KEY_HEX:catalogKey.toString('hex')};
  assert.equal(validateR46Options(base).vault,true);
  assert.equal(validateR46Options(base).retentionCount,3);
  assert.throws(()=>validateR46Options({...base,OX_R46_CATALOG_KEY_HEX:v1.toString('hex')}),
    /catalog authentication key must be independent/);
  assert.throws(()=>validateR46Options({...base,OX_R46_RETENTION_COUNT:'1'}),
    /retention must keep 2-20/);
});
