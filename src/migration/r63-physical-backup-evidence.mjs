// R6.3 signed PHYSICAL pg_basebackup manifest, pg_verifybackup + restore.
// Physical backup with streamed WAL is not point-in-time recovery or
// proof of offsite archiving. Never restores customer data.
import {createHash,sign,verify} from 'node:crypto';
import {digestR62Checkpoint}
  from './r62-restore-evidence.mjs';
const TENANT=/^[a-f0-9]{24}$/,SHA=/^[a-f0-9]{64}$/,
  SYS=/^[0-9]{10,32}$/,LSN=/^[0-9A-F]+\/[0-9A-F]+$/,
  NONCE=/^[a-f0-9]{32}$/,FORMAT='osmanx-r63-physical-backup-v1';
const hash=x=>createHash('sha256').update(x).digest('hex');
function deny(ok,why){if(!ok)throw Error('R6.3 physical backup refused: '+why);}
function exact(obj,keys){return obj&&typeof obj==='object'&&
  !Array.isArray(obj)&&Object.keys(obj).length===keys.length&&
  keys.every(k=>Object.hasOwn(obj,k));}
export function inspectR63PgBackupManifest(bytes){
  deny(Buffer.isBuffer(bytes)&&bytes.length>=60&&
    bytes.length<=8*1024*1024,
    'bounded physical PostgreSQL backup_manifest required');
  let m;try{m=JSON.parse(bytes.toString('utf8'));}
  catch{throw Error('R6.3 physical backup refused: invalid manifest JSON');}
  deny(m?.['PostgreSQL-Backup-Manifest-Version']===1&&
    Array.isArray(m.Files)&&m.Files.length>=1&&m.Files.length<=30000&&
    Array.isArray(m['WAL-Ranges'])&&
    m['WAL-Ranges'].length>=1&&m['WAL-Ranges'].length<=64&&
    SHA.test(m['Manifest-Checksum']||''),
    'missing PG version, file list, WAL range or checksum');
  const names=new Set();
  for(const f of m.Files){
    const p=f?.Path;
    deny(typeof p==='string'&&p.length>=1&&p.length<=1024&&
      !p.startsWith('/')&&!p.includes('\\')&&
      !p.split('/').includes('..')&&!p.split('/').includes('.')&&
      !names.has(p)&&
      Number.isSafeInteger(f.Size)&&f.Size>=0,
      'duplicate, foreign or malformed backup file entry');
    names.add(p);
  }
  for(const wal of m['WAL-Ranges']){
    deny(Number.isSafeInteger(wal.Timeline)&&wal.Timeline>=1&&
      LSN.test(wal['Start-LSN']||'')&&LSN.test(wal['End-LSN']||''),
      'invalid physical WAL range');
  }
  return Object.freeze({format:'osmanx-r63-pg-manifest-inspect-v1',
    fileCount:m.Files.length,walRangeCount:m['WAL-Ranges'].length,
    backupManifestSha256:hash(bytes),
    declaresManifestChecksum:true,
    independentlyVerifiedByPgVerifybackup:false,
    fullPitrCertified:false,productionCutoverAllowed:false});
}
function fields(p){
  deny(p?.format===FORMAT&&p.scope==='disposable-lab'&&
    TENANT.test(p.tenantId||'')&&SYS.test(p.systemId||'')&&
    Number.isSafeInteger(p.timeline)&&p.timeline>=1&&
    p.timeline<=65535&&LSN.test(p.sourceLsn||'')&&
    SHA.test(p.manifestSha256||'')&&SHA.test(p.checkpointSha256||'')&&
    NONCE.test(p.nonce||'')&&Number.isSafeInteger(p.issuedAt)&&
    Number.isSafeInteger(p.expiresAt)&&p.expiresAt>p.issuedAt&&
    p.expiresAt-p.issuedAt<=30*60*1000&&
    p.verifierTool==='pg_verifybackup',
    'invalid signed physical backup identity, WAL or checksum');
  return {format:FORMAT,scope:'disposable-lab',
    tenantId:p.tenantId,systemId:p.systemId,timeline:p.timeline,
    sourceLsn:p.sourceLsn,manifestSha256:p.manifestSha256,
    checkpointSha256:p.checkpointSha256,
    verifierTool:'pg_verifybackup',nonce:p.nonce,
    issuedAt:p.issuedAt,expiresAt:p.expiresAt};
}
export function signR63PhysicalBackupEvidence({payload,privateKey}={}){
  deny(privateKey,'offline Ed25519 signer missing');
  const b=fields(payload);
  return {...b,signature:sign(null,Buffer.from(JSON.stringify(b)),
    privateKey).toString('base64')};
}
export function verifyR63PhysicalBackup({
  manifest,publicKey,manifestBytes,tenantId,
  restoredRow,restoredSystemId,restoredTimeline,
  verifierExitCode,now=()=>Date.now()
}={}){
  deny(publicKey&&TENANT.test(tenantId||'')&&
    Number.isInteger(verifierExitCode),
    'trusted signer and actual pg_verifybackup result required');
  const body=fields(manifest),review=inspectR63PgBackupManifest(manifestBytes);
  deny(exact(manifest,[...Object.keys(body),'signature'])&&
    body.tenantId===tenantId&&body.manifestSha256===review.backupManifestSha256,
    'signed manifest not bound to exact physical backup');
  const t=now();
  deny(Number.isSafeInteger(t)&&body.issuedAt<=t&&t<body.expiresAt,
    'expired or future physical backup signature');
  const sig=manifest.signature;
  deny(typeof sig==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(sig)&&
    Buffer.from(sig,'base64').toString('base64')===sig&&
    Buffer.from(sig,'base64').length===64,
    'noncanonical physical backup signature');
  let verified=false;
  try{verified=verify(null,Buffer.from(JSON.stringify(body)),
    publicKey,Buffer.from(sig,'base64'));}catch{verified=false;}
  deny(verified,'invalid offline physical backup signature');
  deny(verifierExitCode===0,'pg_verifybackup must complete without error');
  deny(restoredRow&&SYS.test(String(restoredSystemId||''))&&
    Number.isInteger(restoredTimeline)&&restoredTimeline>=1,
    'separate restored PostgreSQL not inspected');
  deny(String(restoredSystemId)===body.systemId&&
    restoredTimeline===body.timeline&&
    digestR62Checkpoint(restoredRow,tenantId)===body.checkpointSha256,
    'restored system, timeline or fenced checkpoint differs');
  return Object.freeze({
    format:'osmanx-r63-physical-restore-review-v1',
    tenantId,sourceSystemId:body.systemId,
    sourceTimeline:body.timeline,
    manifestSha256:body.manifestSha256,
    checkpointSha256:body.checkpointSha256,
    pgVerifybackupPassed:true,
    restoredPhysicalNodeVerified:true,
    restoredCheckpointExactlyMatches:true,
    fullPgClusterRecoveryReviewed:false,
    walArchivePitrVerified:false,
    externalBackupCustodyVerified:false,
    productionCutoverAllowed:false
  });
}
