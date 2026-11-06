import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createR46VaultBackup} from '../src/migration/r46-vault.mjs';
import {publishR49IndependentlyLockedBackup,restoreR49Offline}
  from '../src/migration/r49-operational-dr.mjs';

const projectId='11111111-1111-4111-8111-111111111111';
const plaintext=Buffer.concat([Buffer.from('SQLite format 3\0'),randomBytes(6000)]);
async function setup(){
  const root=await mkdtemp(join(tmpdir(),'ox-r49-worm-'));
  const vault={directory:join(root,'vault'),projectId,
    manifestSha256:'e'.repeat(64),catalogKey:randomBytes(32),
    keyRing:{activeId:'key_one',keys:{key_one:randomBytes(32)}}};
  await createR46VaultBackup(vault,{plaintext});
  let denyKey='',committed=0,observed=0;
  const files=new Map();
  const remote={
    async put(key,bytes){files.set(key,Buffer.from(bytes));return true;},
    async get(key){if(!files.has(key))throw Error('remote missing');return Buffer.from(files.get(key));},
    async assertBucketControls(){return {versioningEnabled:true,objectLockEnabled:true};},
    async inspectR49Worm(key){
      observed++;
      if(key===denyKey)return {objectLockVerified:false,versioned:false};
      return {objectLockVerified:true,versioned:true,retentionMode:'COMPLIANCE'};
    }
  };
  const witness={async commit(head){committed++;return head;},
    async verify(head){if(!head.catalogSha256)throw Error('bad head');return {anchorVerified:true};}};
  return {vault,remote,witness,files,
    forbid:key=>{denyKey=key},counts:()=>({committed,observed}),
    close:()=>rm(root,{recursive:true,force:true})};
}
test('R4.9 a missing WORM archive blocks independent witness commitment',async()=>{
  const f=await setup();
  try{
    const local=(await import('../src/migration/r46-vault.mjs')).listR46Vault(f.vault);
    const id=(await local).archives[0].id;
    f.forbid('archives/'+id+'.oxb');
    await assert.rejects(publishR49IndependentlyLockedBackup(f),
      /archive object lacks WORM proof/);
    assert.equal(f.counts().committed,0);
    assert(f.counts().observed>=1);
  }finally{await f.close();}
});
test('R4.9 a WORM control catalog or mutable head violation blocks witness',async()=>{
  const f=await setup();
  try{
    f.forbid('head.json');
    await assert.rejects(publishR49IndependentlyLockedBackup(f),
      /control object lacks WORM proof/);
    assert.equal(f.counts().committed,0);
  }finally{await f.close();}
});
test('R4.9 publishes witnessed copy only after all three immutable object proofs',async()=>{
  const f=await setup();
  try{
    const proof=await publishR49IndependentlyLockedBackup(f);
    assert.equal(proof.s3ComplianceObjectVersionsVerified,3);
    assert.equal(proof.independentWitnessVerified,true);
    assert.equal(proof.productionCutoverAllowed,false);
    assert.equal(f.counts().committed,1);
    assert(f.files.has('head.json'));
  }finally{await f.close();}
});
test('R4.9 offline restore refuses relative recovery path before external trust access',async()=>{
  const f=await setup();
  try{
    await assert.rejects(restoreR49Offline({...f,
      bundleDir:'/not-a-bundle',trustedPublicKey:'/missing',
      recoveryDirectory:'relative/path'}),/absolute private recovery path required/);
  }finally{await f.close();}
});
