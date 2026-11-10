import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,generateKeyPairSync}
  from 'node:crypto';
import {signR65DualWalBundle,verifyR65DualWalBundle}
  from '../src/migration/r65-dual-wal-bundle.mjs';
import {signR61Approval}
  from '../src/migration/r61-dual-approval.mjs';
import {assessR65HumanOnlyRecovery}
  from '../src/migration/r65-disaster-readiness-gate.mjs';
const T='a'.repeat(24),I='b'.repeat(32),
  SYS='7392526296213040844',TIME=Date.now(),LSN='0/4000';
function fixture(){
  const raw=Buffer.alloc(16*1024*1024,0x45),
    hash=createHash('sha256').update(raw).digest('hex'),
    walKey=generateKeyPairSync('ed25519'),
    file='000000010000000000000000',
    inventory=[{name:file,sha256:hash,size:raw.length}],
    receipts=['first-process','second-process'].map((storeId,i)=>({
      format:'osmanx-r65-wal-object-receipt-v1',tenantId:T,
      storeId,name:file,sha256:hash,size:raw.length,
      versionId:'version-'+i,etag:'"abc123fa"',
      retentionMode:'COMPLIANCE',retainedUntil:'2090-01-01T00:00:00.000Z'
    }));
  const manifest=signR65DualWalBundle({
    privateKey:walKey.privateKey,payload:{
      format:'osmanx-r65-dual-worm-bundle-v1',scope:'disposable-lab',
      tenantId:T,incidentId:I,systemId:SYS,timeline:1,
      targetLsn:LSN,baseBackupSha256:'c'.repeat(64),
      inventory,receipts,nonce:randomBytes(16).toString('hex'),
      issuedAt:TIME-1000,expiresAt:TIME+300000
    }
  });
  const reviewed=verifyR65DualWalBundle({
    manifest,publicKey:walKey.publicKey,tenantId:T,now:()=>TIME
  });
  const first=generateKeyPairSync('ed25519'),
    second=generateKeyPairSync('ed25519');
  const reviewers={
    human_security:{role:'security',publicKey:first.publicKey},
    human_reliability:{role:'reliability',publicKey:second.publicKey}
  };
  const humanApprovals=[
    ['security','human_security',first],
    ['reliability','human_reliability',second]
  ].map(([role,reviewerId,kp])=>signR61Approval({
    privateKey:kp.privateKey,payload:{
      tenantId:T,incidentId:I,epoch:12,
      evidenceSha256:reviewed.evidenceSha256,
      s3Version:null,action:'investigate',role,reviewerId,
      nonce:randomBytes(16).toString('hex'),
      issuedAt:TIME-1000,expiresAt:TIME+60000
    }
  }));
  const acknowledged=Array.from({length:20},(_,i)=>({
    seq:i+1,
    sha256:(i+1).toString(16).padStart(64,'0'),
    committedLsn:'0/'+(0x1000+i*0x400).toString(16).toUpperCase(),
    acknowledgedAtMs:TIME-1000+i*20
  }));
  // Sequence 12 is the selected WAL target.
  manifest.targetLsn; // expose immutable signed target from fixture
  const targetAfter12=acknowledged[11].committedLsn;
  const archivePublicKey=walKey.publicKey;
  // For this unit fixture, rebuild a properly signed bundle with the
  // exact selected acknowledged LSN, not merely a successful mock flag.
  const corrected=signR65DualWalBundle({
    privateKey:walKey.privateKey,payload:{
      ...manifest,targetLsn:targetAfter12
    }
  });
  const correctedReview=verifyR65DualWalBundle({
    manifest:corrected,publicKey:walKey.publicKey,tenantId:T,now:()=>TIME
  });
  const correctedApprovals=[
    ['security','human_security',first],
    ['reliability','human_reliability',second]
  ].map(([role,reviewerId,kp])=>signR61Approval({
    privateKey:kp.privateKey,payload:{
      tenantId:T,incidentId:I,epoch:12,
      evidenceSha256:correctedReview.evidenceSha256,
      s3Version:null,action:'investigate',role,reviewerId,
      nonce:randomBytes(16).toString('hex'),
      issuedAt:TIME-1000,expiresAt:TIME+60000
    }
  }));
  return {tenantId:T,incidentId:I,epoch:12,
    manifest:corrected,archivePublicKey,
    custody:{tenantId:T,storageProcessCount:2,
      async downloadVerified({inventory,receipts}){
        assert.equal(inventory.length,1);assert.equal(receipts.length,2);
        return [{name:file,body:Buffer.from(raw)}];
      }},
    acknowledged,
    restoredRows:acknowledged.slice(0,12).map(x=>({
      seq:x.seq,sha256:x.sha256
    })),
    failureAtMs:TIME,recoveryAtMs:TIME+1000,
    sourceProcessDestroyed:true,
    humanApprovals:correctedApprovals,reviewers,
    now:()=>TIME
  };
}
test('R6.5 valid detached WAL and 20 source ACKs only authorize human inspection',async()=>{
  const evidence=await assessR65HumanOnlyRecovery(fixture());
  assert.equal(evidence.syntheticLabEvidenceReadyForHumanReview,true);
  assert.equal(evidence.dualS3WormObjectCopiesReread,true);
  assert.equal(evidence.missingSyntheticAcknowledgements,8);
  assert.equal(evidence.independentSignedHumanReviewers,2);
  assert.equal(evidence.mayWriteS3,false);
  assert.equal(evidence.mayPromote,false);
  assert.equal(evidence.mayDeploy,false);
  assert.equal(evidence.productionCutoverAllowed,false);
  assert.equal(evidence.endToEndSourceSqliteRpoCertified,false);
});
test('R6.5 missing/forged remote WAL or tampered human signature fails closed',
  async()=>{
    const f=fixture();
    await assert.rejects(assessR65HumanOnlyRecovery({
      ...f,custody:{...f.custody,
        async downloadVerified(){return [];}}
    }),/did not return complete WAL/);
    const corrupt=fixture();
    await assert.rejects(assessR65HumanOnlyRecovery({
      ...corrupt,custody:{...corrupt.custody,
        async downloadVerified(){
          return [{name:corrupt.manifest.inventory[0].name,
            body:Buffer.alloc(16*1024*1024,0x99)}];
        }}
    }),/remote archive bytes are corrupted/);
    const approvals=fixture();
    const forged=approvals.humanApprovals.map(x=>({...x}));
    forged[0].signature=forged[1].signature;
    await assert.rejects(assessR65HumanOnlyRecovery({
      ...approvals,humanApprovals:forged
    }),/invalid offline Ed25519 signature/);
  });
test('R6.5 no destroyed source or wrong tenant and incident cannot pass',async()=>{
  const f=fixture();
  await assert.rejects(assessR65HumanOnlyRecovery({
    ...f,sourceProcessDestroyed:false
  }),/source loss and dual humans/);
  await assert.rejects(assessR65HumanOnlyRecovery({
    ...f,tenantId:'f'.repeat(24)
  }),/two live S3 stores/);
  await assert.rejects(assessR65HumanOnlyRecovery({
    ...f,incidentId:'d'.repeat(32)
  }),/different recovery incident/);
});
