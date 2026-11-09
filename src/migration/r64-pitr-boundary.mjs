// R6.4 signed factual PITR boundary receipt for disposable marker transactions.
// The three synthetic markers do NOT measure the RPO of the real service.
import {createHash,sign,verify} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,INCIDENT=/^[a-f0-9]{32}$/,
  SYS=/^[0-9]{10,32}$/,SHA=/^[a-f0-9]{64}$/,
  LSN=/^[0-9A-F]+\/[0-9A-F]+$/,NONCE=/^[a-f0-9]{32}$/,
  FORMAT='osmanx-r64-pitr-boundary-v1',
  ORIGINAL=['baseline','excluded','selected'],
  RESTORED=['baseline','selected'];
const digest=b=>createHash('sha256').update(b).digest('hex');
function deny(ok,msg){if(!ok)throw Error('R6.4 PITR receipt refused: '+msg);}
const exact=(o,ks)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).length===ks.length&&ks.every(k=>Object.hasOwn(o,k));
function normalized(p){
  deny(p?.format===FORMAT&&p.scope==='disposable-lab'&&
    TENANT.test(p.tenantId||'')&&INCIDENT.test(p.incidentId||'')&&
    SYS.test(p.systemId||'')&&
    LSN.test(p.targetLsn||'')&&LSN.test(p.afterLsn||'')&&
    SHA.test(p.archiveEvidenceSha256||'')&&
    SHA.test(p.baseBackupSha256||'')&&
    NONCE.test(p.nonce||'')&&
    Number.isSafeInteger(p.issuedAt)&&Number.isSafeInteger(p.expiresAt)&&
    p.expiresAt>p.issuedAt&&p.expiresAt-p.issuedAt<=30*60*1000,
    'invalid isolated recovery boundary receipt');
  return {format:FORMAT,scope:'disposable-lab',
    tenantId:p.tenantId,incidentId:p.incidentId,systemId:p.systemId,
    targetLsn:p.targetLsn,afterLsn:p.afterLsn,
    archiveEvidenceSha256:p.archiveEvidenceSha256,
    baseBackupSha256:p.baseBackupSha256,
    nonce:p.nonce,issuedAt:p.issuedAt,expiresAt:p.expiresAt};
}
export function signR64PitrBoundary({payload,privateKey}={}){
  deny(privateKey,'offline Ed25519 signer required');
  const b=normalized(payload);
  return {...b,signature:sign(null,Buffer.from(JSON.stringify(b)),
    privateKey).toString('base64')};
}
function lsnBigInt(x){
  const [hi,lo]=x.split('/');
  return (BigInt('0x'+hi)<<32n)+BigInt('0x'+lo);
}
function markerSet(input){
  deny(Array.isArray(input)&&input.length<=3&&
    input.every(x=>typeof x==='string')&&
    new Set(input).size===input.length,
    'invalid or duplicate synthetic transaction markers');
  return [...input].sort();
}
export function verifyR64PitrBoundary({
  manifest,publicKey,tenantId,sourceMarkers,
  restoredMarkers,restoredSystemId,
  archiveReceipt,now=()=>Date.now()
}={}){
  deny(publicKey&&TENANT.test(tenantId||'')&&archiveReceipt&&
    Array.isArray(sourceMarkers)&&Array.isArray(restoredMarkers),
    'public key, independent archive receipt and both observed databases required');
  const b=normalized(manifest);
  deny(exact(manifest,[...Object.keys(b),'signature'])&&
    b.tenantId===tenantId&&
    String(restoredSystemId)===b.systemId&&
    archiveReceipt.tenantId===tenantId&&
    archiveReceipt.signatureVerified===true&&
    archiveReceipt.archiveEvidenceSha256===b.archiveEvidenceSha256&&
    archiveReceipt.baseBackupSha256===b.baseBackupSha256&&
    archiveReceipt.targetLsn===b.targetLsn,
    'archive, source and restored cluster not bound to the same target');
  deny(lsnBigInt(b.afterLsn)>lsnBigInt(b.targetLsn),
    'late acknowledged COMMIT is not after selected PITR LSN');
  const t=now();
  deny(Number.isSafeInteger(t)&&b.issuedAt<=t&&t<b.expiresAt,
    'expired or future PITR receipt');
  const sig=manifest.signature;
  deny(typeof sig==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(sig)&&
    Buffer.from(sig,'base64').length===64&&
    Buffer.from(sig,'base64').toString('base64')===sig,
    'bad PITR receipt signature bytes');
  let valid=false;
  try{valid=verify(null,Buffer.from(JSON.stringify(b)),
    publicKey,Buffer.from(sig,'base64'));}catch{valid=false;}
  deny(valid,'invalid offline PITR boundary signature');
  deny(JSON.stringify(markerSet(sourceMarkers))===JSON.stringify(ORIGINAL),
    'source transaction receipts are not all present and committed');
  deny(JSON.stringify(markerSet(restoredMarkers))===JSON.stringify(RESTORED),
    'restored database includes late COMMIT or lost selected COMMIT');
  return Object.freeze({
    format:'osmanx-r64-pitr-boundary-inspection-v1',
    tenantId,incidentId:b.incidentId,systemId:b.systemId,
    targetLsn:b.targetLsn,afterLsn:b.afterLsn,
    archiveEvidenceSha256:b.archiveEvidenceSha256,
    baseBackupSha256:b.baseBackupSha256,
    boundaryReceiptSha256:digest(Buffer.from(JSON.stringify(b))),
    selectedTransactionRecovered:true,
    intentionallyLaterTransactionExcluded:true,
    backupTransactionPreserved:true,
    syntheticMarkerVerificationPassed:true,
    intentionallyExcludedSyntheticTransactions:1,
    unknownCustomerWritesNotCounted:true,
    industrialZeroRpoCertified:false,
    productionCutoverAllowed:false
  });
}
