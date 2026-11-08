// R5.9 fail-closed *synthetic lab* release evaluator.
// Signature checks bind reporter, tenant, event and short validity. A passed
// lab gate NEVER authorizes production cutover or merges main.
import {sign,verify,createHash,createPublicKey} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,NONCE=/^[a-f0-9]{32}$/,
  FORMAT='osmanx-r59-release-evidence-v1';
const CATEGORIES=Object.freeze([
  'postgres-failover','s3-iam-role-denial','tls-cert-rotation',
  'operator-audit-chain','independent-witness'
]);
const REQUIRE={
  'postgres-failover':['actualPrimaryKilled','standbyPromoted',
    'persistedIntentRecovered','staleEpochRejected'],
  's3-iam-role-denial':['workerHeadPut403','coordinatorSegmentPut403',
    'validSegmentWorm','validPointerWorm'],
  'tls-cert-rotation':['offlineSignatureVerified','retiredPinRejected',
    'monotonicGenerationVerified','newPinAccepted'],
  'operator-audit-chain':['concurrentChainValid','updateDenied',
    'deleteDenied','tamperDetected'],
  'independent-witness':['witnessSignatureVerified',
    'checkpointSequenceMatched','s3WormVersionVerified','noUnwitnessedAdvance']
};
function deny(ok,reason){if(!ok)throw Error('R5.9 release gate refused: '+reason);}
function exact(obj,keys){return obj&&typeof obj==='object'&&!Array.isArray(obj)&&
  Object.keys(obj).length===keys.length&&keys.every(k=>Object.hasOwn(obj,k));}
function facts(category,value){
  const required=REQUIRE[category];
  deny(required&&exact(value,required)&&required.every(k=>value[k]===true),
    'required evidence facts are missing or untrue for '+category);
  return Object.fromEntries(required.map(k=>[k,true]));
}
function body(data){
  deny(data&&CATEGORIES.includes(data.category)&&TENANT.test(data.tenantId||'')&&
    typeof data.issuer==='string'&&/^[a-z0-9][a-z0-9._-]{5,63}$/.test(data.issuer)&&
    NONCE.test(data.nonce||'')&&
    Number.isSafeInteger(data.issuedAt)&&
    Number.isSafeInteger(data.expiresAt)&&
    data.expiresAt>data.issuedAt&&data.expiresAt-data.issuedAt<=3600000,
    'invalid evidence identity, issuer, timestamp or nonce');
  return {format:FORMAT,category:data.category,tenantId:data.tenantId,
    issuer:data.issuer,nonce:data.nonce,issuedAt:data.issuedAt,
    expiresAt:data.expiresAt,observations:facts(data.category,data.observations)};
}
function canonical(packet){
  const normalized=body(packet);
  deny(exact(packet,[...Object.keys(normalized),'signature'])&&
    packet.format===FORMAT,'noncanonical signed evidence fields');
  return normalized;
}
export function signR59ReleaseEvidence({payload,privateKey}={}){
  deny(privateKey,'offline evidence reporter key required');
  const b=body(payload);
  return {...b,signature:sign(null,Buffer.from(JSON.stringify(b)),privateKey)
    .toString('base64')};
}
export function verifyR59ReleaseEvidence({
  packet,tenantId,trust,now=()=>Date.now()
}={}){
  deny(packet&&packet.tenantId===tenantId&&TENANT.test(tenantId||'')&&
    trust?.publicKey&&trust?.category===packet.category&&
    trust?.issuer===packet.issuer,
    'wrong tenant or untrusted reporter role');
  const b=canonical(packet);
  const t=now();
  deny(Number.isSafeInteger(t)&&b.issuedAt<=t&&t<b.expiresAt,
    'stale or future evidence');
  const sig=packet.signature;
  deny(typeof sig==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(sig)&&
    Buffer.from(sig,'base64').toString('base64')===sig&&
    Buffer.from(sig,'base64').length===64,
    'noncanonical reporter signature');
  let valid=false;
  try{valid=verify(null,Buffer.from(JSON.stringify(b)),trust.publicKey,
    Buffer.from(sig,'base64'));}catch{valid=false;}
  deny(valid,'untrusted or tampered reporter signature');
  const publicDer=createPublicKey(trust.publicKey).export({
    type:'spki',format:'der'
  });
  return {...b,reporterKeySha256:createHash('sha256').update(publicDer).digest('hex'),
    signatureVerified:true};
}
export function evaluateR59ReleaseGate({
  tenantId,evidence=[],trustedReporters={},now=()=>Date.now()
}={}){
  deny(TENANT.test(tenantId||'')&&Array.isArray(evidence)&&
    evidence.length<=20&&trustedReporters&&typeof trustedReporters==='object',
    'invalid release request');
  const received=new Map(),errors=[],keys=new Set(),issuers=new Set();
  for(const item of evidence){
    try{
      const trust=trustedReporters[item?.issuer];
      const verified=verifyR59ReleaseEvidence({
        packet:item,tenantId,trust,now
      });
      deny(!received.has(verified.category),'duplicate category report');
      deny(!keys.has(verified.reporterKeySha256),
        'same Ed25519 key reused for independent evidence');
      deny(!issuers.has(verified.issuer),'reporter identity reused');
      received.set(verified.category,verified);
      keys.add(verified.reporterKeySha256);issuers.add(verified.issuer);
    }catch(error){
      errors.push(String(error.message).slice(0,180));
    }
  }
  const missing=CATEGORIES.filter(x=>!received.has(x));
  const ready=missing.length===0&&errors.length===0&&
    received.size===CATEGORIES.length;
  return Object.freeze({
    format:'osmanx-r59-synthetic-release-gate-v1',tenantId,
    requiredCategories:[...CATEGORIES],
    verifiedCategories:[...received.keys()],missingCategories:missing,
    rejectedEvidenceCount:errors.length,errors,
    independentReporterKeysVerified:keys.size,
    syntheticLabGatePassed:ready,
    industrialRpoCertified:false,
    productionCutoverAllowed:false,
    deployAllowed:false,
    mainMergeAllowed:false,
    independentHumanReviewRequired:true
  });
}
