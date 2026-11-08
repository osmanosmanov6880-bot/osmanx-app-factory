import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {signR59ReleaseEvidence,evaluateR59ReleaseGate,
  verifyR59ReleaseEvidence} from '../src/migration/r59-release-gate.mjs';

const TENANT='d'.repeat(24),CATEGORIES=[
  ['postgres-failover',['actualPrimaryKilled','standbyPromoted',
    'persistedIntentRecovered','staleEpochRejected']],
  ['s3-iam-role-denial',['workerHeadPut403','coordinatorSegmentPut403',
    'validSegmentWorm','validPointerWorm']],
  ['tls-cert-rotation',['offlineSignatureVerified','retiredPinRejected',
    'monotonicGenerationVerified','newPinAccepted']],
  ['operator-audit-chain',['concurrentChainValid','updateDenied',
    'deleteDenied','tamperDetected']],
  ['independent-witness',['witnessSignatureVerified',
    'checkpointSequenceMatched','s3WormVersionVerified','noUnwitnessedAdvance']]
];
function fixture(){
  const now=Date.now(),trustedReporters={};
  const records=CATEGORIES.map(([category,fields],index)=>{
    const kp=generateKeyPairSync('ed25519');
    const issuer='reviewer_'+(index+1);
    trustedReporters[issuer]={issuer,category,publicKey:kp.publicKey};
    const payload={category,tenantId:TENANT,issuer,
      nonce:randomBytes(16).toString('hex'),issuedAt:now-1000,
      expiresAt:now+100000,
      observations:Object.fromEntries(fields.map(f=>[f,true]))};
    return {category,issuer,kp,payload,
      packet:signR59ReleaseEvidence({payload,privateKey:kp.privateKey})};
  });
  const evidence=records.map(x=>x.packet);
  return {now,evidence,trustedReporters,records,
    run(reports=evidence,trust=trustedReporters,at=now){
      return evaluateR59ReleaseGate({
        tenantId:TENANT,evidence:reports,trustedReporters:trust,
        now:()=>at
      });
    }
  };
}
test('R5.9 five distinct Ed25519 reporters pass lab gate, never production cutover',()=>{
  const f=fixture(),result=f.run();
  assert.equal(result.syntheticLabGatePassed,true);
  assert.equal(result.independentReporterKeysVerified,5);
  assert.equal(result.missingCategories.length,0);
  assert.equal(result.productionCutoverAllowed,false);
  assert.equal(result.deployAllowed,false);
  assert.equal(result.mainMergeAllowed,false);
  assert.equal(result.industrialRpoCertified,false);
  assert.equal(result.independentHumanReviewRequired,true);
});
test('R5.9 missing real S3 IAM evidence cannot pass release gate',()=>{
  const f=fixture();
  const withoutIAM=f.evidence.filter(x=>x.category!=='s3-iam-role-denial');
  const result=f.run(withoutIAM);
  assert.equal(result.syntheticLabGatePassed,false);
  assert.deepEqual(result.missingCategories,['s3-iam-role-denial']);
  assert.equal(result.productionCutoverAllowed,false);
});
test('R5.9 rejects reused signer key for different risk categories',()=>{
  const f=fixture();
  const bad=[...f.evidence];
  const target=f.records[1],source=f.records[0];
  const replacement=signR59ReleaseEvidence({
    payload:{...target.payload},privateKey:source.kp.privateKey
  });
  bad[1]=replacement;
  f.trustedReporters[target.issuer].publicKey=source.kp.publicKey;
  const result=f.run(bad);
  assert.equal(result.syntheticLabGatePassed,false);
  assert(result.errors.some(x=>x.includes('same Ed25519 key')));
});
test('R5.9 rejects tampered evidence, changed tenant and expired signed witness',()=>{
  const f=fixture();
  const tampered=f.evidence.map(x=>({...x}));
  tampered[0]={...tampered[0],nonce:'1'.repeat(32)};
  const first=f.run(tampered);
  assert.equal(first.syntheticLabGatePassed,false);
  assert(first.errors.some(x=>x.includes('untrusted or tampered')));
  const foreign=f.evidence.map(x=>({...x}));
  foreign[1].tenantId='a'.repeat(24);
  assert.equal(f.run(foreign).syntheticLabGatePassed,false);
  const expired=f.run(f.evidence,f.trustedReporters,f.now+200000);
  assert.equal(expired.syntheticLabGatePassed,false);
  assert(expired.errors.some(x=>x.includes('stale or future evidence')));
});
test('R5.9 cannot sign incomplete or false evidence facts',()=>{
  const f=fixture();
  const item=f.records[0];
  const bad={...item.payload,
    observations:{...item.payload.observations,standbyPromoted:false}};
  assert.throws(()=>signR59ReleaseEvidence({
    payload:bad,privateKey:item.kp.privateKey
  }),/required evidence facts/);
  const extra={...item.payload,
    observations:{...item.payload.observations,alwaysAllowProduction:true}};
  assert.throws(()=>signR59ReleaseEvidence({
    payload:extra,privateKey:item.kp.privateKey
  }),/required evidence facts/);
});
test('R5.9 duplicate report identity cannot substitute another independent category',()=>{
  const f=fixture();
  const withDuplicate=[...f.evidence,f.evidence[0]];
  const result=f.run(withDuplicate);
  assert.equal(result.syntheticLabGatePassed,false);
  assert(result.errors.some(x=>x.includes('duplicate category report')));
  const single=verifyR59ReleaseEvidence({
    packet:f.evidence[0],tenantId:TENANT,trust:f.trustedReporters[f.evidence[0].issuer],
    now:()=>f.now
  });
  assert.equal(single.signatureVerified,true);
});
