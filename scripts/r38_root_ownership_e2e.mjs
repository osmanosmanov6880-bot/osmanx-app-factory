/** Synthetic-only root-run maintenance privilege-boundary acceptance.
 * Use a root Docker container with --network none; no client data or host volumes.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,mkdir,writeFile,stat,chown,chmod,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMaintenance } from '../templates/deploy/maintenance.mjs';

if (!process.argv.includes('--confirm-synthetic')) {
 console.error('Refusing to run privileged fixture without --confirm-synthetic');
 process.exitCode=2;
} else if (process.platform!=='linux'||process.getuid?.()!==0) {
 console.error('Root-run ownership fixture requires an isolated root Linux container');
 process.exitCode=2;
} else {
 const base=await mkdtemp(join(tmpdir(),'osmanx-r38-root-fixture-'));
 try {
  for(const type of ['crm','site']) {
   const root=join(base,type,'app'),dataDir=join(base,type,'data'),backupDir=join(base,type,'backups');
   await mkdir(join(root,'config'),{recursive:true});await mkdir(dataDir);await mkdir(backupDir);
   await writeFile(join(root,'config','project.json'),JSON.stringify({id:randomUUID(),type}));
   const path=join(dataDir,type==='site'?'site.sqlite':'crm.sqlite');
   const db=new DatabaseSync(path);
   db.exec("CREATE TABLE acceptance(value TEXT);INSERT INTO acceptance VALUES('original')");db.close();
   // Simulate the deployed non-root application creating its private DB.
   await chown(path,65534,65534);await chmod(path,0o600);
   const before=await stat(path);assert.equal(before.uid,65534);
   const b=await runMaintenance({root,dataDir,backupDir,command:'backup'});
   assert.equal(b.ok,true);
   // Simulate data changed after a good signed deployment.
   const writable=new DatabaseSync(path);writable.exec("UPDATE acceptance SET value='changed'");writable.close();
   const restored=await runMaintenance({root,dataDir,backupDir,command:'restore',id:b.id,confirm:true});
   assert.equal(restored.ok,true);
   const after=await stat(path);
   assert.equal(after.uid,65534,'A root-run restore must preserve node app UID');
   assert.equal(after.gid,65534,'A root-run restore must preserve node app GID');
   assert.equal(after.mode&0o777,0o600,'Database must stay private');
   const verified=new DatabaseSync(path,{readOnly:true});
   try{assert.equal(verified.prepare('SELECT value FROM acceptance').get().value,'original')}
   finally{verified.close()}
  }
  console.log(JSON.stringify({ok:true,syntheticOnly:true,rootRestore:true,nonRootDatabaseOwnerPreserved:true,types:['crm','site']}));
 } catch(error) {
  console.error('R3.8 synthetic root restore failed: '+error.message);process.exitCode=1;
 } finally {
  await rm(base,{recursive:true,force:true});
 }
}
