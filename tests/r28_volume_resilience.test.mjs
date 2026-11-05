import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { parseStoredZip } from '../src/common/archive.mjs';
import { createZip } from '../src/common/zip.mjs';
import { exportDeploymentBundle } from '../src/studio/deployment.mjs';
import { migrationPlan, migrateVolumes, recoverVolumes, migrationStatus, verifyMigratedVolumes, volumeHelperSource } from '../templates/deploy/volume-migrate.mjs';

const source=resolve(import.meta.dirname,'..');
const sha=b=>createHash('sha256').update(b).digest('hex');
const id='32165498-1234-4123-8123-321654987654',oldCompose='oldr28test';
const compose='osmanx_'+id.replaceAll('-','').slice(0,12);
const domain='crm-test.example.com';
const project={id,type:'crm',industry:'restaurant',name:'R28 verification',modules:['auth','clients','tasks'],settings:{accent:'#386f61',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]};
async function unpack(bytes,dir){
 const m=parseStoredZip(bytes,{maxFiles:400,maxBytes:80*1024*1024});
 for(const [name,data] of m){await mkdir(dirname(join(dir,name)),{recursive:true});await writeFile(join(dir,name),data)}
 return m;
}
function runHelper(src,dst,op,dbName){
 const proc=spawnSync(process.execPath,['--no-warnings','-e',volumeHelperSource],{
   env:{...process.env,OSMANX_SOURCE_DIR:src,OSMANX_TARGET_DIR:dst||'',OSMANX_OPERATION:op,OSMANX_DB_NAME:dbName||''},
   timeout:10000,encoding:'utf8'});
 if(proc.status!==0)throw Error('Real filesystem helper: '+String(proc.stderr).slice(-500));
 return JSON.parse(proc.stdout.trim().split('\n').at(-1));
}
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'osmanx-r28-'));
 const old=join(dir,'old'),next=join(dir,'next'),volRoot=join(dir,'vols');
 await Promise.all([mkdir(old),mkdir(next),mkdir(volRoot)]);
 const newer=await exportDeploymentBundle(project,source,domain,{id:'33333333-3333-4333-8333-333333333333',sequence:1,snapshotSha256:sha(JSON.stringify(project)),createdAt:'2026-11-05T00:00:00Z'});
 await unpack(newer,next);
 const legacyFiles=parseStoredZip(await exportDeploymentBundle(project,source,domain),{maxFiles:400,maxBytes:80*1024*1024});
 const manifest=JSON.parse(legacyFiles.get('deploy/manifest.json').toString('utf8'));
 manifest.version=1;delete manifest.composeProject;
 for(const file of ['deploy/upgrade.mjs','deploy/volume-migrate.mjs','deploy/maintenance.mjs','deploy/verify-live.mjs']){legacyFiles.delete(file);delete manifest.files[file]}
 const y=Buffer.from(legacyFiles.get('compose.yaml').toString().replace(/^name: [^\n]+\n/,''));
 legacyFiles.set('compose.yaml',y);manifest.files['compose.yaml']=sha(y);
 legacyFiles.set('deploy/manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
 await unpack(createZip([...legacyFiles].map(([name,data])=>({name,data}))),old);
 const volumes=new Map(),busy=new Set(),references=new Set();
 for(const kind of ['app_data','caddy_data','caddy_config']){
   const path=join(volRoot,oldCompose+'_'+kind);await mkdir(path);
   if(kind==='app_data'){
     const db=new DatabaseSync(join(path,'crm.sqlite'));
     db.exec('CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
     db.prepare('INSERT INTO customers(name) VALUES(?)').run('Protected test data');db.close();
     await writeFile(join(path,'notes.txt'),'Keep this record');
   }else await writeFile(join(path,'dummy.cert'),'synthetic only: '+kind);
   volumes.set(oldCompose+'_'+kind,{Name:oldCompose+'_'+kind,Driver:'local',Labels:{'com.docker.compose.project':oldCompose,'com.docker.compose.volume':kind},path});
 }
 let failBackup=null,failRestore=0;
 const locate=x=>typeof x==='string'?volumes.get(x)?.path:x.directory;
 const adapter={
   inspect:async n=>volumes.get(n)||null,
   inUse:async n=>busy.has(n),anyContainer:async n=>references.has(n),helperReady:async()=>true,
   fingerprint:async(x,{dbName=null}={})=>runHelper(locate(x),null,'scan',dbName),
   copy:async(a,b,{dbName=null}={})=>{
     if(failBackup && typeof b==='object' && typeof a==='string' && a.endsWith('_'+failBackup)){
       failBackup=null;await writeFile(join(b.directory,'INCOMPLETE.tmp'),'do not trust');
       throw Error('simulated unclean power loss during backup');
     }
     if(failRestore>0&&typeof b==='string'){
       failRestore--;throw Error('simulated unclean power loss during volume restore');
     }
     return runHelper(locate(a),locate(b),'copy',dbName);
   },
   create:async(n,labels)=>{
     assert.ok(!volumes.has(n),'target must not exist');
     const path=join(volRoot,n);await mkdir(path);
     volumes.set(n,{Name:n,Driver:'local',Labels:labels,path});
   },
   remove:async n=>{
     assert.ok(volumes.has(n));assert.ok(!references.has(n));
     await rm(volumes.get(n).path,{recursive:true,force:true});volumes.delete(n);
   }
 };
 return {dir,old,next,volumes,adapter,oldApp:oldCompose+'_app_data',newApp:compose+'_app_data',
   failBackup:k=>{failBackup=k},failRestore:n=>{failRestore=n},busy, references,cleanup:()=>rm(dir,{recursive:true,force:true})};
}
const settings=f=>({legacyRoot:f.old,root:f.next,legacyProject:oldCompose,adapter:f.adapter});
const confirm={confirm:true,offlineConfirmed:true};
const restore={confirm:true,recreateTargets:true};

test('R2.8: offline volume acceptance compares real file metadata and SQLite across old, backup and target',{timeout:90000},async()=>{
 const f=await fixture();try{
  const migrated=await migrateVolumes({...settings(f),...confirm});assert.equal(migrated.phase,'completed');
  const accept=await verifyMigratedVolumes({root:f.next,adapter:f.adapter});
  assert.equal(accept.ok,true);assert.equal(accept.offlineVolumesVerified,true);
  assert.equal(accept.publicHttpsVerified,false);assert.equal(accept.volumes.length,3);
  const db=new DatabaseSync(join(f.volumes.get(f.newApp).path,'crm.sqlite'),{readOnly:true});
  assert.equal(db.prepare('SELECT name FROM customers').get().name,'Protected test data');db.close();
  assert.ok(f.volumes.has(f.oldApp));
 }finally{await f.cleanup()}
});

test('R2.8: interrupted partial backup requires explicit operator retry; incomplete copy is preserved',{timeout:90000},async()=>{
 const f=await fixture();try{
  f.failBackup('app_data');
  await assert.rejects(migrateVolumes({...settings(f),...confirm}),/power loss during backup/);
  assert.equal((await migrationStatus({root:f.next})).active.phase,'recovery-required');
  await assert.rejects(recoverVolumes({root:f.next,adapter:f.adapter,...restore}),/--retry-backups/);
  const done=await recoverVolumes({root:f.next,adapter:f.adapter,...restore,retryBackups:true});
  assert.equal(done.phase,'recovered');
  const backups=join(f.next,'.osmanx-volume-migration','snapshots',done.id);
  assert.ok((await readdir(backups)).some(n=>n.startsWith('incomplete-app_data-')));
  assert.equal((await verifyMigratedVolumes({root:f.next,adapter:f.adapter})).ok,true);
 }finally{await f.cleanup()}
});

test('R2.8: after a second snapshot fails, changing a previously sealed legacy volume blocks recovery',{timeout:90000},async()=>{
 const f=await fixture();try{
  f.failBackup('caddy_data');
  await assert.rejects(migrateVolumes({...settings(f),...confirm}),/power loss during backup/);
  const status=await migrationStatus({root:f.next});assert.ok(status.active.volumes[0].backup);
  await writeFile(join(f.volumes.get(f.oldApp).path,'notes.txt'),'legacy data unexpectedly changed');
  await assert.rejects(recoverVolumes({root:f.next,adapter:f.adapter,...restore,retryBackups:true}),/original volume changed/);
  assert.ok(!f.volumes.has(f.newApp),'no new app_data volume should be created');
 }finally{await f.cleanup()}
});

test('R2.8: postcopy corruption and reused target labels cannot pass offline acceptance',{timeout:90000},async()=>{
 const f=await fixture();try{
  await migrateVolumes({...settings(f),...confirm});
  await writeFile(join(f.volumes.get(f.newApp).path,'notes.txt'),'tampered');
  await assert.rejects(verifyMigratedVolumes({root:f.next,adapter:f.adapter}),/Post-migration data discrepancy/);
  await writeFile(join(f.volumes.get(f.newApp).path,'notes.txt'),'Keep this record');
  f.volumes.get(f.newApp).Labels['io.osmanx.migration-id']='forged';
  await assert.rejects(verifyMigratedVolumes({root:f.next,adapter:f.adapter}),/not owned by this migration/);
 }finally{await f.cleanup()}
});

test('R2.8: busy application is not accepted as an offline verified migration',{timeout:90000},async()=>{
 const f=await fixture();try{
  await migrateVolumes({...settings(f),...confirm});
  f.busy.add(f.newApp);
  await assert.rejects(verifyMigratedVolumes({root:f.next,adapter:f.adapter}),/stacks stopped/);
 }finally{await f.cleanup()}
});

test('R2.8: forged journal volume path is rejected before any target deletion',{timeout:90000},async()=>{
 const f=await fixture();try{
  f.failRestore(1);
  await assert.rejects(migrateVolumes({...settings(f),...confirm}),/power loss during volume restore/);
  const path=join(f.next,'.osmanx-volume-migration','active.json');
  const journal=JSON.parse(await readFile(path,'utf8'));
  journal.volumes[0].kind='../../unexpected-secret-folder';
  await writeFile(path,JSON.stringify(journal));
  await assert.rejects(recoverVolumes({root:f.next,adapter:f.adapter,...restore}),/Unexpected or repeated volume kind/);
  assert.ok(f.volumes.has(f.newApp),'existing volume was not deleted on forged journal');
 }finally{await f.cleanup()}
});

test('R2.8: interrupted restore still reconstructs original real SQLite from sealed snapshot',{timeout:90000},async()=>{
 const f=await fixture();try{
  f.failRestore(1);
  await assert.rejects(migrateVolumes({...settings(f),...confirm}),/power loss during volume restore/);
  const done=await recoverVolumes({root:f.next,adapter:f.adapter,...restore});
  assert.equal(done.phase,'recovered');
  assert.equal((await verifyMigratedVolumes({root:f.next,adapter:f.adapter})).volumes.length,3);
  const db=new DatabaseSync(join(f.volumes.get(f.newApp).path,'crm.sqlite'),{readOnly:true});
  assert.equal(db.prepare('SELECT name FROM customers').get().name,'Protected test data');db.close();
 }finally{await f.cleanup()}
});

test('R2.8: exported client includes the new offline verify and explicit backup retry controls',{timeout:90000},async()=>{
 const f=await fixture();try{
  const cli=await readFile(join(f.next,'deploy/volume-migrate.mjs'),'utf8');
  assert.match(cli,/verifyMigratedVolumes/);
  assert.match(cli,/--retry-backups/);
  const state=await migrationStatus({root:f.next});assert.deepEqual(state,{active:null,history:[]});
  await assert.rejects(verifyMigratedVolumes({root:f.next,adapter:f.adapter}),/ENOENT|No such file|not found/);
 }finally{await f.cleanup()}
});
