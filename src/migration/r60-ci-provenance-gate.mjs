// R6.0: separate signer-approved CI source binding for R5.9 evidence.
// No deployment, no merge, no automated unquarantine. The caller must
// supply an authenticated GitHub run/job provider, not untrusted JSON.
import {createHash,sign,verify,createPublicKey} from 'node:crypto';
import {evaluateR59ReleaseGate} from './r59-release-gate.mjs';
const TENANT=/^[a-f0-9]{24}$/,COMMIT=/^[a-f0-9]{40}$/,
  NONCE=/^[a-f0-9]{32}$/,ISSUER=/^[a-z0-9._-]{6,64}$/,
  CATEGORY=new Set(['postgres-failover','s3-iam-role-denial',
    'tls-cert-rotation','operator-audit-chain','independent-witness']),
  FORMAT='osmanx-r60-ci-source-attestation-v1';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function deny(ok,why){if(!ok)throw Error('R6.0 CI provenance refused: '+why);}
function canon(o){
  deny(o&&CATEGORY.has(o.category)&&TENANT.test(o.tenantId||'')&&
    ISSUER.test(o.issuer||'')&&COMMIT.test(o.commitSha||'')&&
    Number.isSafeInteger(o.runId)&&o.runId>0&&
    Number.isSafeInteger(o.jobId)&&o.jobId>0&&
    /^[a-f0-9]{64}$/.test(o.reportSha256||'')&&
    NONCE.test(o.nonce||'')&&
    Number.isSafeInteger(o.issuedAt)&&Number.isSafeInteger(o.expiresAt)&&
    o.expiresAt>o.issuedAt&&o.expiresAt-o.issuedAt<=3600000,
    'invalid trusted CI attestation schema');
  return {format:FORMAT,category:o.category,tenantId:o.tenantId,
    issuer:o.issuer,commitSha:o.commitSha,runId:o.runId,jobId:o.jobId,
    reportSha256:o.reportSha256,nonce:o.nonce,
    issuedAt:o.issuedAt,expiresAt:o.expiresAt};
}
export function signR60CiSourceAttestation({payload,privateKey}={}){
  deny(privateKey,'offline reporter private key required');
  const fields=canon(payload);
  return {...fields,signature:sign(null,Buffer.from(JSON.stringify(fields)),
    privateKey).toString('base64')};
}
function checkProof({proof,report,trust,tenantId,commitSha,now}){
  deny(proof&&typeof proof==='object'&&
    Object.keys(proof).length===12&&proof.format===FORMAT&&
    proof.tenantId===tenantId&&proof.commitSha===commitSha&&
    trust?.publicKey&&trust.issuer===proof.issuer&&
    trust.category===proof.category&&
    typeof proof.signature==='string'&&
    /^[A-Za-z0-9+/]+={0,2}$/.test(proof.signature)&&
    Buffer.from(proof.signature,'base64').toString('base64')===
      proof.signature&&Buffer.from(proof.signature,'base64').length===64,
    'unrecognized or noncanonical source proof');
  const fields=canon(proof);
  deny(fields.issuedAt<=now&&now<fields.expiresAt,
    'expired or future reporter proof');
  deny(fields.reportSha256===sha(Buffer.from(JSON.stringify(report))),
    'source proof not bound to the exact signed report');
  let verified=false;
  try{verified=verify(null,Buffer.from(JSON.stringify(fields)),
    trust.publicKey,Buffer.from(proof.signature,'base64'));}
  catch{verified=false;}
  deny(verified,'source proof not signed by a trusted reporter');
  const key=trust.publicKey.type==='public'?
    trust.publicKey:createPublicKey(trust.publicKey);
  const fingerprint=sha(key.export({type:'spki',format:'der'}));
  return {...fields,reviewerKeySha256:fingerprint};
}
export async function evaluateR60CiProvenanceGate({
  repository,commitSha,tenantId,bundles,jobProvider,reviewers,
  requiredJobs,now=()=>Date.now()
}={}){
  deny(/^[a-zA-Z0-9_.-]{2,80}\/[a-zA-Z0-9_.-]{2,100}$/.test(
    repository||'')&&COMMIT.test(commitSha||'')&&
    TENANT.test(tenantId||'')&&
    Array.isArray(bundles)&&bundles.length<=10&&
    jobProvider?.getRun&&jobProvider?.getJobs&&
    reviewers&&requiredJobs&&typeof now==='function',
    'trusted GitHub source adapter, fixed SHA, tenant and policies required');
  const records=[],errors=[],runCache=new Map(),jobsSeen=new Set(),
    signerSeen=new Set();
  for(const item of bundles){
    try{
      const proof=item?.proof,report=item?.report;
      const trust=reviewers[proof?.issuer],required=requiredJobs[proof?.category];
      deny(required&&typeof required.workflowName==='string'&&
        typeof required.jobName==='string'&&
        required.workflowName.length<=100&&required.jobName.length<=150,
        'risk category lacks pinned source job');
      const verified=checkProof({
        proof,report,trust,tenantId,commitSha,now:now()
      });
      deny(!signerSeen.has(verified.reviewerKeySha256),
        'reviewer public key reused across risk categories');
      const locator=String(proof.runId)+':'+String(proof.jobId);
      deny(!jobsSeen.has(locator),'same job reused for multiple attestation categories');
      let info=runCache.get(proof.runId);
      if(!info){
        const [run,jobs]=await Promise.all([
          jobProvider.getRun(repository,proof.runId),
          jobProvider.getJobs(repository,proof.runId)
        ]);
        deny(run&&run.id===proof.runId&&run.repository===repository&&
          run.head_sha===commitSha&&run.status==='completed'&&
          run.conclusion==='success'&&Array.isArray(jobs),
          'GitHub workflow not completed successfully on pinned SHA');
        info={run,jobs};runCache.set(proof.runId,info);
      }
      deny(info.run.workflow_name===required.workflowName,
        'unexpected GitHub workflow identity for risk category');
      const job=info.jobs.find(j=>j.id===proof.jobId);
      deny(job&&job.name===required.jobName&&
        job.status==='completed'&&job.conclusion==='success'&&
        job.run_id===proof.runId,
        'required GitHub CI job skipped, failed or substituted');
      signerSeen.add(verified.reviewerKeySha256);
      jobsSeen.add(locator);
      records.push(report);
    }catch(e){errors.push(String(e.message).slice(0,200));}
  }
  const baseline=evaluateR59ReleaseGate({
    tenantId,evidence:records,trustedReporters:reviewers,now
  });
  const eligible=baseline.syntheticLabGatePassed===true&&
    errors.length===0&&signerSeen.size===5&&jobsSeen.size===5;
  return Object.freeze({
    format:'osmanx-r60-ci-provenance-gate-v1',repository,commitSha,
    tenantId,verifiedSourceJobs:jobsSeen.size,
    independentReviewerKeys:signerSeen.size,errors,
    baselineLabGatePassed:baseline.syntheticLabGatePassed,
    pinnedCiLabGatePassed:eligible,
    missingCategories:baseline.missingCategories,
    allExternalProviderChecksRequired:true,
    productionCutoverAllowed:false,deployAllowed:false,
    mainMergeAllowed:false,automatedUnquarantineAllowed:false,
    independentHumanReviewRequired:true
  });
}
