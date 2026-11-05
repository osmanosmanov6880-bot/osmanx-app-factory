import { backup as sqliteBackup, DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { acquireLock } from '../common/maintenance.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const requireTruth=(v,m)=>{if(!v)throw Error(m);};
const getId=()=>new Date().toISOString().replace(/\D/g,'').slice(0,14)+'-'+randomUUID().slice(0,8);
const checkId=v=>{requireTruth(typeof v==='string'&&/^\d{14}-[a-f0-9]{8}$/.test(v),'Invalid backup identifier');return v;};
async function checkDatabase(path){
 const db=new DatabaseSync(path,{readOnly:true});
 try{requireTruth(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok','Database integrity check failed');
     requireTruth(db.prepare('PRAGMA foreign_key_check').all().length===0,'Foreign-key integrity check failed');}
 finally{db.close();}
}
async function projectId(root){
 const project=JSON.parse(await readFile(join(root,'config/project.json'),'utf8'));
 requireTruth(project.type==='site'&&/^[a-f0-9-]{36}$/.test(project.id),'Unsupported standalone project');
 return project.id;
}
async function internalBackup(root,data){
 const original=join(data,'site.sqlite');requireTruth(existsSync(original),'Site database is missing');
 const dir=join(data,'backups',getId());await mkdir(dir,{recursive:true,mode:0o700});
 const path=join(dir,'site.sqlite');
 const db=new DatabaseSync(original);
 try{await sqliteBackup(db,path);}finally{db.close();}
 await checkDatabase(path);
 const meta={format:'osmanx-site-backup',version:1,projectId:await projectId(root),createdAt:new Date().toISOString(),sha256:sha(await readFile(path))};
 await writeFile(join(dir,'backup.json'),JSON.stringify(meta,null,2)+'\n',{mode:0o600});
 return {id:basename(dir),path,meta};
}
async function checkBackup(root,data,bid){
 const dir=join(data,'backups',checkId(bid));
 const meta=JSON.parse(await readFile(join(dir,'backup.json'),'utf8'));
 requireTruth(meta.format==='osmanx-site-backup'&&meta.version===1,'Unsupported backup format');
 requireTruth(meta.projectId===await projectId(root),'Backup belongs to another site');
 const path=join(dir,'site.sqlite');requireTruth(sha(await readFile(path))===meta.sha256,'Backup checksum mismatch');
 await checkDatabase(path);return {path,meta};
}
export async function runSiteBackupCommand(root,command,args=[]){
 const data=resolve(process.env.DATA_DIR||join(root,'data'));
 const release=acquireLock(data,'maintenance');
 try{
  if(command==='backup')return await internalBackup(root,data);
  if(command==='verify'){
   const {meta}=await checkBackup(root,data,args[0]);return {verified:args[0],createdAt:meta.createdAt};
  }
  if(command==='restore'){
   requireTruth(args[1]==='--confirm','Restoration requires explicit --confirm');
   const saved=await checkBackup(root,data,args[0]);
   // A recovery point is always saved before restoring the selected backup.
   const safety=await internalBackup(root,data);
   const dest=join(data,'site.sqlite'),temp=dest+'.restore-'+randomUUID();
   try{
     await writeFile(temp,await readFile(saved.path),{mode:0o600});
     await checkDatabase(temp);
     await rename(temp,dest);
   }finally{await rm(temp,{force:true});}
   return {restored:args[0],safetyBackup:safety.id};
  }
  throw Error('Usage: node ops.mjs backup | verify BACKUP_ID | restore BACKUP_ID --confirm');
 }finally{release();}
}
