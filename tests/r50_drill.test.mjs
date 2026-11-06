import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createR46VaultBackup} from '../src/migration/r46-vault.mjs';
import {synchronizeR47Offsite,readR47SignedRemoteHead,r47TenantToken}
  from '../src/migration/r47-offsite.mjs';
import {runR50RecoveryExercise} from '../src/migration/r50-drill.mjs';
import {readR50Evidence} from '../src/migration/r50-evidence.mjs';
const projectId='11111111-1111-4111-8111-111111111111';
async function setup(){
  const root=await mkdtemp(join(tmpdir(),'ox-r50-drill-')),bucket=new Map();
  const vault={projectId,directory:join(root,'vault'),manifestSha256:'f'.repeat(64),
    catalogKey:randomBytes(32),keyRing:{activeId:'sample_key',keys:{sample_key:randomBytes(32)}}};
  const bytes=Buffer.concat([Buffer.from('SQLite format 3\0'),randomBytes(8000)]);
  await createR46VaultBackup(vault,{plaintext:bytes});
  const remote={
    put:async(key,bytes)=>{bucket.set(key,Buffer.from(bytes));return true;},
    get:async key=>{if(!bucket.has(key))throw Error('remote object missing');return Buffer.from(bucket.get(key));}
  };
  await synchronizeR47Offsite({vault,remote});
  const head=await readR47SignedRemoteHead({vault,remote});
  const witness={
    current:async()=>({...head,entries:head.entries,committedAt:new Date().toISOString()}),
    verify:async other=>{
      if(other.catalogSha256!==head.catalogSha256||other.entries!==head.entries)
        throw Error('stale signed witness');
      return {anchorVerified:true};
    }
  };
  const evidence={directory:join(root,'evidence'),key:randomBytes(32),
    tenantToken:r47TenantToken(vault.catalogKey,projectId)};
  const recoveredDir=join(root,'recovered');await mkdir(recoveredDir,{mode:0o700});
  const restore=async()=>{
    const file=join(recoveredDir,'synthetic.sqlite');
    await writeFile(file,bytes,{mode:0o600,flag:'wx'});
    return {outputFile:file,catalogWitnessVerified:true,objectLockVerified:true,
      readOnlySource:true,signedTablesVerified:8,productionCutoverAllowed:false};
  };
  const base={vault,remote,witness,evidence,restore,recoveryDirectory:recoveredDir,
    bundleDir:join(root,'none'),trustedPublicKey:'synthetic',
    storageEndpoint:'http://127.0.0.1:9000/',witnessEndpoint:'http://127.0.0.1:9100/',
    allowSyntheticLoopback:true,resolver:async()=>[{address:'127.0.0.1',family:4}]};
  return {root,base,recoveredDir,bytes,close:()=>rm(root,{recursive:true,force:true})};
}
test('R5.0 accepts signed synthetic recovery, records HMAC evidence, never approves production',async()=>{
  const f=await setup();
  try{
    const proof=await runR50RecoveryExercise(f.base);
    assert.equal(proof.syntheticDrillAccepted,true);
    assert.equal(proof.signedRecoveryVerified,true);
    assert.equal(proof.networkSeparationProof,false);
    assert.equal(proof.physicalFailureDomainsIndependentlyVerified,false);
    assert.equal(proof.productionCutoverAllowed,false);
    const report=await readR50Evidence(f.base.evidence);
    assert.equal(report.recordCount,1);assert.equal(report.lastVerdict,'PASS');
  }finally{await f.close();}
});
test('R5.0 stale confirmed backup records failure without upgrading readiness',async()=>{
  const f=await setup();
  try{
    const x=await runR50RecoveryExercise({...f.base,
      now:Date.now()+3600000,maxBackupAgeMs:60000});
    assert.equal(x.syntheticDrillAccepted,false);
    assert.equal(x.meetsBackupAge,false);
    assert.equal((await readR50Evidence(f.base.evidence)).lastVerdict,'FAIL');
  }finally{await f.close();}
});
test('R5.0 refuses output outside protected recovery directory and persists FAIL evidence',async()=>{
  const f=await setup();
  try{
    await assert.rejects(runR50RecoveryExercise({...f.base,restore:async()=>({
      outputFile:'/tmp/escaped.sqlite',catalogWitnessVerified:true,objectLockVerified:true,
      signedTablesVerified:8,readOnlySource:true,productionCutoverAllowed:false
    })}),/signed recovery rejected/);
    assert.equal((await readR50Evidence(f.base.evidence)).lastVerdict,'FAIL');
  }finally{await f.close();}
});
test('R5.0 independent evidence HMAC key cannot be reused from vault',async()=>{
  const f=await setup();
  try{
    await assert.rejects(runR50RecoveryExercise({...f.base,evidence:{
      ...f.base.evidence,key:f.base.vault.catalogKey}}),/independent evidence key/);
  }finally{await f.close();}
});
test('R5.0 witness rollback is blocked before any isolated restore can run',async()=>{
  const f=await setup();
  try{
    let called=false;
    await assert.rejects(runR50RecoveryExercise({...f.base,
      witness:{current:async()=>({...await f.base.witness.current(),
        catalogSha256:'a'.repeat(64)}),verify:f.base.witness.verify},
      restore:async()=>{called=true;throw Error('would restore');}}),
    /witness is not bound/);
    assert.equal(called,false);
  }finally{await f.close();}
});
