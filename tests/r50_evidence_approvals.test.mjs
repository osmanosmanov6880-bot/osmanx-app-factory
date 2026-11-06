import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {appendR50Evidence,readR50Evidence} from '../src/migration/r50-evidence.mjs';
import {verifyR50IndependentReviews,canonicalR50ApprovalMessage}
  from '../src/migration/r50-approvals.mjs';
const token='a'.repeat(24),hash='b'.repeat(64);
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'ox-r50-evidence-'));
  return {root,opts:{directory:join(root,'evidence'),tenantToken:token,key:randomBytes(32)},
    close:()=>rm(root,{recursive:true,force:true})};
}
const proof={verdict:'PASS',reasonCode:'VERIFIED',catalogSha256:hash,
  witnessConfirmed:true,signedRestoreVerified:true,
  elapsedMs:1234,confirmedAgeMs:6000};
test('R5.0 HMAC-chained evidence persists independent readback and never approves prod',async()=>{
  const f=await fixture();try{
    const one=await appendR50Evidence(f.opts,proof);
    const two=await appendR50Evidence(f.opts,{...proof,elapsedMs:1240});
    assert.equal(two.sequence,2);
    assert.notEqual(one.headSha256,two.headSha256);
    const verified=await readR50Evidence({...f.opts});
    assert.equal(verified.recordCount,2);
    assert.equal(verified.lastVerdict,'PASS');
    assert.equal(verified.headSha256,two.headSha256);
    assert.equal(verified.externallyAnchored,false);
    assert.equal(verified.productionCutoverAllowed,false);
    const bytes=await readFile(join(f.opts.directory,'events.jsonl'));
    assert.equal(bytes.includes(Buffer.from('SQLite format 3')),false);
    if(process.platform!=='win32'){
      const {stat}=await import('node:fs/promises');
      assert.equal((await stat(join(f.opts.directory,'events.jsonl'))).mode&0o077,0);
    }
  }finally{await f.close();}
});
test('R5.0 rejects forged PASS receipt and arbitrary fields or reason codes',async()=>{
  const f=await fixture();try{
    await assert.rejects(appendR50Evidence(f.opts,{...proof,witnessConfirmed:false}),
      /PASS without both signed recovery proofs/);
    await assert.rejects(appendR50Evidence(f.opts,{...proof,reasonCode:'CRITICAL; DROP TABLE'}),
      /invalid sanitized/);
    await assert.rejects(appendR50Evidence(f.opts,{...proof,elapsedMs:-1}),
      /invalid sanitized/);
    assert.equal((await readR50Evidence(f.opts)).recordCount,0);
  }finally{await f.close();}
});
test('R5.0 altered signed journal record is detected before any further append',async()=>{
  const f=await fixture();try{
    await appendR50Evidence(f.opts,proof);
    const path=join(f.opts.directory,'events.jsonl'),original=await readFile(path,'utf8');
    await writeFile(path,original.replace('"elapsedMs":1234','"elapsedMs":1235'));
    await assert.rejects(readR50Evidence(f.opts),/ledger HMAC changed/);
    await assert.rejects(appendR50Evidence(f.opts,proof),/ledger HMAC changed/);
  }finally{await f.close();}
});
test('R5.0 corrupted partial append and wrong independent key fail closed',async()=>{
  const f=await fixture();try{
    await appendR50Evidence(f.opts,proof);
    await assert.rejects(readR50Evidence({...f.opts,key:randomBytes(32)}),
      /ledger HMAC changed/);
    const path=join(f.opts.directory,'events.jsonl');
    await writeFile(path,(await readFile(path,'utf8')).trimEnd());
    await assert.rejects(readR50Evidence(f.opts),/torn or oversized/);
  }finally{await f.close();}
});
test('R5.0 stale writer lock and symlink evidence file are rejected',async()=>{
  const f=await fixture();try{
    await appendR50Evidence(f.opts,proof);
    const path=join(f.opts.directory,'events.jsonl'),other=join(f.root,'other.jsonl');
    const bytes=await readFile(path);
    await rm(path);await writeFile(other,bytes);await symlink(other,path);
    await assert.rejects(readR50Evidence(f.opts),/ELOOP|unsafe ledger/);
    await rm(path);await writeFile(path,bytes,{mode:0o600});
    await writeFile(join(f.opts.directory,'.ledger.lock'),'stale',{mode:0o600});
    await assert.rejects(appendR50Evidence(f.opts,proof),/EEXIST/);
  }finally{await f.close();}
});
function reviews(){
  const signed={format:'osmanx-r50-staging-review-v1',tenantToken:token,
    catalogSha256:hash,evidenceHeadSha256:'c'.repeat(64),
    testedCodeSha256:'d'.repeat(64),issuedAt:Date.now()-1000,
    expiresAt:Date.now()+86400000,purpose:'EXTERNAL_SYNTHETIC_DR_REHEARSAL'};
  const trustedPublicKeys={},secrets={},approvals=[];
  const message=canonicalR50ApprovalMessage(signed);
  for(const role of ['security','operations','dataOwner']){
    const {publicKey,privateKey}=generateKeyPairSync('ed25519');
    trustedPublicKeys[role]=publicKey;secrets[role]=privateKey;
    approvals.push({role,signature:sign(null,message,privateKey).toString('base64')});
  }
  return {signed,trustedPublicKeys,secrets,approvals};
}
test('R5.0 three distinct detached Ed25519 reviews bind exact code, evidence and catalog',()=>{
  const {signed,trustedPublicKeys,approvals}=reviews();
  const r=verifyR50IndependentReviews({challenge:signed,trustedPublicKeys,approvals});
  assert.deepEqual(r.rolesVerified,['security','operations','dataOwner']);
  assert.equal(new Set(r.trustedUniqueKeyFingerprints).size,3);
  assert.equal(r.approvedForSyntheticExternalDrill,true);
  assert.equal(r.productionCutoverAllowed,false);
  assert.equal(r.externalInfrastructureVerified,false);
});
test('R5.0 wrong code, stale challenge, duplicate role and same key reviews are rejected',()=>{
  const {signed,trustedPublicKeys,approvals}=reviews();
  assert.throws(()=>verifyR50IndependentReviews({
    challenge:{...signed,testedCodeSha256:'e'.repeat(64)},trustedPublicKeys,approvals}),
  /signature does not match/);
  assert.throws(()=>verifyR50IndependentReviews({
    challenge:signed,trustedPublicKeys,approvals,now:signed.expiresAt+1}),
  /expired/);
  assert.throws(()=>verifyR50IndependentReviews({
    challenge:signed,trustedPublicKeys,approvals:[
      approvals[0],{...approvals[1],role:'security'},approvals[2]]}),
  /distinct/);
  assert.throws(()=>verifyR50IndependentReviews({
    challenge:signed,trustedPublicKeys:{
      ...trustedPublicKeys,operations:trustedPublicKeys.security},approvals}),
  /one signing key cannot satisfy two/);
});
