// R6.2 offline evidence of a DISPOSABLE lab's old-primary termination.
// This is a signed observer statement, not an external hardware STONITH
// guarantee. It NEVER grants the authority to promote or write.
import {createHash,createPublicKey,sign,verify} from 'node:crypto';
const HEX24=/^[a-f0-9]{24}$/,HEX32=/^[a-f0-9]{32}$/,
  HEX64=/^[a-f0-9]{64}$/,NODE=/^[a-z][a-z0-9-]{2,48}$/,
  LSN=/^[0-9A-F]+\/[0-9A-F]+$/,
  FORMAT='osmanx-r62-primary-fence-observation-v1';
const ROLES=new Set(['fence-observer','standby-observer']);
const sha=b=>createHash('sha256').update(b).digest('hex');
function deny(ok,why){if(!ok)throw Error('R6.2 fence observation refused: '+why);}
function shape(value,keys){
  return value&&typeof value==='object'&&!Array.isArray(value)&&
    Object.keys(value).length===keys.length&&
    keys.every(k=>Object.hasOwn(value,k));
}
function normalize(p){
  deny(p&&HEX24.test(p.tenantId||'')&&HEX24.test(p.clusterId||'')&&
    HEX32.test(p.incidentId||'')&&NODE.test(p.primaryNode||'')&&
    NODE.test(p.standbyNode||'')&&p.primaryNode!==p.standbyNode&&
    Number.isSafeInteger(p.epoch)&&p.epoch>=1&&p.epoch<=1000000&&
    LSN.test(p.requiredLsn||'')&&HEX64.test(p.intentSha256||'')&&
    HEX64.test(p.challengeSha256||'')&&
    p.primaryPowerState==='terminated'&&
    p.standbyInRecovery===true&&p.standbyReplayVerified===true&&
    ROLES.has(p.role)&&NODE.test(p.observerId||'')&&
    HEX32.test(p.nonce||'')&&p.scope==='disposable-lab'&&
    Number.isSafeInteger(p.issuedAt)&&Number.isSafeInteger(p.expiresAt)&&
    p.expiresAt>p.issuedAt&&p.expiresAt-p.issuedAt<=60000,
    'incomplete or non-terminated primary, missing replay or invalid fence scope');
  return {format:FORMAT,scope:p.scope,tenantId:p.tenantId,
    clusterId:p.clusterId,incidentId:p.incidentId,
    primaryNode:p.primaryNode,standbyNode:p.standbyNode,epoch:p.epoch,
    requiredLsn:p.requiredLsn,intentSha256:p.intentSha256,
    challengeSha256:p.challengeSha256,
    primaryPowerState:p.primaryPowerState,
    standbyInRecovery:p.standbyInRecovery,
    standbyReplayVerified:p.standbyReplayVerified,
    role:p.role,observerId:p.observerId,nonce:p.nonce,
    issuedAt:p.issuedAt,expiresAt:p.expiresAt};
}
function fingerprint(key){
  const pub=key?.type==='public'?key:createPublicKey(key);
  return sha(pub.export({type:'spki',format:'der'}));
}
export function signR62FenceObservation({payload,privateKey}={}){
  deny(privateKey,'offline observer key missing');
  const body=normalize(payload);
  return {...body,signature:sign(null,Buffer.from(JSON.stringify(body)),
    privateKey).toString('base64')};
}
export function inspectR62FenceObservations({
  observations,observers,expected,now=()=>Date.now()
}={}){
  deny(Array.isArray(observations)&&observations.length===2&&
    observers&&typeof observers==='object'&&expected&&
    HEX24.test(expected.tenantId||'')&&HEX24.test(expected.clusterId||'')&&
    HEX32.test(expected.incidentId||'')&&
    Number.isSafeInteger(expected.epoch)&&expected.epoch>=1&&
    HEX64.test(expected.intentSha256||'')&&
    HEX64.test(expected.challengeSha256||'')&&
    LSN.test(expected.requiredLsn||'')&&
    NODE.test(expected.primaryNode||'')&&
    NODE.test(expected.standbyNode||''),
    'two pinned independent observers and expected checkpoint required');
  const roles=new Set(),keys=new Set(),identities=new Set();
  const at=now();
  const stable=['tenantId','clusterId','incidentId','epoch',
    'intentSha256','challengeSha256','requiredLsn',
    'primaryNode','standbyNode'];
  for(const packet of observations){
    const fields=normalize(packet);
    deny(shape(packet,[...Object.keys(fields),'signature'])&&
      packet.format===FORMAT,'noncanonical signed observation');
    deny(stable.every(k=>fields[k]===expected[k]),
      'observed incident, WAL barrier, old node or checkpoint mismatch');
    deny(fields.issuedAt<=at&&at<fields.expiresAt,
      'stale or future observation');
    const t=observers[fields.observerId];
    deny(t&&t.role===fields.role&&t.revoked!==true&&t.publicKey,
      'unknown, revoked or wrong-role observer');
    const signature=packet.signature;
    deny(typeof signature==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(signature)&&
      Buffer.from(signature,'base64').toString('base64')===signature&&
      Buffer.from(signature,'base64').length===64,
      'invalid signature encoding');
    let valid=false;
    try{valid=verify(null,Buffer.from(JSON.stringify(fields)),
      t.publicKey,Buffer.from(signature,'base64'));}catch{valid=false;}
    deny(valid,'untrusted or changed offline signature');
    const key=fingerprint(t.publicKey);
    deny(!keys.has(key)&&!roles.has(fields.role)&&
      !identities.has(fields.observerId),
      'not two distinct observer roles and signing keys');
    keys.add(key);roles.add(fields.role);identities.add(fields.observerId);
  }
  deny(roles.has('fence-observer')&&roles.has('standby-observer'),
    'missing independent fence or standby observer');
  return Object.freeze({format:'osmanx-r62-fence-review-v1',
    tenantId:expected.tenantId,incidentId:expected.incidentId,
    oldPrimaryReportedTerminated:true,standbyReplayReported:true,
    independentObserverKeys:2,challengeSha256:expected.challengeSha256,
    observerReportsVerified:true,
    physicalPowerIsolationIndependentlyCertified:false,
    oldPrimaryFencedByThisSoftware:false,
    automaticPromotionAllowed:false,productionCutoverAllowed:false});
}
