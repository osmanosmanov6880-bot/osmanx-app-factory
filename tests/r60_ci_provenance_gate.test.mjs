import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,createHash} from 'node:crypto';
import {signR59ReleaseEvidence} from '../src/migration/r59-release-gate.mjs';
import {signR60CiSourceAttestation,evaluateR60CiProvenanceGate}
  from '../src/migration/r60-ci-provenance-gate.mjs';
const TENANT='c'.repeat(24),COMMIT='a'.repeat(40),
  REPO='osmanosmanov6880-bot/osmanx-app-factory',
  CATS=[
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
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function fixture(){
  const at=Date.now(),reviewers={},bundles=[],requiredJobs={},
    remoteRuns=new Map(),remoteJobs=new Map();
  for(let i=0;i<CATS.length;i++){
    const [category,fields]=CATS[i],kp=generateKeyPairSync('ed25519');
    const issuer='auditor_'+(i+1),runId=10000+i,jobId=20000+i,
      workflowName='R60 independent synthetic '+category,
      jobName='Signed risk '+category;
    reviewers[issuer]={issuer,category,publicKey:kp.publicKey};
    requiredJobs[category]={workflowName,jobName};
    const report=signR59ReleaseEvidence({
      privateKey:kp.privateKey,payload:{
        category,tenantId:TENANT,issuer,
        nonce:randomBytes(16).toString('hex'),issuedAt:at-1000,
        expiresAt:at+100000,
        observations:Object.fromEntries(fields.map(f=>[f,true]))
      }
    });
    const proof=signR60CiSourceAttestation({
      privateKey:kp.privateKey,payload:{
        category,tenantId:TENANT,issuer,commitSha:COMMIT,runId,jobId,
        reportSha256:sha(report),nonce:randomBytes(16).toString('hex'),
        issuedAt:at-1000,expiresAt:at+100000
      }
    });
    bundles.push({report,proof});
    remoteRuns.set(runId,{
      id:runId,repository:REPO,head_sha:COMMIT,
      workflow_name:workflowName,status:'completed',conclusion:'success'
    });
    remoteJobs.set(runId,[{
      id:jobId,run_id:runId,name:jobName,status:'completed',
      conclusion:'success'
    }]);
  }
  const jobProvider={
    async getRun(repo,id){
      assert.equal(repo,REPO);return remoteRuns.get(id);
    },
    async getJobs(repo,id){
      assert.equal(repo,REPO);return remoteJobs.get(id);
    }
  };
  const run=async ({receipts=bundles,provider=jobProvider,time=at}={})=>
    evaluateR60CiProvenanceGate({
      repository:REPO,commitSha:COMMIT,tenantId:TENANT,
      bundles:receipts,reviewers,requiredJobs,
      jobProvider:provider,now:()=>time
    });
  return {bundles,reviewers,requiredJobs,remoteRuns,remoteJobs,run,at,jobProvider};
}
test('R6.0 five independent signed CI receipts bind exactly pinned commit, job and reviewer',
  async()=>{
    const f=fixture(),report=await f.run();
    assert.equal(report.pinnedCiLabGatePassed,true);
    assert.equal(report.verifiedSourceJobs,5);
    assert.equal(report.independentReviewerKeys,5);
    assert.equal(report.productionCutoverAllowed,false);
    assert.equal(report.deployAllowed,false);
    assert.equal(report.automatedUnquarantineAllowed,false);
    assert.equal(report.independentHumanReviewRequired,true);
  });
test('R6.0 fails closed if GitHub run is failed, skipped or on a different commit',
  async()=>{
    for(const change of [
      {conclusion:'failure'},{conclusion:'skipped'},
      {status:'in_progress'},{head_sha:'b'.repeat(40)}
    ]){
      const f=fixture(),runId=f.bundles[2].proof.runId;
      f.remoteRuns.set(runId,{...f.remoteRuns.get(runId),...change});
      const result=await f.run();
      assert.equal(result.pinnedCiLabGatePassed,false);
      assert(result.errors.some(e=>e.includes('workflow not completed')));
    }
  });
test('R6.0 rejects skipped CI job, unpinned workflow and fake run identity',
  async()=>{
    for(const change of [{conclusion:'skipped'},{status:'queued'},
      {name:'forged job'}]){
      const f=fixture(),runId=f.bundles[0].proof.runId;
      f.remoteJobs.get(runId)[0]={...f.remoteJobs.get(runId)[0],...change};
      assert.equal((await f.run()).pinnedCiLabGatePassed,false);
    }
    const f=fixture(),runId=f.bundles[0].proof.runId;
    f.remoteRuns.get(runId).workflow_name='unknown workflow';
    assert.equal((await f.run()).pinnedCiLabGatePassed,false);
  });
test('R6.0 swapped report or forged digest invalidates signed source binding',
  async()=>{
    const f=fixture(),bad=f.bundles.map(x=>({...x}));
    bad[0].report=f.bundles[1].report;
    const result=await f.run({receipts:bad});
    assert.equal(result.pinnedCiLabGatePassed,false);
    assert(result.errors.some(x=>x.includes('exact signed report')));
  });
test('R6.0 missing independent job, reused proof, expired evidence block gate',
  async()=>{
    const f=fixture(),short=f.bundles.slice(0,-1);
    assert.equal((await f.run({receipts:short})).pinnedCiLabGatePassed,false);
    const duplicate=[...f.bundles,f.bundles[0]];
    assert.equal((await f.run({receipts:duplicate})).pinnedCiLabGatePassed,false);
    const expired=await f.run({time:f.at+150000});
    assert.equal(expired.pinnedCiLabGatePassed,false);
    assert(expired.errors.some(x=>x.includes('expired')));
  });
test('R6.0 cannot pass without authenticated external job provider',async()=>{
  const f=fixture();
  await assert.rejects(evaluateR60CiProvenanceGate({
    repository:REPO,commitSha:COMMIT,tenantId:TENANT,
    bundles:f.bundles,reviewers:f.reviewers,requiredJobs:f.requiredJobs
  }),/trusted GitHub source adapter/);
});
