// R4.5: signed, encrypted, isolated CRM backup -> decrypt -> restore -> audit.
// Synthetic fixtures only. Every temporary artifact is deleted; primary remains untouched.
import {DatabaseSync,backup} from 'node:sqlite';
import {createHash,createHmac} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,writeFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {quoteIdent} from './pg-kit.mjs';
import {verifyTrustedMigration} from './pg-trust.mjs';
import {assessR44CriticalParity} from './r44-critical-parity.mjs';
import {openR45Snapshot,sealR45Snapshot,R45_ARCHIVE_FORMAT} from './r45-sealed-backup.mjs';

const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX=128*1024*1024,MAX_ROWS=10000;
function guard(ok,reason){if(!ok)throw Error('R4.5 restore drill denied: '+reason);}
function hex(buf){return createHash('sha256').update(buf).digest('hex');}
function norm(value,type){
  if(value===null)return null;
  if(type==='BYTEA'){guard(value instanceof Uint8Array,'invalid signed binary value');return Buffer.from(value).toString('hex');}
  if(type==='DOUBLE PRECISION'){const x=Number(value);guard(Number.isFinite(x),'invalid signed floating value');return String(x);}
  if(type==='BIGINT'){
    if(typeof value==='number')guard(Number.isSafeInteger(value),'unsafe integer value');
    guard(/^-?\d+$/.test(String(value)),'invalid signed integer');
    return String(value);
  }
  guard(type==='TEXT'&&typeof value==='string'&&!value.includes('\0'),'unsupported text value');return String(value);
}
function auditSchema(db,entry){
  const expected=entry.tables.map(t=>t.name).sort();
  const found=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name);
  guard(JSON.stringify(found)===JSON.stringify(expected),'table inventory differs from signed source');
  const badViews=db.prepare("SELECT name FROM sqlite_master WHERE type IN ('view','trigger') AND name NOT LIKE 'sqlite_%'").all();
  guard(badViews.length===0,'unexpected view or trigger');
  for(const t of entry.tables){
    quoteIdent(t.name);
    guard(Array.isArray(t.columns)&&Array.isArray(t.primary)&&t.primary.length>0,'invalid signed schema');
    const cols=db.prepare('PRAGMA table_info('+quoteIdent(t.name)+')').all();
    guard(JSON.stringify(cols.map(c=>c.name))===JSON.stringify(t.columns.map(c=>c.name)),
      'signed columns changed: '+t.name);
    const pk=cols.filter(c=>c.pk>0).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
    guard(JSON.stringify(pk)===JSON.stringify(t.primary),'signed primary key changed: '+t.name);
  }
}
function assertDbIntegrity(db){
  guard(db.prepare('PRAGMA integrity_check').get()?.integrity_check==='ok','SQLite integrity check failed');
  guard(db.prepare('PRAGMA foreign_key_check').all().length===0,'SQLite foreign key check failed');
}
export function verifyR45SignedSnapshot(db,entry,{secret}={}){
  guard(db&&typeof db.prepare==='function','SQLite handle required');
  guard(entry&&entry.role==='crm'&&Array.isArray(entry.tables),'signed CRM inventory required');
  guard(Buffer.isBuffer(secret)&&secret.length===32,'private HMAC key required');
  assertDbIntegrity(db);
  auditSchema(db,entry);
  const captures=[],report=[];
  for(const table of entry.tables){
    const columnList=table.columns.map(c=>quoteIdent(c.name)).join(',');
    const rows=db.prepare('SELECT '+columnList+' FROM '+quoteIdent(table.name)+
      ' ORDER BY '+table.primary.map(quoteIdent).join(',')).all();
    guard(rows.length<=MAX_ROWS,'row ceiling exceeded for '+table.name);
    if(table.sessionRowsExcluded===true){
      guard(table.name==='sessions'&&table.rows===0,'unknown excluded table');
      continue;
    }
    const sha=createHash('sha256');
    for(const row of rows)sha.update(JSON.stringify(table.columns.map(c=>norm(row[c.name],c.type)))+'\n');
    guard(rows.length===table.rows&&sha.digest('hex')===table.sha256,
      'signed table data mismatch: '+table.name);
    captures.push({table,postgresRows:rows});
    report.push({table:table.name,rows:rows.length});
  }
  const semantic=assessR44CriticalParity(db,captures,{secret});
  guard(semantic.ok&&semantic.paymentWritesPermitted===false&&semantic.automationExecutionPermitted===false,
    'financial or workflow semantics rejected');
  return {signedTablesVerified:report.length,tableCounts:report,semantic};
}
async function secureWrite(path,buf){
  const handle=await open(path,'wx',0o600);
  try{await handle.writeFile(buf);await handle.sync();}finally{await handle.close();}
}
export async function runR45BackupDrill({
  sqlitePath,projectId,actorId,bundleDir,trustedPublicKey,secret,
  maxBytes=MAX
}={}){
  guard(typeof projectId==='string'&&ID.test(projectId),'project UUID required');
  guard(typeof actorId==='string'&&actorId.length>0,'authorized owner required');
  guard(Buffer.isBuffer(secret)&&secret.length===32,'external 32-byte key required');
  guard(Number.isSafeInteger(maxBytes)&&maxBytes>=4096&&maxBytes<=MAX,'unsafe backup size ceiling');
  guard(typeof sqlitePath==='string'&&sqlitePath.length>0,'source file required');
  const sourceStat=lstatSync(sqlitePath);
  guard(sourceStat.isFile()&&!sourceStat.isSymbolicLink()&&sourceStat.size<=maxBytes,
    'source must be a bounded unlinked SQLite file');
  const {manifest,manifestSha256,keyFingerprint}=await verifyTrustedMigration(bundleDir,trustedPublicKey);
  const entry=manifest.databases.find(x=>x.projectId===projectId);
  guard(entry?.role==='crm'&&entry.schema==='ox_p_'+projectId.replaceAll('-',''),'signed CRM tenant absent');
  const dir=await mkdtemp(join(tmpdir(),'ox-r45-restore-'));
  const copied=join(dir,'backup-snapshot.sqlite');
  const sealed=join(dir,'encrypted-drill.oxb');
  const restored=join(dir,'restored.sqlite');
  const startedAt=new Date().toISOString();
  let backupDb,restoreDb;
  try{
    const src=new DatabaseSync(sqlitePath,{readOnly:true});
    try{await backup(src,copied);}finally{src.close();}
    guard(lstatSync(copied).size<=maxBytes,'backup snapshot exceeds maximum bytes');
    backupDb=new DatabaseSync(copied,{readOnly:true});
    const sourceCheck=verifyR45SignedSnapshot(backupDb,entry,{secret});
    const original=await readFile(copied);
    guard(original.length>=16&&original.length<=maxBytes,'unexpected snapshot byte count');
    const plaintextSha256=hex(original);
    const {envelope,envelopeSha256}=sealR45Snapshot(original,{secret,projectId,manifestSha256});
    original.fill(0);
    await secureWrite(sealed,envelope);
    envelope.fill(0);
    const archived=await readFile(sealed);
    guard(hex(archived)===envelopeSha256,'archived ciphertext changed');
    const decrypted=openR45Snapshot(archived,{secret,projectId,manifestSha256});
    archived.fill(0);
    try{
      guard(hex(decrypted)===plaintextSha256,'decrypted archive bytes differ from signed backup');
      await secureWrite(restored,decrypted);
    }finally{decrypted.fill(0);}
    restoreDb=new DatabaseSync(restored,{readOnly:true});
    const restoredCheck=verifyR45SignedSnapshot(restoreDb,entry,{secret});
    guard(restoredCheck.signedTablesVerified===sourceCheck.signedTablesVerified&&
      JSON.stringify(restoredCheck.tableCounts)===JSON.stringify(sourceCheck.tableCounts),
      'restored table inventory changed');
    guard(restoredCheck.semantic.financial.financialTotalsHmac===
      sourceCheck.semantic.financial.financialTotalsHmac,
      'restored financial ledger HMAC differs');
    guard(restoredCheck.semantic.automations.rules===sourceCheck.semantic.automations.rules&&
      restoredCheck.semantic.automations.runs===sourceCheck.semantic.automations.runs&&
      restoredCheck.semantic.custom.entities===sourceCheck.semantic.custom.entities&&
      restoredCheck.semantic.custom.records===sourceCheck.semantic.custom.records,
      'restored automation or custom entity counts differ');
    guard(hex(await readFile(restored))===plaintextSha256,
      'restored byte stream differs from source backup');
    const tenantToken=createHmac('sha256',secret).update('osmanx-r45-tenant\0')
      .update(projectId).digest('hex').slice(0,20);
    return {
      format:'osmanx-r45-backup-restore-drill-v1',syntheticOnly:true,
      signedManifestVerified:true,manifestSha256,keyFingerprint,tenantToken,
      startedAt,finishedAt:new Date().toISOString(),archiveFormat:R45_ARCHIVE_FORMAT,
      encryptedArchiveVerified:true,decryptedBytesVerified:true,
      sqliteIntegrityVerified:true,foreignKeyIntegrityVerified:true,
      financialTotalsHmac:restoredCheck.semantic.financial.financialTotalsHmac,
      financialRecords:restoredCheck.semantic.financial.records,
      automationRules:restoredCheck.semantic.automations.rules,
      automationRuns:restoredCheck.semantic.automations.runs,
      customEntities:restoredCheck.semantic.custom.entities,
      customRecords:restoredCheck.semantic.custom.records,
      signedTablesVerified:restoredCheck.signedTablesVerified,
      snapshotSizeBytes:lstatSync(copied).size,
      encryptedSha256:envelopeSha256,
      sourceReadOnly:true,sourcePrimaryModified:false,temporaryArtifactsDestroyedOnExit:true,
      paymentExecutionPermitted:false,productionCutoverAllowed:false,verified:true
    };
  } finally {
    try{restoreDb?.close();}finally{
      try{backupDb?.close();}finally{await rm(dir,{recursive:true,force:true});}
    }
  }
}
