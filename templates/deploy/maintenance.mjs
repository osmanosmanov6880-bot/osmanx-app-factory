import {backup as sqliteBackup,DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,rm,copyFile,lstat,chmod} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const hash=b=>createHash('sha256').update(b).digest('hex');
const fail=msg=>{throw Error(msg)};
const newId=()=>new Date().toISOString().replace(/\D/g,'').slice(0,14)+'-'+randomBytes(6).toString('hex');
async function realDirectory(path){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())fail('Directory is missing or symlink: '+path)}
async function realFile(path){const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink())fail('File is missing or symlink: '+path)}
async function checkDb(path){
 await realFile(path);const db=new DatabaseSync(path,{readOnly:true});
 try{if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')fail('Database integrity check failed');
     if(db.prepare('PRAGMA foreign_key_check').all().length)fail('Database FK check failed')}
 finally{db.close()}
}
async function identity(root){
 const p=JSON.parse(await readFile(join(root,'config/project.json'),'utf8'));
 if(!/^[a-f0-9-]{36}$/.test(p.id||'')||!['crm','site'].includes(p.type))fail('Invalid project identity');
 return {projectId:p.id,type:p.type,dbName:p.type==='site'?'site.sqlite':'crm.sqlite'};
}
function offlineOnly(dir){
 // PID values from another Docker container are not comparable: fail closed.
 for(const f of ['server.lock','maintenance.lock','update-in-progress.json'])
  if(existsSync(join(dir,f)))fail('Stop app and resolve '+f+' before maintenance');
}
async function saveBackup({root,dataDir,backupDir}){
 const ident=await identity(root),source=join(dataDir,ident.dbName);await checkDb(source);
 const id=newId(),pending=join(backupDir,'.'+id+'.pending'),target=join(backupDir,id);
 await mkdir(pending,{mode:0o700});
 try{
  const saved=join(pending,ident.dbName),db=new DatabaseSync(source,{readOnly:true});
  try{await sqliteBackup(db,saved)}finally{db.close()}
  await chmod(saved,0o600);await checkDb(saved);
  const bytes=await readFile(saved);
  const meta={format:'osmanx-offline-backup',version:1,id,projectId:ident.projectId,type:ident.type,
   dbFile:ident.dbName,createdAt:new Date().toISOString(),dbBytes:bytes.length,sha256:hash(bytes)};
  await writeFile(join(pending,'backup.json'),JSON.stringify(meta,null,2)+'\n',{mode:0o600,flag:'wx'});
  await rename(pending,target);
  return {ok:true,operation:'backup',id,sha256:meta.sha256,bytes:meta.dbBytes,
   warning:'Backup contains personal data: store an encrypted copy off-server.'};
 }catch(e){await rm(pending,{recursive:true,force:true});throw e}
}
async function checkBackup({root,backupDir},id){
 if(typeof id!=='string'||!/^\d{14}-[0-9a-f]{12}$/.test(id))fail('Invalid backup ID');
 const ident=await identity(root),dir=join(backupDir,id);await realDirectory(dir);
 const metaPath=join(dir,'backup.json'),dbPath=join(dir,ident.dbName);
 await realFile(metaPath);await realFile(dbPath);
 const meta=JSON.parse(await readFile(metaPath,'utf8'));
 if(meta.format!=='osmanx-offline-backup'||meta.version!==1||meta.projectId!==ident.projectId||
    meta.type!==ident.type||meta.dbFile!==ident.dbName||meta.id!==id)fail('Backup identity mismatch');
 const bytes=await readFile(dbPath);
 if(bytes.length!==meta.dbBytes||hash(bytes)!==meta.sha256)fail('Backup hash mismatch');
 await checkDb(dbPath);return {ident,dbPath,meta};
}
/** Same checked restore operation for real restore and disposable restoration drills. */
async function stageVerifiedDatabase(source,target,expected){
 const pending=target+'.incoming-'+randomBytes(8).toString('hex');
 try{
  await copyFile(source,pending);await chmod(pending,0o600);
  const bytes=await readFile(pending);
  if(bytes.length!==expected.dbBytes||hash(bytes)!==expected.sha256)fail('Staged backup hash mismatch');
  await checkDb(pending);
  await rename(pending,target);
  await checkDb(target);
  if(hash(await readFile(target))!==expected.sha256)fail('Restored database hash mismatch');
 }finally{await rm(pending,{force:true})}
}
/** Offline, non-destructive recovery rehearsal. Does not modify /app/data or its SQLite. */
async function drillBackup({root,backupDir},id){
 const saved=await checkBackup({root,backupDir},id);
 const drillDir=join(backupDir,'.drill-'+randomBytes(12).toString('hex'));
 await mkdir(drillDir,{mode:0o700});
 try{
  const restored=join(drillDir,saved.ident.dbName);
  await stageVerifiedDatabase(saved.dbPath,restored,saved.meta);
  // Exercise a true read-only SQLite query against the independently restored file.
  const db=new DatabaseSync(restored,{readOnly:true});
  let tableCount;
  try{tableCount=db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n}
  finally{db.close()}
  return {ok:true,operation:'drill',backupId:id,projectId:saved.ident.projectId,
    restoredInDisposableDirectory:true,productionDataUntouched:true,integrityVerified:true,
    restoredBytes:saved.meta.dbBytes,tableCount,sha256:saved.meta.sha256};
 }finally{await rm(drillDir,{recursive:true,force:true})}
}
/** Offline maintenance: caller must stop all app containers before invoking. */
export async function runMaintenance({root,dataDir,backupDir,command,id,confirm=false}){
 root=resolve(root);dataDir=resolve(dataDir);backupDir=resolve(backupDir);
 await realDirectory(dataDir);await realDirectory(backupDir);offlineOnly(dataDir);
 const lock=join(dataDir,'maintenance.lock');
 await writeFile(lock,JSON.stringify({createdAt:new Date().toISOString(),command}),{flag:'wx',mode:0o600});
 try{
  if(command==='backup')return await saveBackup({root,dataDir,backupDir});
  if(command==='drill')return drillBackup({root,backupDir},id);
  if(command==='verify'){
   const {meta}=await checkBackup({root,backupDir},id);
   return {ok:true,operation:'verify',id,sha256:meta.sha256,createdAt:meta.createdAt};
  }
  if(command==='restore'){
   if(!confirm)fail('Restore requires --confirm and stopped application');
   const saved=await checkBackup({root,backupDir},id),source=join(dataDir,saved.ident.dbName);
   // Abort rather than silently discarding uncheckpointed WAL transactions.
   for(const ext of ['-wal','-shm'])if(existsSync(source+ext))fail('Database sidecar '+ext+' present; resolve before restore');
   const safety=existsSync(source)?await saveBackup({root,dataDir,backupDir}):null;
   await stageVerifiedDatabase(saved.dbPath,source,saved.meta);
   return {ok:true,operation:'restore',id,safetyBackupId:safety?.id||null,
     warning:'Review the restored database before restarting the service.'};
  }
  fail('Use backup | verify BACKUP_ID | drill BACKUP_ID | restore BACKUP_ID --confirm');
 }finally{await rm(lock,{force:true})}
}
const main=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(main){
 process.umask(0o077);
 runMaintenance({root:resolve(dirname(fileURLToPath(import.meta.url)),'..'),
  dataDir:process.env.DATA_DIR||'/app/data',backupDir:process.env.BACKUP_DIR||'/backups',
  command:process.argv[2],id:process.argv[3],confirm:process.argv.includes('--confirm')})
 .then(result=>console.log(JSON.stringify(result)))
 .catch(err=>{console.error('OSMANX MAINTENANCE: '+err.message);process.exitCode=1});
}
