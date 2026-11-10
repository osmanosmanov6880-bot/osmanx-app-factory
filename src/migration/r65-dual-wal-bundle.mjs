// R6.5: single offline Ed25519 signature seals exact WAL SHA256, two WORM
// versions and the source physical backup. Remote availability is NEVER
// inferred from the receipt: it must be rechecked against BOTH providers.
import {createHash,sign,verify} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,CASE=/^[a-f0-9]{32}$/,
  SYS=/^[0-9]{10,32}$/,SHA=/^[a-f0-9]{64}$/,
  LSN=/^[0-9A-F]+\/[0-9A-F]+$/,NONCE=/^[a-f0-9]{32}$/,
  STORE=/^[a-z][a-z0-9-]{2,24}$/,
  WAL=/^[0-9A-F]{24}$/,VERSION=/^[A-Za-z0-9_.-]{1,256}$/,
  ETAG=/^"[a-fA-F0-9-]{1,128}"$/,
  FORMAT='osmanx-r65-dual-worm-bundle-v1';
const digest=b=>createHash('sha256').update(b).digest('hex');
function deny(ok,why){if(!ok)throw Error('R6.5 signed WAL bundle refused: '+why);}
function canon(p){
  deny(p?.format===FORMAT&&p.scope==='disposable-lab'&&
    TENANT.test(p.tenantId||'')&&CASE.test(p.incidentId||'')&&
    SYS.test(p.systemId||'')&&
    Number.isSafeInteger(p.timeline)&&p.timeline>=1&&p.timeline<=65535&&
    LSN.test(p.targetLsn||'')&&SHA.test(p.baseBackupSha256||'')&&
    NONCE.test(p.nonce||'')&&
    Number.isSafeInteger(p.issuedAt)&&Number.isSafeInteger(p.expiresAt)&&
    p.expiresAt>p.issuedAt&&p.expiresAt-p.issuedAt<=15*60*1000&&
    Array.isArray(p.inventory)&&p.inventory.length>=1&&
    p.inventory.length<=24&&Array.isArray(p.receipts)&&
    p.receipts.length===p.inventory.length*2,
    'tenant/incident, LSN, backup, expiry and complete custody inventory required');
  const inventory=[...p.inventory].map(x=>{
    deny(x&&WAL.test(x.name||'')&&SHA.test(x.sha256||'')&&
      x.size===16*1024*1024,'untrusted WAL segment');
    return {name:x.name,sha256:x.sha256,size:x.size};
  }).sort((a,b)=>a.name.localeCompare(b.name));
  const segments=new Set(inventory.map(x=>x.name));
  deny(segments.size===inventory.length,'duplicate WAL segment');
  const stores=new Set(),pairs=new Set();
  const receipts=[...p.receipts].map(x=>{
    deny(x?.format==='osmanx-r65-wal-object-receipt-v1'&&
      x.tenantId===p.tenantId&&STORE.test(x.storeId||'')&&
      WAL.test(x.name||'')&&
      SHA.test(x.sha256||'')&&x.size===16*1024*1024&&
      VERSION.test(x.versionId||'')&&ETAG.test(x.etag||'')&&
      x.retentionMode==='COMPLIANCE'&&
      Number.isFinite(Date.parse(x.retainedUntil||''))&&
      Date.parse(x.retainedUntil)>p.expiresAt+5*60000&&
      inventory.some(i=>i.name===x.name&&i.sha256===x.sha256),
      'WORM version, digest, tenant or retention not independently bound');
    const pair=x.name+':'+x.storeId;
    deny(!pairs.has(pair),'duplicate WORM version for a store/segment');
    pairs.add(pair);stores.add(x.storeId);
    return {format:'osmanx-r65-wal-object-receipt-v1',
      tenantId:x.tenantId,storeId:x.storeId,name:x.name,
      sha256:x.sha256,size:x.size,versionId:x.versionId,
      etag:x.etag,retentionMode:'COMPLIANCE',
      retainedUntil:x.retainedUntil};
  }).sort((a,b)=>
    (a.name+':'+a.storeId).localeCompare(b.name+':'+b.storeId));
  deny(stores.size===2,'must have exactly two distinct custodian identities');
  for(const entry of inventory){
    deny([...stores].every(s=>pairs.has(entry.name+':'+s)),
      'each WAL segment must be witnessed by both stores');
  }
  return {format:FORMAT,scope:'disposable-lab',
    tenantId:p.tenantId,incidentId:p.incidentId,
    systemId:p.systemId,timeline:p.timeline,targetLsn:p.targetLsn,
    baseBackupSha256:p.baseBackupSha256,inventory,receipts,
    nonce:p.nonce,issuedAt:p.issuedAt,expiresAt:p.expiresAt};
}
export function signR65DualWalBundle({payload,privateKey}={}){
  deny(privateKey,'offline Ed25519 signer is mandatory');
  const p=canon(payload);
  return {...p,signature:sign(null,Buffer.from(JSON.stringify(p)),
    privateKey).toString('base64')};
}
export function verifyR65DualWalBundle({
  manifest,publicKey,tenantId,now=()=>Date.now()
}={}){
  deny(publicKey&&TENANT.test(tenantId||'')&&typeof now==='function',
    'offline trusted public key and exact tenant scope required');
  const p=canon(manifest);
  deny(Object.keys(manifest).length===Object.keys(p).length+1&&
    Object.keys(p).every(k=>Object.hasOwn(manifest,k))&&
    Object.hasOwn(manifest,'signature')&&p.tenantId===tenantId&&
    JSON.stringify({...p,signature:manifest.signature})===JSON.stringify(manifest),
    'canonical signed WAL bundle or tenant mismatch');
  const t=now();
  deny(Number.isSafeInteger(t)&&p.issuedAt<=t&&t<p.expiresAt,
    'bundle signature expired or from future');
  const raw=manifest.signature;
  deny(typeof raw==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(raw)&&
    Buffer.from(raw,'base64').length===64&&
    Buffer.from(raw,'base64').toString('base64')===raw,
    'noncanonical Ed25519 signature');
  let ok=false;
  try{ok=verify(null,Buffer.from(JSON.stringify(p)),
    publicKey,Buffer.from(raw,'base64'));}catch{ok=false;}
  deny(ok,'offline bundle signature failed');
  return Object.freeze({
    format:'osmanx-r65-dual-bundle-review-v1',
    tenantId,incidentId:p.incidentId,systemId:p.systemId,
    timeline:p.timeline,targetLsn:p.targetLsn,
    baseBackupSha256:p.baseBackupSha256,
    segmentCount:p.inventory.length,
    storeCount:2,receiptCount:p.receipts.length,
    evidenceSha256:digest(Buffer.from(JSON.stringify(p))),
    signatureVerified:true,retainedReceiptClaimsVerified:true,
    independentlyRereadFromProviders:false,
    sourceServerFailureSimulated:false,
    offsiteGeographicCustodyCertified:false,
    productionCutoverAllowed:false
  });
}
