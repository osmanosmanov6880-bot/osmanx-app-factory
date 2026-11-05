import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runMaintenance} from '../templates/deploy/maintenance.mjs';
const id='f2233445-0a31-43bb-a877-335588990022';
async function fixture(type){
 const base=await mkdtemp(join(tmpdir(),'osmanx-r32-drill-'));const app=join(base,'app');
 const dataDir=join(base,'data'),backupDir=join(base,'backups');
 await mkdir(join(app,'config'),{recursive:true});await mkdir(dataDir);await mkdir(backupDir);
 await writeFile(join(app,'config/project.json'),JSON.stringify({id,type}));
 const dbPath=join(dataDir,type==='crm'?'crm.sqlite':'site.sqlite'),db=new DatabaseSync(dbPath);
 db.exec('CREATE TABLE records(x TEXT NOT NULL);');db.prepare('INSERT INTO records VALUES(?)').run('sensitive-fixture');db.close();
 const opts={root:app,dataDir,backupDir};return {base,opts,dbPath,backupDir,close:()=>rm(base,{recursive:true,force:true})};
}
const digest=b=>createHash('sha256').update(b).digest('hex');

test('R3.2 restore drill: CRM and website perform a real disposable SQLite restore, retaining production data',async()=>{
 for(const type of ['crm','site']){
  const f=await fixture(type);try{
   const backup=await runMaintenance({...f.opts,command:'backup'});
   const live=new DatabaseSync(f.dbPath);live.prepare('UPDATE records SET x=?').run('new-live-record');live.close();
   const original=digest(await readFile(f.dbPath));
   const result=await runMaintenance({...f.opts,command:'drill',id:backup.id});
   assert.equal(result.ok,true);assert.equal(result.integrityVerified,true);
   assert.equal(result.productionDataUntouched,true);assert.equal(result.sha256,backup.sha256);
   assert.equal(digest(await readFile(f.dbPath)),original);
   assert.equal(new DatabaseSync(f.dbPath,{readOnly:true}).prepare('SELECT x FROM records').get().x,'new-live-record');
   assert.equal((await readdir(f.backupDir)).some(x=>x.startsWith('.drill-')),false);
  }finally{await f.close()}
 }
});

test('R3.2 restore drill: tampered backup and active server lock fail without temporary leaks',async()=>{
 const f=await fixture('crm');try{
  const backup=await runMaintenance({...f.opts,command:'backup'});
  await writeFile(join(f.opts.dataDir,'server.lock'),'simulated-live');
  await assert.rejects(runMaintenance({...f.opts,command:'drill',id:backup.id}),/server.lock/);
  await rm(join(f.opts.dataDir,'server.lock'));
  await writeFile(join(f.backupDir,backup.id,'crm.sqlite'),'altered');
  await assert.rejects(runMaintenance({...f.opts,command:'drill',id:backup.id}),/hash mismatch/);
  assert.equal((await readdir(f.backupDir)).some(x=>x.startsWith('.drill-')),false);
 }finally{await f.close()}
});
