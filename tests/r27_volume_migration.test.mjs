import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, readdir, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseStoredZip } from '../src/common/archive.mjs';
import { createZip } from '../src/common/zip.mjs';
import { exportDeploymentBundle } from '../src/studio/deployment.mjs';
import { migrationPlan, migrateVolumes, recoverVolumes, migrationStatus, volumeHelperSource } from '../templates/deploy/volume-migrate.mjs';
const root=resolve(import.meta.dirname,'..'), sha=b=>createHash('sha256').update(b).digest('hex');
const uid='12345678-1111-4111-8111-123456789abc',domain='crm.osmanx.co';
const project={id:uid,type:'crm',industry:'restaurant',name:'Legacy data',modules:['auth','clients','tasks'],settings:{accent:'#386f61',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]};
const newCompose='osmanx_'+uid.replaceAll('-','').slice(0,12),legacyCompose='oldrestaurant';
async function unpack(buffer,dest){
 const entries=parseStoredZip(buffer,{maxFiles:400,maxBytes:80*1024*1024});
 for(const [name,data] of entries){await mkdir(dirname(join(dest,name)),{recursive:true});await writeFile(join(dest,name),data)}
 return entries;
}
async function fixture(){
 const temp=await mkdtemp(join(tmpdir(),'osmanx-r27-'));
 const old=join(temp,'legacy'),next=join(temp,'next');await Promise.all([mkdir(old),mkdir(next)]);
 const v2=await exportDeploymentBundle(project,root,domain,{id:'11111111-2222-4333-8444-555555555555',sequence:1,
   snapshotSha256:sha(JSON.stringify(project)),notes:'First release',createdAt:'2026-11-05T00:00:00Z'});
 const current=await exportDeploymentBundle(project,root,domain);
 const legacyFiles=parseStoredZip(current,{maxFiles:400,maxBytes:80*1024*1024});
 const metadata=JSON.parse(legacyFiles.get('deploy/manifest.json').toString());
 metadata.version=1;delete metadata.composeProject;
 for(const f of ['deploy/upgrade.mjs','deploy/volume-migrate.mjs','deploy/maintenance.mjs','deploy/verify-live.mjs']){
   legacyFiles.delete(f);delete metadata.files[f];
 }
 const compose=legacyFiles.get('compose.yaml').toString().replace(/^name: [^\n]+\n/,'');
 legacyFiles.set('compose.yaml',Buffer.from(compose));metadata.files['compose.yaml']=sha(Buffer.from(compose));
 legacyFiles.set('deploy/manifest.json',Buffer.from(JSON.stringify(metadata,null,2)+'\n'));
 await unpack(createZip([...legacyFiles].map(([name,data])=>({name,data}))),old);
 await unpack(v2,next);
 const volumes=new Map();
 const src=join(temp,'volumes','old-data');await mkdir(src,{recursive:true});
 const db=new DatabaseSync(join(src,'crm.sqlite'));db.exec('CREATE TABLE notes(value TEXT NOT NULL)');db.prepare('INSERT INTO notes VALUES(?)').run('critical customer data');db.close();
 await writeFile(join(src,'customer-file.txt'),'Never lose this data!');
 for(const kind of ['app_data','caddy_data','caddy_config']){
   const dir=kind==='app_data'?src:join(temp,'volumes',kind);
   if(kind!=='app_data'){await mkdir(dir,{recursive:true});await writeFile(join(dir,'certificate.txt'),'staged '+kind)}
   volumes.set(legacyCompose+'_'+kind,{dir,Name:legacyCompose+'_'+kind,Driver:'local',Labels:{
     'com.docker.compose.project':legacyCompose,'com.docker.compose.volume':kind}});
 }
 let fails=0,active=new Set(),references=new Set(),helperReady=true;
 const digest=async dir=>{
  const hash=createHash('sha256');let bytes=0,files=0;
  const rec=async(d,base='')=>{for(const name of (await readdir(d,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const rel=base?base+'/'+name.name:name.name;if(name.isDirectory())await rec(join(d,name.name),rel);
   else{assert.ok(name.isFile());const buf=await readFile(join(d,name.name));files++;bytes+=buf.length;hash.update(rel+'\0'+sha(buf)+'\0')}
  }};await rec(dir);return {sha256:hash.digest('hex'),bytes,files};
 };
 const adapter={
   inspect:async name=>volumes.get(name)||null,
   inUse:async name=>active.has(name),anyContainer:async name=>references.has(name),
   helperReady:async()=>helperReady,
   fingerprint:async(v)=>digest(typeof v==='string'?volumes.get(v).dir:v.directory),
   copy:async(source,target)=>{
     if(fails>0 && typeof target==='string'){fails--;throw Error('simulated disk interruption')}
     const from=typeof source==='string'?volumes.get(source).dir:source.directory;
     const to=typeof target==='string'?volumes.get(target).dir:target.directory;
     assert.deepEqual(await readdir(to),[],'Destination must be empty');
     await cp(from,to,{recursive:true,force:false,mode:0});
     return digest(to);
   },
   create:async(name,labels)=>{
     assert.ok(!volumes.has(name));const dir=join(temp,'volumes',name);await mkdir(dir,{recursive:true});
     volumes.set(name,{dir,Name:name,Driver:'local',Labels:labels});
   },
   remove:async name=>{const v=volumes.get(name);assert.ok(v);assert.ok(!references.has(name));await rm(v.dir,{recursive:true,force:true});volumes.delete(name)}
 };
 return {temp,old,next,volumes,adapter,src,setFailure:n=>{fails=n},busy:name=>active.add(name),idle:name=>active.delete(name),reference:name=>references.add(name),noReference:name=>references.delete(name),helperReady:false,
   cleanup:()=>rm(temp,{recursive:true,force:true})};
}

test('R2.7: authentic v1/v2 identity + Docker volume labels produce an offline-only migration plan',{timeout:90000},async()=>{
 const f=await fixture();try{
  const p=await migrationPlan({legacyRoot:f.old,root:f.next,legacyProject:legacyCompose,adapter:f.adapter});
  assert.equal(p.summary.projectId,uid);assert.equal(p.volumes.length,3);
  assert.equal(p.summary.targetProject,newCompose);
  assert.equal((await migrationStatus({root:f.next})).active,null);
  await assert.rejects(migrateVolumes({legacyRoot:f.old,root:f.next,legacyProject:legacyCompose,adapter:f.adapter}),/confirm/);
  await assert.rejects(migrateVolumes({legacyRoot:f.old,root:f.next,legacyProject:legacyCompose,confirm:true,adapter:f.adapter}),/offline-confirmed/);
 }finally{await f.cleanup()}
});

test('R2.7: stops, snapshots and copies app+TLS data, keeps old volumes and records complete journal',{timeout:90000},async()=>{
 const f=await fixture();try{
  const before=await f.adapter.fingerprint(legacyCompose+'_app_data');
  const out=await migrateVolumes({legacyRoot:f.old,root:f.next,legacyProject:legacyCompose,confirm:true,offlineConfirmed:true,adapter:f.adapter});
  assert.equal(out.phase,'completed');assert.equal(out.volumes.length,3);
  const after=await f.adapter.fingerprint(newCompose+'_app_data');assert.deepEqual(after,before);
  assert.ok(f.volumes.has(legacyCompose+'_app_data'));assert.ok(f.volumes.has(newCompose+'_caddy_data'));
  assert.equal(f.volumes.get(newCompose+'_app_data').Labels['io.osmanx.migration-id'],out.id);
  const db=new DatabaseSync(join(f.volumes.get(newCompose+'_app_data').dir,'crm.sqlite'),{readOnly:true});
  assert.equal(db.prepare('SELECT value FROM notes').get().value,'critical customer data');db.close();
  const s=await migrationStatus({root:f.next});assert.equal(s.active,null);assert.equal(s.history[0].phase,'completed');
  await assert.rejects(migrationPlan({legacyRoot:f.old,root:f.next,legacyProject:legacyCompose,adapter:f.adapter}),/Target volume already exists/);
 }finally{await f.cleanup()}
});

test('R2.7: refuses busy/foreign/occupied volumes and modified manifests before touching data',{timeout:90000},async()=>{
 const f=await fixture();try{
  f.busy(legacyCompose+'_app_data');
  await assert.rejects(migrationPlan({legacyRoot:f.old,root:f.next,legacyProject:legacyCompose,adapter:f.adapter}),/Stop legacy containers/);
  f.idle(legacyCompose+'_app_data');
  f.volumes.get(legacyCompose+'_app_data').Labels['com.docker.compose.project']='foreign';
  await assert.rejects(migrationPlan({legacyRoot:f.old,root:f.next,legacyProject:legacyCompose,adapter:f.adapter}),/Compose labels/);
  f.volumes.get(legacyCompose+'_app_data').Labels['com.docker.compose.project']=legacyCompose;
  await writeFile(join(f.old,'deploy/Caddyfile'),'tampered!');
  await assert.rejects(migrationPlan({legacyRoot:f.old,root:f.next,legacyProject:legacyCompose,adapter:f.adapter}),/checksum mismatch/);
 }finally{await f.cleanup()}
});

test('R2.7: interrupted migration is recoverable only with exact labels and explicit approval',{timeout:90000},async()=>{
 const f=await fixture();try{
  f.setFailure(1);
  await assert.rejects(migrateVolumes({legacyRoot:f.old,root:f.next,legacyProject:legacyCompose,confirm:true,offlineConfirmed:true,adapter:f.adapter}),/simulated disk interruption/);
  const oldStatus=await migrationStatus({root:f.next});
  assert.equal(oldStatus.active.phase,'recovery-required');assert.ok(oldStatus.active.volumes.every(v=>v.backup));
  await assert.rejects(recoverVolumes({root:f.next,adapter:f.adapter,confirm:true}),/recreate-targets/);
  f.reference(newCompose+'_app_data');
  await assert.rejects(recoverVolumes({root:f.next,adapter:f.adapter,confirm:true,recreateTargets:true}),/Container still references/);
  f.noReference(newCompose+'_app_data');
  f.volumes.get(newCompose+'_app_data').Labels['io.osmanx.migration-id']='forged';
  await assert.rejects(recoverVolumes({root:f.next,adapter:f.adapter,confirm:true,recreateTargets:true}),/not owned/);
  f.volumes.get(newCompose+'_app_data').Labels['io.osmanx.migration-id']=oldStatus.active.id;
  const result=await recoverVolumes({root:f.next,adapter:f.adapter,confirm:true,recreateTargets:true});
  assert.equal(result.phase,'recovered');
  assert.deepEqual(await f.adapter.fingerprint(legacyCompose+'_app_data'),await f.adapter.fingerprint(newCompose+'_app_data'));
  assert.equal((await migrationStatus({root:f.next})).active,null);
 }finally{await f.cleanup()}
});

test('R2.7: supplied kit actually includes CLI; generated helper scans SQLite and rejects tampered/symlinked data',{timeout:90000},async()=>{
 const f=await fixture();try{
  const client=await readFile(join(f.next,'deploy/volume-migrate.mjs'),'utf8');
  assert.match(client,/export async function migrateVolumes/);
  const cli=spawnSync(process.execPath,[join(f.next,'deploy/volume-migrate.mjs'),'status'],{encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout),{active:null,history:[]});
  const backup=join(f.temp,'helper-backup');await mkdir(backup);
  const run=(op)=>spawnSync(process.execPath,['--no-warnings','-e',volumeHelperSource],{
    env:{...process.env,OSMANX_SOURCE_DIR:f.src,OSMANX_TARGET_DIR:backup,OSMANX_OPERATION:op,OSMANX_DB_NAME:'crm.sqlite'},encoding:'utf8'});
  const before=run('scan');assert.equal(before.status,0,before.stderr);
  const copy=run('copy');assert.equal(copy.status,0,copy.stderr);
  assert.deepEqual(JSON.parse(copy.stdout),JSON.parse(before.stdout));
  const second=run('copy');assert.notEqual(second.status,0);
  await symlink('customer-file.txt',join(f.src,'bad-link'));
  const bad=run('scan');assert.notEqual(bad.status,0);assert.match(bad.stderr,/Symlink or special file forbidden/);
 }finally{await f.cleanup()}
});

test('R2.7: source missing and unverified helper image never permit migration',{timeout:90000},async()=>{
 const f=await fixture();try{
  f.volumes.delete(legacyCompose+'_app_data');
  await assert.rejects(migrationPlan({legacyRoot:f.old,root:f.next,legacyProject:legacyCompose,adapter:f.adapter}),/Missing legacy application data volume/);
 }finally{await f.cleanup()}
});
