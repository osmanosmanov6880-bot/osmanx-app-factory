// R4.6 synthetic-only: verify an Ed25519-signed CRM snapshot before
// committing a retained, encrypted local archive; restore to a disposable DB.
import {DatabaseSync,backup} from 'node:sqlite';
import {lstatSync} from 'node:fs';
import {readFile,mkdtemp,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {verifyTrustedMigration} from './pg-trust.mjs';
import {verifyR45SignedSnapshot} from './r45-restore-drill.mjs';
import {createR46VaultBackup,readR46VaultBackup,listR46Vault,rotateR46VaultBackup,pruneR46Vault} from './r46-vault.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID=/^[0-9a-f]{32}$/;
function guard(ok,msg){if(!ok)throw Error('R4.6 signed backup refused: '+msg);}
async function signed(config){
  guard(UUID.test(config.projectId),'invalid project ID');
  const {manifest,manifestSha256}=await verifyTrustedMigration(config.bundleDir,config.trustedPublicKey);
  const entry=manifest.databases.find(x=>x.projectId===config.projectId);
  guard(entry?.role==='crm'&&entry.schema==='ox_p_'+config.projectId.replaceAll('-',''),
    'signed CRM scope missing');
  return {entry,manifestSha256};
}
function opts(config,manifestSha256){
  return {directory:config.vaultDirectory,projectId:config.projectId,manifestSha256,
    catalogKey:config.catalogKey,keyRing:config.keyRing};
}
async function temporary(work){
  const dir=await mkdtemp(join(tmpdir(),'ox-r46-signed-'));
  try{return await work(dir);}finally{await rm(dir,{recursive:true,force:true});}
}
function check(path,entry,key){
  const db=new DatabaseSync(path,{readOnly:true});
  try{return verifyR45SignedSnapshot(db,entry,{secret:key});}
  finally{db.close();}
}
async function restored(config,verified,id){
  return temporary(async dir=>{
    const output=join(dir,'restored.sqlite');
    const {plaintext}=await readR46VaultBackup(opts(config,verified.manifestSha256),{id});
    let file;
    try{
      file=await open(output,'wx',0o600);
      await file.writeFile(plaintext);await file.sync();
    }finally{await file?.close();plaintext.fill(0);}
    const proof=check(output,verified.entry,config.catalogKey);
    return {tables:proof.signedTablesVerified,
      financialHmac:proof.semantic.financial.financialTotalsHmac,
      payments:proof.semantic.financial.records,
      rules:proof.semantic.automations.rules,
      customEntities:proof.semantic.custom.entities};
  });
}
export async function createR46SignedBackup(config){
  guard(typeof config?.actorId==='string'&&config.actorId.length>0,'authenticated owner missing');
  const st=lstatSync(config.sqlitePath);
  guard(st.isFile()&&!st.isSymbolicLink()&&st.size>=4096&&st.size<=128*1024*1024,
    'unsafe source SQLite file');
  const verified=await signed(config);
  return temporary(async dir=>{
    const file=join(dir,'consistent.sqlite');
    const db=new DatabaseSync(config.sqlitePath,{readOnly:true});
    try{await backup(db,file);}finally{db.close();}
    const source=check(file,verified.entry,config.catalogKey);
    const data=await readFile(file);
    let saved;
    try{saved=await createR46VaultBackup(opts(config,verified.manifestSha256),{plaintext:data});}
    finally{data.fill(0);}
    const recovered=await restored(config,verified,saved.record.id);
    guard(recovered.financialHmac===source.semantic.financial.financialTotalsHmac&&
      recovered.tables===source.signedTablesVerified,'restored signed snapshot changed');
    return {format:'osmanx-r46-retained-backup-v1',archive:saved.record,
      signedManifestSha256:verified.manifestSha256,encryptedAtRest:true,
      restoredIntegrityVerified:true,archiveRetained:true,
      financialHmac:recovered.financialHmac,payments:recovered.payments,
      sourcePrimaryModified:false,productionCutoverAllowed:false};
  });
}
export async function verifyR46SignedBackup(config,id){
  guard(typeof config?.actorId==='string'&&config.actorId.length>0&&ID.test(id),
    'owner and archive ID required');
  const verified=await signed(config);
  const proof=await restored(config,verified,id);
  return {format:'osmanx-r46-verified-restore-v1',archiveId:id,
    ...proof,verified:true,primaryModified:false,productionCutoverAllowed:false};
}
export async function listR46SignedBackups(config){
  guard(typeof config?.actorId==='string'&&config.actorId.length>0,'owner required');
  const verified=await signed(config);
  return listR46Vault(opts(config,verified.manifestSha256));
}
export async function rotateR46SignedBackup(config,id){
  guard(typeof config?.actorId==='string'&&config.actorId.length>0&&ID.test(id),'owner required');
  const verified=await signed(config);
  const before=await restored(config,verified,id);
  const result=await rotateR46VaultBackup(opts(config,verified.manifestSha256),{id});
  const after=await restored(config,verified,result.archive.id);
  guard(before.financialHmac===after.financialHmac&&before.tables===after.tables,
    'rotated signed archive changed');
  return {rotationVerified:true,oldArchiveRetained:true,archive:result.archive,
    productionCutoverAllowed:false};
}
export async function pruneR46SignedBackups(config,keep=3){
  guard(typeof config?.actorId==='string'&&config.actorId.length>0,'owner required');
  const verified=await signed(config);
  return pruneR46Vault(opts(config,verified.manifestSha256),{keep});
}
