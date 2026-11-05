import { backup, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, rm, readdir } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { acquireLock } from '../src/common/maintenance.mjs';

const root=resolve(import.meta.dirname,'..');
const data=resolve(process.env.DATA_DIR || join(root,'data'));
const backups=join(data,'backups-factory');
const digest=b=>createHash('sha256').update(b).digest('hex');
function assert(ok,message){if(!ok)throw Error(message);}
async function checksum(path){return digest(await readFile(path));}
async function verifySqlite(path){
  const db=new DatabaseSync(path,{readOnly:true});
  try{
    assert(db.prepare('PRAGMA integrity_check').get()?.integrity_check==='ok','SQLite integrity failure: '+path);
    assert(db.prepare('PRAGMA foreign_key_check').all().length===0,'SQLite foreign key failure: '+path);
  }finally{db.close();}
}
const validName=name=>name==='studio.sqlite'||/^projects\/[0-9a-f-]{36}\.sqlite$/.test(name);
async function backupCurrent(){
  assert(existsSync(join(data,'studio.sqlite')),'Studio database missing');
  const id=new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14)+'-'+randomUUID().slice(0,8);
  const dir=join(backups,id);await mkdir(dir,{recursive:true,mode:0o700});
  const names=['studio.sqlite'];
  if(existsSync(join(data,'projects')))for(const name of await readdir(join(data,'projects'))){
    if(/^[0-9a-f-]{36}\.sqlite$/.test(name))names.push('projects/'+name);
  }
  const hashes={};
  for(const name of names){
    const target=join(dir,name);await mkdir(dirname(target),{recursive:true,mode:0o700});
    const db=new DatabaseSync(join(data,name));try{await backup(db,target);}finally{db.close();}
    await verifySqlite(target);hashes[name]=await checksum(target);
  }
  const manifest={format:'osmanx-factory-backup',version:1,createdAt:new Date().toISOString(),files:hashes};
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  return {id,dir,manifest};
}
async function verifyBackup(id){
  assert(typeof id==='string'&&/^[0-9]{14}-[a-f0-9]{8}$/.test(id),'Invalid backup ID');
  const dir=join(backups,id);
  const manifest=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8'));
  assert(manifest.format==='osmanx-factory-backup'&&manifest.version===1,'Invalid factory backup');
  assert(Object.hasOwn(manifest.files,'studio.sqlite'),'Studio snapshot missing');
  for(const [name,hash] of Object.entries(manifest.files)){
    assert(validName(name)&&/^[a-f0-9]{64}$/.test(hash),'Invalid backup file entry');
    const file=join(dir,name);
    assert(await checksum(file)===hash,'Snapshot checksum mismatch: '+name);
    await verifySqlite(file);
  }
  return {dir,manifest};
}
async function applyBackup(entry){
  for(const name of Object.keys(entry.manifest.files)){
    const source=join(entry.dir,name),target=join(data,name);
    await mkdir(dirname(target),{recursive:true,mode:0o700});
    const pending=target+'.restore-'+randomUUID();
    try{await writeFile(pending,await readFile(source),{mode:0o600});await rename(pending,target);}
    finally{await rm(pending,{force:true});}
    await rm(target+'-wal',{force:true});await rm(target+'-shm',{force:true});
    await verifySqlite(target);
  }
}
async function main(){
  const [command,id,...flags]=process.argv.slice(2);
  if(!['backup','verify','restore'].includes(command)){
    console.log('Factory maintenance: backup | verify <backup-id> | restore <backup-id> --confirm');return;
  }
  if(command==='verify'){
    const entry=await verifyBackup(id);console.log(JSON.stringify({ok:true,createdAt:entry.manifest.createdAt,databases:Object.keys(entry.manifest.files).length}));return;
  }
  if(command==='restore')assert(flags.includes('--confirm'),'Use --confirm to restore, replacing current records');
  const unlock=acquireLock(data,'maintenance');
  try{
    if(command==='backup'){
      const r=await backupCurrent();console.log(JSON.stringify({ok:true,backupId:r.id,databases:Object.keys(r.manifest.files).length}));return;
    }
    const old=await verifyBackup(id);
    const safety=await backupCurrent();
    try{await applyBackup(old);}catch(e){await applyBackup({dir:safety.dir,manifest:safety.manifest});throw e;}
    console.log(JSON.stringify({ok:true,restored:id,safetyBackup:safety.id}));
  }finally{unlock();}
}
main().catch(e=>{console.error('[OSMANX FACTORY BACKUP] '+e.message);process.exitCode=1;});
