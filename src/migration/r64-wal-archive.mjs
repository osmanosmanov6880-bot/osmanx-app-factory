// R6.4 bounded and Ed25519-signed WAL segment inventory.
// Verifies actual archived segment bytes, never just filenames.
// PostgreSQL default 16MiB WAL segment size is pinned for this lab.
import {createHash,sign,verify} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,SYSTEM=/^[0-9]{10,32}$/,
  SHA=/^[a-f0-9]{64}$/,WAL=/^[0-9A-F]{24}$/,LSN=/^[0-9A-F]+\/[0-9A-F]+$/,
  ISSUER=/^[a-z][a-z0-9._-]{5,63}$/,NONCE=/^[a-f0-9]{32}$/,
  SIZE=16*1024*1024,FORMAT='osmanx-r64-wal-archive-v1';
const digest=b=>createHash('sha256').update(b).digest('hex');
function deny(ok,why){if(!ok)throw Error('R6.4 WAL archive refused: '+why);}
function walIndex(name){
  deny(WAL.test(name||''),'strict 24-hex WAL file name required');
  const timeline=parseInt(name.slice(0,8),16);
  const log=BigInt('0x'+name.slice(8,16));
  const seg=BigInt('0x'+name.slice(16,24));
  deny(timeline>=1&&seg<256n,'invalid 16MiB WAL file number');
  return {timeline,index:log*256n+seg};
}
function lsnIndex(lsn){
  deny(LSN.test(lsn||''),'valid PostgreSQL target LSN required');
  const [hi,lo]=lsn.split('/');
  const pos=BigInt('0x'+hi)*0x100000000n+BigInt('0x'+lo);
  return pos/BigInt(SIZE);
}
function ordered(segments,timeline,targetLsn){
  deny(Array.isArray(segments)&&segments.length>=1&&segments.length<=16,
    'bounded WAL archive inventory required');
  const copy=[...segments].sort((a,b)=>
    a.name.localeCompare(b.name));
  const ids=new Set();
  let prior=null;
  for(const segment of copy){
    deny(segment&&WAL.test(segment.name||'')&&
      segment.bytes===SIZE&&SHA.test(segment.sha256||'')&&
      !ids.has(segment.name),
      'duplicate or unsigned full WAL segment');
    ids.add(segment.name);
    const {timeline:found,index}=walIndex(segment.name);
    deny(found===timeline,'foreign WAL timeline');
    if(prior!==null)deny(index===prior+1n,
      'missing, reordered or duplicate WAL segment');
    prior=index;
  }
  const first=walIndex(copy[0].name).index;
  const target=lsnIndex(targetLsn);
  deny(target>=first&&target<=prior,
    'target LSN not covered by archived WAL segment inventory');
  return copy.map(x=>({name:x.name,bytes:x.bytes,sha256:x.sha256}));
}
function fields(p){
  deny(p&&p.format===FORMAT&&p.scope==='disposable-lab'&&
    TENANT.test(p.tenantId||'')&&SYSTEM.test(p.systemId||'')&&
    Number.isSafeInteger(p.timeline)&&p.timeline>=1&&p.timeline<=65535&&
    SHA.test(p.baseBackupSha256||'')&&LSN.test(p.targetLsn||'')&&
    ISSUER.test(p.issuer||'')&&NONCE.test(p.nonce||'')&&
    Number.isSafeInteger(p.issuedAt)&&Number.isSafeInteger(p.expiresAt)&&
    p.expiresAt>p.issuedAt&&p.expiresAt-p.issuedAt<=30*60*1000,
    'invalid backup identity, timeline, issuer or receipt expiry');
  const segments=ordered(p.segments,p.timeline,p.targetLsn);
  return {format:FORMAT,scope:'disposable-lab',
    tenantId:p.tenantId,systemId:p.systemId,timeline:p.timeline,
    baseBackupSha256:p.baseBackupSha256,targetLsn:p.targetLsn,
    segments,issuer:p.issuer,nonce:p.nonce,
    issuedAt:p.issuedAt,expiresAt:p.expiresAt};
}
function validateSignature(packet,publicKey){
  const {signature,...body}=packet||{};
  const expected=fields(body);
  deny(publicKey&&Object.keys(body).length===Object.keys(expected).length&&
    body.format===FORMAT,'noncanonical WAL evidence fields');
  const sig=Buffer.from(String(signature||''),'base64');
  deny(typeof signature==='string'&&
    /^[A-Za-z0-9+/]+={0,2}$/.test(signature)&&
    sig.length===64&&sig.toString('base64')===signature,
    'invalid canonical Ed25519 bytes');
  let valid=false;
  try{valid=verify(null,Buffer.from(JSON.stringify(expected)),
    publicKey,sig);}catch{valid=false;}
  deny(valid,'WAL archive signature mismatch');
  return expected;
}
export function signR64WalArchive({payload,privateKey}={}){
  deny(privateKey,'independent archive signing key required');
  const body=fields(payload);
  return {...body,signature:sign(null,
    Buffer.from(JSON.stringify(body)),privateKey).toString('base64')};
}
export function makeR64WalSegmentRecord({name,bytes}={}){
  deny(WAL.test(name||'')&&Buffer.isBuffer(bytes)&&bytes.length===SIZE,
    'exact full 16MiB WAL archive segment required');
  walIndex(name);
  return Object.freeze({name,bytes:bytes.length,sha256:digest(bytes)});
}
export async function verifyR64WalArchive({
  packet,publicKey,tenantId,systemId,
  baseBackupSha256,reader,now=()=>Date.now()
}={}){
  deny(TENANT.test(tenantId||'')&&SYSTEM.test(systemId||'')&&
    SHA.test(baseBackupSha256||'')&&typeof reader==='function'&&
    typeof now==='function','tenant, system, base backup and trusted file reader required');
  const body=validateSignature(packet,publicKey);
  deny(body.tenantId===tenantId&&body.systemId===systemId&&
    body.baseBackupSha256===baseBackupSha256,
    'foreign cluster, tenant or base backup');
  const at=now();
  deny(Number.isSafeInteger(at)&&body.issuedAt<=at&&at<body.expiresAt,
    'expired or future WAL archive evidence');
  for(const entry of body.segments){
    const bytes=await reader(entry.name);
    deny(Buffer.isBuffer(bytes)&&bytes.length===SIZE&&
      digest(bytes)===entry.sha256,
      'missing, truncated or tampered WAL segment '+entry.name);
  }
  return Object.freeze({format:'osmanx-r64-verified-wal-archive-v1',
    tenantId,systemId,timeline:body.timeline,targetLsn:body.targetLsn,
    verifiedSegments:body.segments.length,
    archiveInventorySha256:digest(Buffer.from(JSON.stringify(body))),
    fullSegmentHashesVerified:true,
    externalWormCustodyVerified:false,
    walPitrCompleted:false,mayRestoreCustomerData:false,
    productionCutoverAllowed:false});
}
