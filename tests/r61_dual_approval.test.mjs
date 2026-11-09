import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {signR61Approval,verifyR61DualApprovals}
  from '../src/migration/r61-dual-approval.mjs';
const TENANT='c'.repeat(24),INCIDENT='d'.repeat(32),SHA='e'.repeat(64),
  EPOCH=13,VERSION='r61-locked-v13',ACTION='investigate';
function fixture(){
  const now=Date.now(),security=generateKeyPairSync('ed25519'),
    reliability=generateKeyPairSync('ed25519'),reviewers={
      reviewer_security:{role:'security',publicKey:security.publicKey},
      reviewer_reliability:{role:'reliability',publicKey:reliability.publicKey}
    };
  function payload(role,reviewerId){
    return {tenantId:TENANT,incidentId:INCIDENT,evidenceSha256:SHA,
      epoch:EPOCH,s3Version:VERSION,role,reviewerId,action:ACTION,
      nonce:randomBytes(16).toString('hex'),issuedAt:now-1000,
      expiresAt:now+60000};
  }
  const approvals=[
    signR61Approval({payload:payload('security','reviewer_security'),
      privateKey:security.privateKey}),
    signR61Approval({payload:payload('reliability','reviewer_reliability'),
      privateKey:reliability.privateKey})
  ];
  const validate=(o={})=>verifyR61DualApprovals({
    tenantId:TENANT,incidentId:INCIDENT,evidenceSha256:SHA,epoch:EPOCH,
    s3Version:VERSION,action:ACTION,approvals,reviewers,now:()=>now,...o
  });
  return {now,security,reliability,reviewers,approvals,validate,payload};
}
test('R6.1 accepts two distinct security/reliability signers only for read-only investigation',()=>{
  const f=fixture(),verified=f.validate();
  assert.equal(verified.reviewersVerified,2);
  assert.equal(verified.distinctPublicKeys,2);
  assert.match(verified.approvalsSha256,/^[a-f0-9]{64}$/);
  assert.equal(verified.readonlyAuthorizationVerified,true);
  assert.equal(verified.mayClearPendingIntent,false);
  assert.equal(verified.mayAlterS3,false);
  assert.equal(verified.productionCutoverAllowed,false);
});
test('R6.1 denies forged evidence hash, incident epoch, foreign tenant and S3 version',()=>{
  const f=fixture();
  for(const change of [{tenantId:'a'.repeat(24)},
    {incidentId:'f'.repeat(32)},{evidenceSha256:'1'.repeat(64)},
    {epoch:14},{s3Version:'other_version'},{action:'export-evidence'}]){
    assert.throws(()=>f.validate(change),/approval not bound/);
  }
});
test('R6.1 expired, future and revoked reviewer certificates are rejected',()=>{
  const f=fixture();
  assert.throws(()=>f.validate({now:()=>f.now+120000}),/expired/);
  assert.throws(()=>f.validate({now:()=>f.now-30000}),/expired/);
  const revoked={...f.reviewers,
    reviewer_security:{...f.reviewers.reviewer_security,revoked:true}};
  assert.throws(()=>f.validate({reviewers:revoked}),/revoked/);
});
test('R6.1 forbids using the same human, public key or role twice',()=>{
  const f=fixture(),doubled=[f.approvals[0],f.approvals[0]];
  assert.throws(()=>f.validate({approvals:doubled}),/independent reviewers/);
  const wrong={...f.reviewers,
    reviewer_reliability:{role:'reliability',publicKey:f.security.publicKey}};
  assert.throws(()=>f.validate({reviewers:wrong}),/invalid offline Ed25519/);
  const fakeRole={...f.reviewers,
    reviewer_security:{role:'reliability',publicKey:f.security.publicKey}};
  assert.throws(()=>f.validate({reviewers:fakeRole}),/role mismatch/);
});
test('R6.1 cannot forge signed timestamp or propose a mutable recovery action',()=>{
  const f=fixture(),forged=f.approvals.map(x=>({...x}));
  forged[0].expiresAt+=15000;
  assert.throws(()=>f.validate({approvals:forged}),/invalid offline Ed25519/);
  assert.throws(()=>signR61Approval({
    payload:{...f.payload('security','reviewer_security'),
      action:'clear-pending-op'},privateKey:f.security.privateKey
  }),/invalid tenant|action/);
});
test('R6.1 missing signature and extra signed fields fail closed',()=>{
  const f=fixture();
  const noSig=f.approvals.map(x=>({...x}));
  delete noSig[1].signature;
  assert.throws(()=>f.validate({approvals:noSig}),/noncanonical/);
  const extra=f.approvals.map(x=>({...x}));
  extra[0].forceProduction=true;
  assert.throws(()=>f.validate({approvals:extra}),/noncanonical/);
});
