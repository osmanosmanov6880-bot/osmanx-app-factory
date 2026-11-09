// R6.2 independently signed LOGICAL checkpoint backup verification.
// This is not PITR, WAL archive recovery or full PostgreSQL system restore.
// Restore target must be a disposable, separately created empty database.
import {createHash,sign,verify} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,SHA=/^[a-f0-9]{64}$/,
  LSN=/^[0-9A-F]+\/[0-9A-F]+$/,NONCE=/^[a-f0-9]{32}$/,
  FORMAT='osmanx-r62-logical-restore-v1';
function deny(ok,msg){if(!ok)throw Error('R6.2 restore evidence refused: '+msg);}
export const shaR62=bytes=>createHash('sha256').update(bytes).digest('hex');
function shape(x,keys){
  return x&&typeof x==='object'&&!Array.isArray(x)&&
    Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
}
export function normalizedR62Checkpoint(row,tenantId){
  deny(TENANT.test(tenantId||'')&&row&&row.tenant===tenantId&&
    Number.isSafeInteger(Number(row.epoch))&&Number(row.epoch)>=1&&
    Number(row.epoch)<=1000000,
    'invalid tenant or source checkpoint');
  const pending=row.pending_op!==null&&row.pending_op!==undefined;
  deny(!pending||(/^[a-f0-9]{32}$/.test(row.pending_op)&&
    SHA.test(row.pending_sha||'')&&
    Number(row.pending_epoch)===Number(row.epoch)),
    'incomplete pending checkpoint');
  const committed=row.committed_op!==null&&row.committed_op!==undefined;
  deny(!committed||(/^[a-f0-9]{32}$/.test(row.committed_op)&&
    SHA.test(row.committed_sha||'')&&
    Number(row.committed_epoch)>=1),
    'incomplete committed checkpoint');
  const d=row.expires_at instanceof Date?row.expires_at.toISOString():
    row.expires_at===null?null:NaN;
  deny(d!==NaN&&(d===null||typeof d==='string'),
    'unrecognized expiry type');
  return {
    tenant:tenantId,epoch:Number(row.epoch),holder:row.holder,
    leaseId:row.lease_id,expiresAt:d,pendingOp:row.pending_op,
    pendingSha:row.pending_sha,pendingIfMatch:row.pending_if_match,
    pendingCreate:row.pending_create,
    pendingEpoch:pending?Number(row.pending_epoch):null,
    pendingBeforeVersion:row.pending_before_version,
    committedOp:row.committed_op,committedSha:row.committed_sha,
    committedVersion:row.committed_version,
    committedEpoch:committed?Number(row.committed_epoch):null
  };
}
export function digestR62Checkpoint(row,tenantId){
  return shaR62(Buffer.from(JSON.stringify(
    normalizedR62Checkpoint(row,tenantId))));
}
function normalize(p){
  deny(p&&p.format===FORMAT&&p.scope==='disposable-lab'&&
    TENANT.test(p.tenantId||'')&&LSN.test(p.walLsn||'')&&
    SHA.test(p.dumpSha256||'')&&SHA.test(p.checkpointSha256||'')&&
    NONCE.test(p.nonce||'')&&
    Number.isSafeInteger(p.issuedAt)&&Number.isSafeInteger(p.expiresAt)&&
    p.expiresAt>p.issuedAt&&p.expiresAt-p.issuedAt<=30*60*1000,
    'invalid source WAL, dump/checkpoint hash or lab scope');
  return {format:FORMAT,scope:'disposable-lab',tenantId:p.tenantId,
    walLsn:p.walLsn,dumpSha256:p.dumpSha256,
    checkpointSha256:p.checkpointSha256,nonce:p.nonce,
    issuedAt:p.issuedAt,expiresAt:p.expiresAt};
}
export function signR62RestoreManifest({payload,privateKey}={}){
  deny(privateKey,'offline signer missing');
  const data=normalize(payload);
  return {...data,signature:sign(null,Buffer.from(JSON.stringify(data)),
    privateKey).toString('base64')};
}
export function verifyR62Restore({
  manifest,publicKey,tenantId,logicalDump,restoredRow,
  now=()=>Date.now()
}={}){
  deny(publicKey&&TENANT.test(tenantId||'')&&Buffer.isBuffer(logicalDump)&&
    logicalDump.length>0&&logicalDump.length<=4*1024*1024,
    'pinned trusted signer and bounded isolated logical backup required');
  const fields=normalize(manifest);
  deny(shape(manifest,[...Object.keys(fields),'signature'])&&
    manifest.tenantId===tenantId,'noncanonical manifest or foreign tenant');
  const t=now();
  deny(t>=fields.issuedAt&&t<fields.expiresAt,
    'expired or future restore manifest');
  const signature=manifest.signature;
  deny(typeof signature==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(signature)&&
    Buffer.from(signature,'base64').toString('base64')===signature&&
    Buffer.from(signature,'base64').length===64,
    'invalid Ed25519 signature bytes');
  let valid=false;
  try{valid=verify(null,Buffer.from(JSON.stringify(fields)),publicKey,
    Buffer.from(signature,'base64'));}catch{valid=false;}
  deny(valid,'invalid offline restore signature');
  deny(shaR62(logicalDump)===fields.dumpSha256,
    'logical dump digest does not match signed evidence');
  if(restoredRow){
    deny(digestR62Checkpoint(restoredRow,tenantId)===
      fields.checkpointSha256,
      'restored checkpoint differs from original signed source row');
  }
  return Object.freeze({
    format:'osmanx-r62-restore-verification-v1',tenantId,
    walLsn:fields.walLsn,offlineSignatureValid:true,
    dumpVerified:true,restoredRowVerified:Boolean(restoredRow),
    restoredCheckpointSha256:restoredRow?fields.checkpointSha256:null,
    logicalExportOnly:true,walPitrVerified:false,
    fullDatabaseRestoreVerified:false,customerDataRestored:false,
    mayPromote:false,productionCutoverAllowed:false});
}
