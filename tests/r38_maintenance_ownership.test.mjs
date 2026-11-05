import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { preserveDatabaseOwner, runMaintenance } from '../templates/deploy/maintenance.mjs';

const identity='12345678-1234-4234-8234-1234567890ab';
const fileRecord=(uid,gid,kind='file')=>({uid,gid,isFile:()=>kind==='file',isDirectory:()=>kind==='dir',isSymbolicLink:()=>kind==='link'});

test('R3.8: root-run restore must chown staged inode to original unprivileged owner',async()=>{
 const calls=[];
 const r=await preserveDatabaseOwner('/data/crm.sqlite','/data/crm.sqlite.incoming',{
  inspect:async()=>fileRecord(1000,1000),uid:0,gid:0,
  setOwner:async(...args)=>calls.push(args)
 });
 assert.equal(r.ownerPreserved,true);
 assert.deepEqual(calls,[['/data/crm.sqlite.incoming',1000,1000]]);
});

test('R3.8: unprivileged maintenance avoids unnecessary chown; first-time restore inherits data directory owner',async()=>{
 let called=0;
 await preserveDatabaseOwner('/data/crm.sqlite','/data/pending',{
  inspect:async()=>fileRecord(1000,1000),uid:1000,gid:1000,
  setOwner:async()=>{called++}
 });
 assert.equal(called,0);
 const calls=[];
 const r=await preserveDatabaseOwner('/data/crm.sqlite','/data/pending',{
  inspect:async path=>{if(path==='/data/crm.sqlite')throw Object.assign(Error('missing'),{code:'ENOENT'});return fileRecord(1000,1000,'dir')},
  uid:0,gid:0,setOwner:async(...args)=>calls.push(args)
 });
 assert.equal(r.ownerPreserved,true);
 assert.deepEqual(calls,[['/data/pending',1000,1000]]);
});

test('R3.8: invalid DB owner, linked destination and failed chown refuse unsafe replacement',async()=>{
 for(const fake of [fileRecord(0,0,'link'),fileRecord(0,0,'dir'),fileRecord(-1,1)]){
  await assert.rejects(preserveDatabaseOwner('/data/crm.sqlite','/data/pending',{
    inspect:async()=>fake,uid:0,gid:0
  }),/regular database file|safe restore database owner/);
 }
 await assert.rejects(preserveDatabaseOwner('/data/crm.sqlite','/data/pending',{
   inspect:async()=>fileRecord(1000,1000),uid:0,gid:0,
   setOwner:async()=>{throw Object.assign(Error('not permitted'),{code:'EPERM'})}
 }),/not permitted/);
});

async function sandbox(){
 const base=await mkdtemp(join(tmpdir(),'osmanx-r38-'));
 const root=join(base,'app'),dataDir=join(base,'data'),backupDir=join(base,'backups');
 await mkdir(join(root,'config'),{recursive:true});await mkdir(dataDir);await mkdir(backupDir);
 await writeFile(join(root,'config','project.json'),JSON.stringify({id:identity,type:'crm'}));
 const path=join(dataDir,'crm.sqlite');const db=new DatabaseSync(path);
 db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO notes(value) VALUES (\'original\');');db.close();
 return {base,root,dataDir,backupDir,path};
}
function note(path){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT value FROM notes WHERE id=1').get().value}finally{db.close()}}

test('R3.8: real SQLite backup and restore retain owner, restrictive mode, and contents',async()=>{
 const c=await sandbox();
 try{
  await chmod(c.path,0o600);const before=await stat(c.path);
  const backup=await runMaintenance({...c,command:'backup'});
  const db=new DatabaseSync(c.path);db.exec("UPDATE notes SET value='modified'");db.close();
  const restored=await runMaintenance({...c,command:'restore',id:backup.id,confirm:true});
  assert.equal(restored.ok,true);
  assert.equal(note(c.path),'original');
  const after=await stat(c.path);
  assert.equal(after.uid,before.uid);
  assert.equal(after.gid,before.gid);
  assert.equal(after.mode&0o777,0o600);
 }finally{await rm(c.base,{recursive:true,force:true})}
});

test('R3.8: restoring over a symlink refuses without touching outside database',async()=>{
 const c=await sandbox();
 try{
  const backup=await runMaintenance({...c,command:'backup'});
  const outside=join(c.base,'outside.sqlite');
  const original=await readFile(c.path);await writeFile(outside,original);
  await rm(c.path);await symlink(outside,c.path);
  await assert.rejects(runMaintenance({...c,command:'restore',id:backup.id,confirm:true}),/regular database file|File is missing or symlink/);
  assert.deepEqual(await readFile(outside),original);
 }finally{await rm(c.base,{recursive:true,force:true})}
});
