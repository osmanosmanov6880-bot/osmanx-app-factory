// R6.4 independently signed isolated PITR loss/restore-time evidence.
// A counted synthetic event gap is NOT industrial RPO or customer durability.
import {createHash,sign,verify} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,ID=/^[a-f0-9]{32}$/,
  SHA=/^[a-f0-9]{64}$/,LSN=/^[0-9A-F]+\/[0-9A-F]+$/,
  ISSUER=/^[a-z][a-z0-9._-]{5,63}$/,
  FORMAT='osmanx-r64-recovery-budget-v1';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function deny(ok,why){if(!ok)throw Error('R6.4 recovery budget refused: '+why);}
function fields(v){
  deny(v?.format===FORMAT&&v.scope==='disposable-lab'&&
    TENANT.test(v.tenantId||'')&&ID.test(v.recoveryId||'')&&
    SHA.test(v.archiveInventorySha256||'')&&
    SHA.test(v.checkpointSha256||'')&&LSN.test(v.targetLsn||'')&&
    ISSUER.test(v.reporterId||'')&&ID.test(v.nonce||'')&&
    Number.isSafeInteger(v.sourceCommittedEvents)&&v.sourceCommittedEvents>=2&&
    Number.isSafeInteger(v.targetCommittedEvents)&&v.targetCommittedEvents>=1&&
    Number.isSafeInteger(v.recoveredEvents)&&v.recoveredEvents>=1&&
    v.sourceCommittedEvents>=v.targetCommittedEvents&&
    v.targetCommittedEvents===v.recoveredEvents&&
    v.sourceCommittedEvents-v.recoveredEvents>=1&&
    Number.isSafeInteger(v.startedAt)&&v.startedAt>0&&
    Number.isSafeInteger(v.readyAt)&&v.readyAt>=v.startedAt&&
    v.readyAt-v.startedAt<=20*60*1000&&
    Number.isSafeInteger(v.budgetRtoMs)&&v.budgetRtoMs>=1000&&
    v.budgetRtoMs<=20*60*1000&&
    Number.isSafeInteger(v.budgetExcludedEvents)&&
    v.budgetExcludedEvents>=0&&v.budgetExcludedEvents<=1000&&
    Number.isSafeInteger(v.issuedAt)&&Number.isSafeInteger(v.expiresAt)&&
    v.expiresAt>v.issuedAt&&v.expiresAt-v.issuedAt<=15*60*1000,
    'strict source/restore sequence, intentional exclusion and time bounds required');
  return {format:FORMAT,scope:'disposable-lab',
    tenantId:v.tenantId,recoveryId:v.recoveryId,
    archiveInventorySha256:v.archiveInventorySha256,
    checkpointSha256:v.checkpointSha256,targetLsn:v.targetLsn,
    sourceCommittedEvents:v.sourceCommittedEvents,
    targetCommittedEvents:v.targetCommittedEvents,
    recoveredEvents:v.recoveredEvents,
    startedAt:v.startedAt,readyAt:v.readyAt,
    budgetRtoMs:v.budgetRtoMs,
    budgetExcludedEvents:v.budgetExcludedEvents,
    reporterId:v.reporterId,nonce:v.nonce,
    issuedAt:v.issuedAt,expiresAt:v.expiresAt};
}
export function signR64RecoveryBudget({payload,privateKey}={}){
  deny(privateKey,'offline reporter private key required');
  const body=fields(payload);
  return {...body,signature:sign(null,Buffer.from(JSON.stringify(body)),
    privateKey).toString('base64')};
}
export function verifyR64RecoveryBudget({
  packet,publicKey,tenantId,
  archiveInventorySha256,checkpointSha256,targetLsn,
  now=()=>Date.now()
}={}){
  deny(TENANT.test(tenantId||'')&&
    SHA.test(archiveInventorySha256||'')&&SHA.test(checkpointSha256||'')&&
    LSN.test(targetLsn||'')&&publicKey&&typeof now==='function',
    'pinned independent reporter, checkpoint and archive required');
  const {signature,...p}=packet||{},data=fields(p);
  deny(Object.keys(p).length===Object.keys(data).length&&
    data.tenantId===tenantId&&data.archiveInventorySha256===
      archiveInventorySha256&&data.checkpointSha256===checkpointSha256&&
    data.targetLsn===targetLsn,
    'foreign or noncanonical recovery metrics');
  const at=now();
  deny(Number.isSafeInteger(at)&&data.issuedAt<=at&&at<data.expiresAt,
    'expired or future metrics receipt');
  const sig=Buffer.from(String(signature||''),'base64');
  deny(typeof signature==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(signature)&&
    sig.length===64&&sig.toString('base64')===signature,
    'invalid canonical Ed25519 signature');
  let valid=false;
  try{valid=verify(null,Buffer.from(JSON.stringify(data)),publicKey,sig);}
  catch{valid=false;}
  deny(valid,'independent reporter signature not valid');
  const rto=data.readyAt-data.startedAt,
    excluded=data.sourceCommittedEvents-data.recoveredEvents;
  const within=rto<=data.budgetRtoMs&&
    excluded<=data.budgetExcludedEvents;
  const out={format:'osmanx-r64-recovery-budget-review-v1',tenantId,
    recoveryId:data.recoveryId,
    signedEvidenceSha256:digest(data),
    archiveInventorySha256:data.archiveInventorySha256,
    declaredTargetLsn:data.targetLsn,
    laboratoryRecoveryMs:rto,
    deliberatelyExcludedPostTargetEvents:excluded,
    expectedTargetEventsRecovered:true,
    syntheticRtoBudgetMs:data.budgetRtoMs,
    syntheticEventGapBudget:data.budgetExcludedEvents,
    labBudgetSatisfied:within,
    sourceOfCountsRequiresIndependentPgObservation:true,
    industrialRtoCertified:false,
    industrialRpoCertified:false,
    customerTransactionLossMeasured:false,
    mayClearPendingIntent:false,mayRestoreCustomers:false,
    productionCutoverAllowed:false};
  return Object.freeze(out);
}
