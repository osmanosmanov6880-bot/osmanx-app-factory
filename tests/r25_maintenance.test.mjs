import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {runMaintenance} from '../templates/deploy/maintenance.mjs';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const id='12345678-1234-4234-8234-1234567890ab';
const digest=v=>createHash('sha256').update(v).digest('hex');
async function sandbox(type){
 const base=await mkdtemp(join(tmpdir(),'osmanx-r25-'));
 const app=join(base,'app'),data=join(base,'data'),backups=join(base,'backups');
 await Promise.all([mkdir(join(app,'config'),{recursive:true}),mkdir(data),mkdir(backups)]);
 await writeFile(join(app,'config/project.json'),JSON.stringify({id,type}));
 const dbFile=join(data,type==='site'?'site.sqlite':'crm.sqlite');
 const db=new DatabaseSync(dbFile);
 db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY,value TEXT NOT NULL);');
 db.prepare('INSERT INTO notes(value) VALUES(?)').run('important-client-data');
 db.close();
 return {app,data,backups,dbFile,base};
}
function val(file){const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare('SELECT value FROM notes WHERE id=1').get()?.value}finally{db.close()}}
function set(file,value){const db=new DatabaseSync(file);try{db.prepare('UPDATE notes SET value=? WHERE id=1').run(value)}finally{db.close()}}

test('R2.5: offline backups verify integrity, detect tampering and restore with safety copy, CRM and site',{timeout:30000},async()=>{
 for(const type of ['crm','site']){
  const ctx=await sandbox(type),opts={root:ctx.app,dataDir:ctx.data,backupDir:ctx.backups};
  try{
   const b=await runMaintenance({...opts,command:'backup'});
   assert.equal(b.ok,true);assert.match(b.id,/^\d{14}-[0-9a-f]{12}$/);
   assert.equal((await stat(join(ctx.backups,b.id))).mode&0o077,0);
   assert.equal((await stat(join(ctx.backups,b.id,type==='site'?'site.sqlite':'crm.sqlite'))).mode&0o077,0);
   const verified=await runMaintenance({...opts,command:'verify',id:b.id});
   assert.equal(verified.sha256,b.sha256);
   set(ctx.dbFile,'modified-after-backup');
   await assert.rejects(runMaintenance({...opts,command:'restore',id:b.id}),/confirm/);
   assert.equal(val(ctx.dbFile),'modified-after-backup');
   const restored=await runMaintenance({...opts,command:'restore',id:b.id,confirm:true});
   assert.equal(restored.ok,true);assert.equal(val(ctx.dbFile),'important-client-data');
   assert.ok(restored.safetyBackupId);
   const safety=await runMaintenance({...opts,command:'verify',id:restored.safetyBackupId});
   assert.equal(safety.ok,true);
   const after=await runMaintenance({...opts,command:'backup'});
   const saved=join(ctx.backups,after.id,type==='site'?'site.sqlite':'crm.sqlite');
   await writeFile(saved,'bad-data');
   await assert.rejects(runMaintenance({...opts,command:'verify',id:after.id}),/hash mismatch/);
   await assert.rejects(runMaintenance({...opts,command:'restore',id:after.id,confirm:true}),/hash mismatch/);
   assert.equal(val(ctx.dbFile),'important-client-data');
  }finally{await rm(ctx.base,{recursive:true,force:true})}
 }
});

test('R2.5: abort maintenance if server lock, WAL, wrong backup project or symlink',{timeout:30000},async()=>{
 const ctx=await sandbox('crm'),opts={root:ctx.app,dataDir:ctx.data,backupDir:ctx.backups};
 try{
  await writeFile(join(ctx.data,'server.lock'),JSON.stringify({pid:99999}));
  await assert.rejects(runMaintenance({...opts,command:'backup'}),/server.lock/);
  await rm(join(ctx.data,'server.lock'));
  const first=await runMaintenance({...opts,command:'backup'});
  await writeFile(join(ctx.data,'crm.sqlite-wal'),'');
  await assert.rejects(runMaintenance({...opts,command:'restore',id:first.id,confirm:true}),/sidecar -wal/);
  await rm(join(ctx.data,'crm.sqlite-wal'));
  await writeFile(join(ctx.app,'config/project.json'),JSON.stringify({id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',type:'crm'}));
  await assert.rejects(runMaintenance({...opts,command:'verify',id:first.id}),/identity mismatch/);
  await writeFile(join(ctx.app,'config/project.json'),JSON.stringify({id,type:'crm'}));
  await symlink(join(ctx.backups,first.id),join(ctx.backups,'20261105120000-deadbeefabcd'));
  await assert.rejects(runMaintenance({...opts,command:'verify',id:'20261105120000-deadbeefabcd'}),/symlink/);
 }finally{await rm(ctx.base,{recursive:true,force:true})}
});

test('R2.5: deployment export creates stable Compose identity and independently hashed offline maintenance package',{timeout:30000},async()=>{
 for(const type of ['crm','site']){
  const project={id,name:'R25 Test',type,industry:type==='site'?'business':'restaurant',
   modules:type==='site'?['auth','cms','leads']:['auth','clients'],
   settings:{accent:'#386f61',primaryAction:'navigate_overview',currency:'RUB'},pages:[],entities:[],automationPresets:[]};
  const bundle=await exportDeploymentBundle(project,root,'client.example.org');
  const entries=parseStoredZip(bundle,{maxFiles:350,maxBytes:60*1024*1024});
  const meta=JSON.parse(entries.get('deploy/manifest.json'));
  assert.equal(meta.version,2);
  assert.equal(meta.composeProject,'osmanx_'+id.replaceAll('-','').slice(0,12));
  assert.match(entries.get('compose.yaml').toString(),new RegExp('name: '+meta.composeProject));
  assert.match(entries.get('compose.yaml').toString(),/maintenance:/);
  assert.match(entries.get('compose.yaml').toString(),/network_mode: "none"/);
  assert.match(entries.get('compose.yaml').toString(),/\.\/backups:\/backups/);
  assert.equal(digest(entries.get('deploy/maintenance.mjs')),meta.files['deploy/maintenance.mjs']);
  assert.ok(entries.get('deploy/DEPLOY.md').toString().includes('restore BACKUP_ID --confirm'));
  assert.ok(!entries.has('.env'));
 }
});
