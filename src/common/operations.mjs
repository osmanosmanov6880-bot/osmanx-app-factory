import { backup, DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, rename, rm, stat, lstat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, basename, sep } from 'node:path';
import { parseStoredZip } from './archive.mjs';
import { acquireLock } from './maintenance.mjs';
import { crmDb } from '../crm/db.mjs';

const sha = buf => createHash('sha256').update(buf).digest('hex');
const safeFile = name => typeof name==='string' && (
  /^(src\/(common|crm)\/[a-z0-9_-]+\.(mjs|sql)|public\/crm\/[a-z0-9_-]+\.(js|css|html))$/.test(name) ||
  ['run.mjs','ops.mjs','config/project.json','package.json','README.md','.env.example','.gitignore'].includes(name)
);
function assert(condition,message){if(!condition)throw Error(message);}
async function readJson(file){return JSON.parse(await readFile(file,'utf8'));}
async function bufferSha(file){return sha(await readFile(file));}
async function validateSafeTarget(root,name){
  assert(safeFile(name),'Unsafe managed path: '+name);
  const target=resolve(root,name);assert(target.startsWith(resolve(root)+sep),'Escaped root');
  let part=resolve(root);
  for(const piece of name.split('/')){
    part=join(part,piece);
    try{const s=await lstat(part);assert(!s.isSymbolicLink(),'Symlinks forbidden in managed paths: '+name);}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  return target;
}
function validateManifest(obj,files){
  assert(obj?.format==='osmanx-standalone-release'&&obj.manifestVersion===1,'Unsupported package format');
  assert(/^[0-9a-f-]{36}$/.test(obj.projectId||''),'Invalid project ID');
  assert(obj.applicationVersion==='0.4.0','Unsupported application engine: only R0.4 generated updates');
  assert(Number.isInteger(obj.release?.sequence)&&obj.release.sequence>=0,'Invalid release sequence');
  assert(obj.files&&typeof obj.files==='object'&&!Array.isArray(obj.files),'Missing file hashes');
  const names=Object.keys(obj.files);
  assert(names.length>10&&names.length<250,'Unexpected file count');
  assert(names.length===files.size-1 && files.has('manifest.json'),'Manifest file count mismatch');
  for(const name of names){
    assert(safeFile(name),'Invalid package path: '+name);
    assert(files.has(name),'Missing package entry: '+name);
    assert(/^[0-9a-f]{64}$/.test(obj.files[name])&&sha(files.get(name))===obj.files[name],'Checksum mismatch: '+name);
  }
  assert(names.includes('config/project.json')&&names.includes('src/crm/db.mjs')&&names.includes('ops.mjs'),'Incomplete release package');
  const project=JSON.parse(files.get('config/project.json').toString('utf8'));
  assert(project?.id===obj.projectId,'Project identity mismatch');
  assert(sha(JSON.stringify(project))===obj.snapshotSha256,'Project snapshot hash mismatch');
  assert(Array.isArray(project.entities)&&Array.isArray(project.pages)&&Array.isArray(project.modules),'Incomplete project configuration');
  return project;
}
async function loadPackage(path){
  const entries=parseStoredZip(await readFile(path));
  assert(entries.has('manifest.json'),'Missing manifest.json');
  const manifest=JSON.parse(entries.get('manifest.json').toString('utf8'));
  const project=validateManifest(manifest,entries);
  return {entries,manifest,project};
}
async function installed(root){
  const manifest=await readJson(join(root,'manifest.json'));
  const files=new Map();
  for(const name of Object.keys(manifest.files||{})){
    const target=await validateSafeTarget(root,name);
    files.set(name,await readFile(target));
  }
  files.set('manifest.json',await readFile(join(root,'manifest.json')));
  const project=validateManifest(manifest,files);
  return {manifest,project};
}
async function assertCleanInstall(root,manifest){
  for(const [name,digest] of Object.entries(manifest.files)){
    const target=await validateSafeTarget(root,name);
    assert(await bufferSha(target)===digest,'Managed file modified locally: '+name);
  }
}
function dbFile(root){return resolve(process.env.DATA_DIR || join(root,'data'),'crm.sqlite');}
function dataDir(root){return dirname(dbFile(root));}
function backupId(){return new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14)+'-'+randomUUID().slice(0,8);}
async function checkDbIntegrity(path){
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    const result=db.prepare('PRAGMA integrity_check').all();
    assert(result.length===1&&result[0].integrity_check==='ok','SQLite integrity_check failed');
    const fk=db.prepare('PRAGMA foreign_key_check').all();
    assert(fk.length===0,'SQLite foreign_key_check failed');
  }finally{db.close();}
}
async function copyAtomic(data,target){
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  const temporary=target+'.pending-'+randomUUID();
  try{await writeFile(temporary,data,{mode:0o600});await rename(temporary,target);}finally{await rm(temporary,{force:true});}
}
async function createBackup(root,{full=false}={}){
  const dbPath=dbFile(root);
  assert(existsSync(dbPath),'No CRM database. Start and initialize the CRM first');
  const {manifest}=await installed(root);
  const dir=join(dataDir(root),'backups',backupId());
  await mkdir(dir,{recursive:true,mode:0o700});
  const output=join(dir,'crm.sqlite');
  const db=new DatabaseSync(dbPath);
  try{await backup(db,output);}finally{db.close();}
  await checkDbIntegrity(output);
  const meta={format:'osmanx-backup',version:1,projectId:manifest.projectId,createdAt:new Date().toISOString(),
    releaseSequence:manifest.release.sequence,dbSha256:await bufferSha(output),full,files:{}};
  if(full){
    for(const name of [...Object.keys(manifest.files),'manifest.json']){
      const src=await validateSafeTarget(root,name==='manifest.json'?'README.md':name);
      const path=name==='manifest.json'?join(root,'manifest.json'):src;
      const content=await readFile(path);
      const dest=join(dir,'managed',name);
      await mkdir(dirname(dest),{recursive:true,mode:0o700});
      await writeFile(dest,content,{mode:0o600});meta.files[name]=sha(content);
    }
  }
  await writeFile(join(dir,'backup.json'),JSON.stringify(meta,null,2)+'\n',{mode:0o600});
  return {dir,id:basename(dir),meta};
}
function validateBackupId(value){assert(typeof value==='string'&&/^[0-9]{14}-[a-f0-9]{8}$/.test(value),'Invalid backup ID');return value;}
async function verifyBackup(root,id){
  const dir=join(dataDir(root),'backups',validateBackupId(id));
  const meta=await readJson(join(dir,'backup.json'));
  assert(meta.format==='osmanx-backup'&&meta.version===1,'Unrecognized backup');
  const {manifest}=await installed(root);
  assert(meta.projectId===manifest.projectId,'Backup project ID mismatch');
  const saved=join(dir,'crm.sqlite');
  assert(await bufferSha(saved)===meta.dbSha256,'Backup database hash mismatch');
  await checkDbIntegrity(saved);
  if(meta.full){
    const backedFiles=Object.keys(meta.files||{});
    assert(backedFiles.includes('manifest.json')&&backedFiles.includes('config/project.json'),'Incomplete code backup');
    for(const name of backedFiles){
      if(name!=='manifest.json')assert(safeFile(name),'Unsafe backup file');
      assert(await bufferSha(join(dir,'managed',name))===meta.files[name],'Backup code hash mismatch: '+name);
    }
  }
  return {dir,meta};
}
async function restoreVerified(root,backupData){
  const {dir,meta}=backupData;
  const dbPath=dbFile(root);
  // Snapshot restores code + DB together; plain backup restores only the DB.
  if(meta.full){
    const current=await installed(root);
    const previous=await readJson(join(dir,'managed','manifest.json'));
    const savedFiles=new Map();
    for(const name of Object.keys(previous.files||{})){
      assert(safeFile(name),'Unsafe restored path');
      savedFiles.set(name,await readFile(join(dir,'managed',name)));
    }
    validateManifest(previous,new Map([...savedFiles,['manifest.json',await readFile(join(dir,'managed','manifest.json'))]]));
    // Delete only added generator-managed files, not local user files or data.
    for(const name of Object.keys(current.manifest.files)){
      if(!savedFiles.has(name))await rm(await validateSafeTarget(root,name),{force:true});
    }
    for(const [name,bytes] of savedFiles)await copyAtomic(bytes,await validateSafeTarget(root,name));
    await copyAtomic(await readFile(join(dir,'managed','manifest.json')),join(root,'manifest.json'));
  }
  const old=await readFile(join(dir,'crm.sqlite'));
  await copyAtomic(old,dbPath);
  await rm(dbPath+'-wal',{force:true});await rm(dbPath+'-shm',{force:true});
  await checkDbIntegrity(dbPath);
}
async function plan(root,updatePath){
  const current=await installed(root);
  const next=await loadPackage(updatePath);
  assert(next.manifest.projectId===current.manifest.projectId,'Refusing update from another project');
  assert(next.manifest.release.sequence>current.manifest.release.sequence,'Release must be newer than installed version');
  await assertCleanInstall(root,current.manifest);
  for(const name of Object.keys(next.manifest.files)){
    const target=await validateSafeTarget(root,name);
    if(!Object.hasOwn(current.manifest.files,name)&&existsSync(target))throw Error('New package would overwrite an unmanaged file: '+name);
  }
  const oldSchema=new Map((current.project.entities||[]).map(e=>[e.slug,e]));
  const entityChanges=[];
  for(const ent of next.project.entities){
    const before=oldSchema.get(ent.slug);
    entityChanges.push({entity:ent.slug,change:before?'additive-or-metadata':'new',newFields:ent.fields.filter(f=>!before?.fields.some(old=>old.key===f.key)).map(f=>f.key)});
  }
  const dbPath=dbFile(root);
  if(existsSync(dbPath)){
    const tmp=join(dataDir(root),'preflight-'+randomUUID()+'.sqlite');
    const source=new DatabaseSync(dbPath);
    try{await backup(source,tmp);}finally{source.close();}
    try{
      const copy=crmDb(tmp,next.project.entities);copy.close();
      await checkDbIntegrity(tmp);
    }finally{await rm(tmp,{force:true});await rm(tmp+'-wal',{force:true});await rm(tmp+'-shm',{force:true});}
  }
  return {current,next,summary:{projectId:current.manifest.projectId,from:current.manifest.release.sequence,
    to:next.manifest.release.sequence,entityChanges,files:Object.keys(next.manifest.files).length,
    backupRequired:true,localEdits:'none'}};
}
async function installUpdate(root,updatePath){
  const checked=await plan(root,updatePath);
  const backupData=await createBackup(root,{full:true});
  const marker=join(dataDir(root),'update-in-progress.json');
  await writeFile(marker,JSON.stringify({backupId:backupData.id,createdAt:new Date().toISOString()}),{mode:0o600,flag:'wx'});
  try{
    for(const [name,buffer] of checked.next.entries){
      if(name==='manifest.json')continue;
      await copyAtomic(buffer,await validateSafeTarget(root,name));
    }
    // Apply additive migration before publishing the new manifest.
    const db=crmDb(dbFile(root),checked.next.project.entities);db.close();
    await checkDbIntegrity(dbFile(root));
    await copyAtomic(checked.next.entries.get('manifest.json'),join(root,'manifest.json'));
    await rm(marker,{force:true});
    return {backupId:backupData.id,from:checked.summary.from,to:checked.summary.to};
  }catch(error){
    try{
      // Code may be partially swapped: restore directly using verified snapshot without trusting installed manifest.
      await restoreFromInterruptedBackup(root,backupData);
      await rm(marker,{force:true});
    }catch(rollbackError){error.message+='; automatic rollback failed: '+rollbackError.message+' (run recover)';}
    throw error;
  }
}
async function restoreFromInterruptedBackup(root,{dir,meta}){
  for(const name of Object.keys(meta.files||{})){
    if(name==='manifest.json')continue;
    await copyAtomic(await readFile(join(dir,'managed',name)),await validateSafeTarget(root,name));
  }
  const savedManifest=await readJson(join(dir,'managed','manifest.json'));
  const newManifestPath=join(root,'manifest.json');
  let currentManifest=null;
  try{currentManifest=await readJson(newManifestPath);}catch{}
  if(currentManifest){
    for(const name of Object.keys(currentManifest.files||{}))if(!Object.hasOwn(savedManifest.files,name)&&safeFile(name))await rm(await validateSafeTarget(root,name),{force:true});
  }
  await copyAtomic(await readFile(join(dir,'managed','manifest.json')),newManifestPath);
  await copyAtomic(await readFile(join(dir,'crm.sqlite')),dbFile(root));
  await rm(dbFile(root)+'-wal',{force:true});await rm(dbFile(root)+'-shm',{force:true});
  await checkDbIntegrity(dbFile(root));
}
export async function runOperation(root,args){
  const [command,arg,...flags]=args;
  const commands=['backup','verify','plan','update','restore','recover'];
  if(!commands.includes(command)){
    console.log('OSMANX CRM Operations R0.4');
    console.log('backup | verify <backup-id> | plan <new-release.zip> | update <new-release.zip> --confirm | restore <backup-id> --confirm | recover --confirm');
    return;
  }
  if(command==='verify'){
    const r=await verifyBackup(root,arg);console.log(JSON.stringify({ok:true,backup:r.meta.createdAt,release:r.meta.releaseSequence}));return;
  }
  if(command==='plan'){
    assert(arg,'Specify a release ZIP');console.log(JSON.stringify((await plan(root,resolve(arg))).summary,null,2));return;
  }
  const confirmed=args.includes('--confirm');
  if(['update','restore','recover'].includes(command))assert(confirmed,'Add --confirm after checking the plan and backup');
  const release=acquireLock(dataDir(root),'maintenance');
  try{
    const marker=join(dataDir(root),'update-in-progress.json');
    if(command==='recover'){
      assert(existsSync(marker),'No interrupted upgrade found');
      const record=await readJson(marker);
      const b=join(dataDir(root),'backups',validateBackupId(record.backupId));
      const meta=await readJson(join(b,'backup.json'));
      await restoreFromInterruptedBackup(root,{dir:b,meta});
      await rm(marker,{force:true});
      console.log('Recovered from interrupted upgrade');return;
    }
    assert(!existsSync(marker),'Interrupted upgrade found: run recover --confirm first');
    if(command==='backup'){
      const value=await createBackup(root,{full:false});console.log(JSON.stringify({ok:true,backupId:value.id,sha256:value.meta.dbSha256}));return;
    }
    if(command==='restore'){
      const target=await verifyBackup(root,arg);
      const safety=await createBackup(root,{full:true});
      try{await restoreVerified(root,target);}catch(err){await restoreFromInterruptedBackup(root,safety);throw err;}
      console.log(JSON.stringify({ok:true,restored:arg,previousStateBackup:safety.id}));return;
    }
    if(command==='update'){
      assert(arg,'Specify a release ZIP');
      const result=await installUpdate(root,resolve(arg));
      console.log(JSON.stringify({ok:true,...result}));return;
    }
  }finally{release();}
}
