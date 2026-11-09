// R6.4 isolated WAL archive inventory, stable re-scan, offline Ed25519 receipt.
// This does NOT prove external immutable custody or WAL continuity beyond
// the observed local archive files. No deletion, PUT or restore is performed.
import {readdir,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {createHash,sign,verify} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,SYS=/^[0-9]{10,32}$/,
  LSN=/^[0-9A-F]+\/[0-9A-F]+$/,SHA=/^[a-f0-9]{64}$/,
  WAL=/^[0-9A-F]{24}$/,NONCE=/^[a-f0-9]{32}$/,
  FORMAT='osmanx-r64-wal-archive-v1';
const digest=x=>createHash('sha256').update(x).digest('hex');
function deny(ok,message){if(!ok)throw Error('R6.4 WAL archive refused: '+message);}
function equalKeys(o,keys){
  return o&&typeof o==='object'&&!Array.isArray(o)&&
    Object.keys(o).length===keys.length&&
    keys.every(k=>Object.hasOwn(o,k));
}
function archiveRows(rows,segmentBytes){
  deny(Array.isArray(rows)&&rows.length>=1&&rows.length<=128&&
    Number.isSafeInteger(segmentBytes)&&segmentBytes>=4&&
    segmentBytes<=64*1024*1024,'bounded local WAL inventory required');
  let prev=null;const sorted=[...rows].sort((a,b)=>a.name.localeCompare(b.name));
  for(const row of sorted){
    deny(equalKeys(row,['name','sha256','size'])&&
      WAL.test(row.name||'')&&SHA.test(row.sha256||'')&&
      row.size===segmentBytes,'invalid WAL filename, digest or segment size');
    if(prev!==null){
      deny(row.name!==prev,'duplicate WAL archive segment');
      deny(row.name.slice(0,8)===prev.slice(0,8),
        'WAL archive changed timeline without a signed history file');
      // Filename layout TTTTTTTTLLLLLLLLSSSSSSSS, monotonic segment slots
      // within the same timeline (not an assertion of full WAL coverage).
      deny(BigInt('0x'+row.name.slice(8))===
        BigInt('0x'+prev.slice(8))+1n,
        'gap or reordered WAL segment in observed inventory');
    }
    prev=row.name;
  }
  return sorted;
}
export async function scanR64LocalWalArchive({
  directory,segmentBytes=16*1024*1024
}={}){
  deny(typeof directory==='string'&&directory.startsWith('/')&&
    directory.length<1024,'explicit absolute isolated archive path required');
  const names=(await readdir(directory)).filter(n=>WAL.test(n)).sort();
  deny(names.length>=1&&names.length<=128,'no bounded archived WAL segment files');
  const entries=[];
  for(const name of names){
    const path=join(directory,name),before=await lstat(path);
    deny(before.isFile()&&!before.isSymbolicLink()&&
      before.size===segmentBytes,'archive member is truncated, link or wrong size');
    const h=createHash('sha256');
    for await(const chunk of createReadStream(path,{highWaterMark:1024*1024}))
      h.update(chunk);
    const after=await lstat(path);
    deny(after.isFile()&&after.size===before.size&&
      after.ino===before.ino&&after.mtimeMs===before.mtimeMs&&
      after.ctimeMs===before.ctimeMs,'archived WAL changed during inspection');
    entries.push({name,sha256:h.digest('hex'),size:after.size});
  }
  return Object.freeze(archiveRows(entries,segmentBytes));
}
function normalize(p){
  deny(p?.format===FORMAT&&p.scope==='disposable-lab'&&
    TENANT.test(p.tenantId||'')&&SYS.test(p.systemId||'')&&
    LSN.test(p.targetLsn||'')&&SHA.test(p.baseBackupSha256||'')&&
    NONCE.test(p.nonce||'')&&Number.isSafeInteger(p.timeline)&&p.timeline>=1&&
    Number.isSafeInteger(p.segmentBytes)&&p.segmentBytes>=4&&
    p.segmentBytes<=64*1024*1024&&
    Number.isSafeInteger(p.issuedAt)&&Number.isSafeInteger(p.expiresAt)&&
    p.expiresAt>p.issuedAt&&p.expiresAt-p.issuedAt<=30*60*1000,
    'invalid signed archive root or expiry');
  const segments=archiveRows(p.segments,p.segmentBytes);
  return {format:FORMAT,scope:'disposable-lab',
    tenantId:p.tenantId,systemId:p.systemId,timeline:p.timeline,
    targetLsn:p.targetLsn,baseBackupSha256:p.baseBackupSha256,
    segmentBytes:p.segmentBytes,segments,
    nonce:p.nonce,issuedAt:p.issuedAt,expiresAt:p.expiresAt};
}
export function signR64WalArchive({payload,privateKey}={}){
  deny(privateKey,'offline Ed25519 archive signer required');
  const body=normalize(payload);
  return {...body,signature:sign(null,Buffer.from(JSON.stringify(body)),
    privateKey).toString('base64')};
}
export function verifyR64WalArchive({
  manifest,publicKey,observedSegments,tenantId,now=()=>Date.now()
}={}){
  deny(publicKey&&TENANT.test(tenantId||'')&&Array.isArray(observedSegments),
    'trusted public key and independently reread WAL inventory required');
  const body=normalize(manifest),current=archiveRows(
    observedSegments,body.segmentBytes);
  deny(equalKeys(manifest,[...Object.keys(body),'signature'])&&
    body.tenantId===tenantId&&
    JSON.stringify(body.segments)===JSON.stringify(current),
    'signed WAL inventory differs from actual archive bytes');
  const t=now();
  deny(Number.isSafeInteger(t)&&body.issuedAt<=t&&t<body.expiresAt,
    'WAL manifest expired or not yet valid');
  const bytes=manifest.signature;
  deny(typeof bytes==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(bytes)&&
    Buffer.from(bytes,'base64').length===64&&
    Buffer.from(bytes,'base64').toString('base64')===bytes,
    'noncanonical Ed25519 archive signature');
  let ok=false;
  try{ok=verify(null,Buffer.from(JSON.stringify(body)),
    publicKey,Buffer.from(bytes,'base64'));}catch{ok=false;}
  deny(ok,'WAL archive signature failed');
  return Object.freeze({
    format:'osmanx-r64-wal-inspection-v1',tenantId,
    systemId:body.systemId,timeline:body.timeline,targetLsn:body.targetLsn,
    baseBackupSha256:body.baseBackupSha256,
    archiveEvidenceSha256:digest(Buffer.from(JSON.stringify(body))),
    observedSegments:current.length,
    sourceBytesReread:true,signatureVerified:true,
    archiveChainNoObservedGap:true,
    offsiteImmutableCustodyVerified:false,
    completeWalRangeIndependentlyProven:false,
    productionCutoverAllowed:false
  });
}
