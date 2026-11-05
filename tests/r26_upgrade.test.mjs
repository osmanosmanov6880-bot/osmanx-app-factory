import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createZip } from '../src/common/zip.mjs';
import { parseStoredZip } from '../src/common/archive.mjs';
import { exportDeploymentBundle } from '../src/studio/deployment.mjs';
import { planUpgrade, applyUpgrade, recoverUpgrade, getUpgradeStatus } from '../templates/deploy/upgrade.mjs';
import { runMaintenance } from '../templates/deploy/maintenance.mjs';

const factoryRoot = resolve(import.meta.dirname,'..');
const hash = b => createHash('sha256').update(b).digest('hex');
const domain = 'crm.osmanx.co';
const ident = type => type==='crm'?'22222222-3333-4444-8555-666666666666':'77777777-3333-4444-8555-666666666666';
const project = (type,name) => ({id:ident(type),name,type,industry:type==='crm'?'restaurant':'business',
  modules:type==='crm'?['auth','clients','tasks']:['auth','cms','leads'],
  settings:{accent:'#386f61',primaryAction:'navigate_overview',currency:'RUB'},pages:[],entities:[],automationPresets:[]});
async function extract(buffer,out) {
  const entries = parseStoredZip(buffer,{maxFiles:400,maxBytes:80*1024*1024});
  for(const [name,data] of entries){await mkdir(dirname(join(out,name)),{recursive:true});await writeFile(join(out,name),data);}
  return entries;
}
async function fixture(type,{legacy=false}={}) {
  const base=await mkdtemp(join(tmpdir(),'osmanx-r26-')),app=join(base,'app'),data=join(base,'data'),backups=join(app,'backups');
  await Promise.all([mkdir(app,{recursive:true}),mkdir(data,{recursive:true}),mkdir(backups,{recursive:true})]);
  await import('node:fs/promises').then(fs=>fs.chmod(backups,0o700));
  const current=project(type,'Before deployment');
  const candidate=project(type,'After controlled upgrade');
  let old=await exportDeploymentBundle(current,factoryRoot,domain);
  if(legacy){
    const entries=parseStoredZip(old,{maxFiles:400,maxBytes:80*1024*1024});
    entries.delete('deploy/upgrade.mjs');
    const d=JSON.parse(entries.get('deploy/manifest.json'));
    delete d.files['deploy/upgrade.mjs'];
    entries.set('deploy/manifest.json',Buffer.from(JSON.stringify(d,null,2)+'\n'));
    old=createZip([...entries].map(([name,data])=>({name,data})));
  }
  await extract(old,app);
  const next=await exportDeploymentBundle(candidate,factoryRoot,domain,{id:'aaaaaaaa-1111-4222-8333-cccccccccccc',sequence:1,
    snapshotSha256:hash(JSON.stringify(candidate)),notes:'Updated details',createdAt:'2026-11-05T00:00:00.000Z'});
  const zipPath=join(base,'next.zip');await writeFile(zipPath,next);
  await writeFile(join(app,'.env'),'APP_DOMAIN='+domain+'\nCOOKIE_SECURE=1\nSETUP_TOKEN=secret123\n',{mode:0o600});
  const dbPath=join(data,type==='site'?'site.sqlite':'crm.sqlite');
  const db=new DatabaseSync(dbPath);db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare('INSERT INTO notes(value) VALUES(?)').run('valuable-data');db.close();
  const calls=[];
  const adapter={
    async stop(){calls.push('stop');},
    async backup(){calls.push('backup');return runMaintenance({root:app,dataDir:data,backupDir:backups,command:'backup'});},
    async restore(_root,id){calls.push('restore');return runMaintenance({root:app,dataDir:data,backupDir:backups,command:'restore',id,confirm:true});},
    async up(){calls.push('up');},
    async health(){calls.push('health');}
  };
  return {base,app,data,backups,dbPath,calls,zipPath,current,candidate,adapter,type};
}
function readNote(path){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT value FROM notes WHERE id=1').get().value}finally{db.close()}}
function setNote(path,value){const db=new DatabaseSync(path);try{db.prepare('UPDATE notes SET value=? WHERE id=1').run(value)}finally{db.close()}}
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function boot(app,dataDir){
 const port=await freePort();const p=spawn(process.execPath,['run.mjs'],{cwd:app,env:{...process.env,DATA_DIR:dataDir,HOST:'127.0.0.1',PORT:String(port),COOKIE_SECURE:'0',NODE_NO_WARNINGS:'1'},stdio:'ignore'});
 try{for(let i=0;i<90;i++){if(p.exitCode!==null)throw Error('Standalone server quit');try{const r=await fetch('http://127.0.0.1:'+port+'/api/health');if(r.ok)return r.json()}catch{}await new Promise(done=>setTimeout(done,100));}throw Error('Health timeout')}
 finally{p.kill('SIGTERM');await new Promise(r=>p.once('exit',r));}
}

test('R2.6: versioned CRM and site deploy kits update while preserving database and private .env',{timeout:90000},async()=>{
 for(const type of ['crm','site']){
  const ctx=await fixture(type,{legacy:type==='crm'});
  try{
   const plan=(await planUpgrade({root:ctx.app,zipPath:ctx.zipPath})).summary;
   assert.equal(plan.from,0);assert.equal(plan.to,1);
   await assert.rejects(applyUpgrade({root:ctx.app,zipPath:ctx.zipPath,adapter:ctx.adapter}),/confirm/);
   const done=await applyUpgrade({root:ctx.app,zipPath:ctx.zipPath,confirm:true,adapter:ctx.adapter});
   assert.equal(done.upgraded,true);assert.equal(done.from,0);assert.equal(done.to,1);
   assert.deepEqual(ctx.calls,['stop','backup','up','health']);
   assert.equal(readNote(ctx.dbPath),'valuable-data');
   assert.match(await readFile(join(ctx.app,'.env'),'utf8'),/SETUP_TOKEN=secret123/);
   assert.equal(JSON.parse(await readFile(join(ctx.app,'manifest.json'),'utf8')).release.sequence,1);
   const status=await getUpgradeStatus({root:ctx.app});assert.equal(status.active,null);assert.equal(status.history[0].phase,'completed');
   const verified=spawnSync(process.execPath,['deploy/verify.mjs'],{cwd:ctx.app,encoding:'utf8'});
   assert.equal(verified.status,0,verified.stderr);
   const health=await boot(ctx.app,ctx.data);assert.equal(health.ok,true);
  }finally{await rm(ctx.base,{recursive:true,force:true})}
 }
});

test('R2.6: failed startup rolls back both managed code and changed SQLite data',{timeout:90000},async()=>{
 const ctx=await fixture('crm',{legacy:true});
 try{
  const oldManifest=await readFile(join(ctx.app,'manifest.json'));
  let starts=0;
  ctx.adapter.up=async()=>{starts++;ctx.calls.push('up');if(starts===1){setNote(ctx.dbPath,'partially-migrated');throw Error('failed new service health');}};
  await assert.rejects(applyUpgrade({root:ctx.app,zipPath:ctx.zipPath,confirm:true,adapter:ctx.adapter}),/old version restored/);
  assert.equal(readNote(ctx.dbPath),'valuable-data');
  assert.deepEqual(await readFile(join(ctx.app,'manifest.json')),oldManifest);
  assert.equal(JSON.parse(await readFile(join(ctx.app,'config/project.json'),'utf8')).name,ctx.current.name);
  const status=await getUpgradeStatus({root:ctx.app});assert.equal(status.active,null);assert.equal(status.history[0].phase,'rolled-back');
  const verified=spawnSync(process.execPath,['deploy/verify.mjs'],{cwd:ctx.app,encoding:'utf8'});assert.equal(verified.status,0,verified.stderr);
  assert.deepEqual(ctx.calls,['stop','backup','up','stop','restore','up','health']);
 }finally{await rm(ctx.base,{recursive:true,force:true})}
});

test('R2.6: unfinished rollback leaves journal and recover --confirm restores prior release',{timeout:90000},async()=>{
 const ctx=await fixture('site');
 try{
  let failRestore=true;
  const origRestore=ctx.adapter.restore;
  ctx.adapter.health=async()=>{ctx.calls.push('health');if(failRestore)throw Error('app crashed after restart')};
  ctx.adapter.restore=async(...args)=>{if(failRestore)throw Error('temporary storage issue');return origRestore(...args)};
  await assert.rejects(applyUpgrade({root:ctx.app,zipPath:ctx.zipPath,confirm:true,adapter:ctx.adapter}),/rollback is incomplete/);
  assert.equal((await getUpgradeStatus({root:ctx.app})).active.phase,'recovery-required');
  await assert.rejects(recoverUpgrade({root:ctx.app,adapter:ctx.adapter}),/confirm/);
  failRestore=false;
  const output=await recoverUpgrade({root:ctx.app,confirm:true,adapter:ctx.adapter});assert.equal(output.ok,true);
  assert.equal(readNote(ctx.dbPath),'valuable-data');
  assert.equal(JSON.parse(await readFile(join(ctx.app,'manifest.json'))).release.sequence,0);
  assert.equal((await getUpgradeStatus({root:ctx.app})).active,null);
  assert.equal((await getUpgradeStatus({root:ctx.app})).history[0].phase,'recovered');
 }finally{await rm(ctx.base,{recursive:true,force:true})}
});

test('R2.6: rejects incompatible release, rollback/downgrade, tampering, symlink and unrelated local files',{timeout:90000},async()=>{
 const ctx=await fixture('crm');
 try{
  const entries=parseStoredZip(await readFile(ctx.zipPath),{maxFiles:400,maxBytes:80*1024*1024});
  await assert.rejects(planUpgrade({root:ctx.app,zipPath:ctx.zipPath+'.missing'}));
  await planUpgrade({root:ctx.app,zipPath:ctx.zipPath});
  const d=JSON.parse(entries.get('deploy/manifest.json'));d.domain='another.osmanx.co';
  const changed=createZip([...entries].map(([name,data])=>({name,data:name==='deploy/manifest.json'?JSON.stringify(d,null,2)+'\n':data})));
  await writeFile(join(ctx.base,'wrong-domain.zip'),changed);
  await assert.rejects(planUpgrade({root:ctx.app,zipPath:join(ctx.base,'wrong-domain.zip')}),/Domain or Compose/);
  const nextApp=JSON.parse(entries.get('manifest.json'));nextApp.release.sequence=0;
  const nextBytes=Buffer.from(JSON.stringify(nextApp,null,2)+'\n');
  const dep=JSON.parse(entries.get('deploy/manifest.json'));dep.applicationManifestSha256=hash(nextBytes);
  entries.set('manifest.json',nextBytes);entries.set('deploy/manifest.json',Buffer.from(JSON.stringify(dep,null,2)+'\n'));
  await writeFile(join(ctx.base,'downgrade.zip'),createZip([...entries].map(([name,data])=>({name,data}))));
  await assert.rejects(planUpgrade({root:ctx.app,zipPath:join(ctx.base,'downgrade.zip')}),/higher/);
  await writeFile(join(ctx.app,'deploy/Caddyfile'),'locally-tampered');
  await assert.rejects(planUpgrade({root:ctx.app,zipPath:ctx.zipPath}),/Locally modified/);
  const orig=entries.get('deploy/Caddyfile');
  const source=parseStoredZip(await readFile(ctx.zipPath),{maxFiles:400,maxBytes:80*1024*1024});
  await writeFile(join(ctx.app,'deploy/Caddyfile'),source.get('deploy/Caddyfile'));
  await writeFile(join(ctx.app,'deploy/upgrade.mjs'),'unmanaged-owner-file');
  // Both files are already in current R2.6 fixture; test collision with a fresh future new path instead.
  await rm(join(ctx.app,'deploy/upgrade.mjs'));
  await symlink('/etc/passwd',join(ctx.app,'deploy/upgrade.mjs'));
  await assert.rejects(planUpgrade({root:ctx.app,zipPath:ctx.zipPath}),/Symbolic link forbidden/);
 }finally{await rm(ctx.base,{recursive:true,force:true})}
});

test('R2.6: refuses unmanaged file collisions and removed modules before application',{timeout:90000},async()=>{
 const ctx=await fixture('crm',{legacy:true});
 try{
  await writeFile(join(ctx.app,'deploy/upgrade.mjs'),'operator-owned-untracked-file');
  await assert.rejects(planUpgrade({root:ctx.app,zipPath:ctx.zipPath}),/collides with an unmanaged/);
  await rm(join(ctx.app,'deploy/upgrade.mjs'));
  const incompatible={...ctx.candidate,modules:['auth']};
  const zip=await exportDeploymentBundle(incompatible,factoryRoot,domain,{
   id:'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff',sequence:1,
   snapshotSha256:hash(JSON.stringify(incompatible)),notes:'removed module',createdAt:'2026-11-05'});
  const file=join(ctx.base,'removed-module.zip');await writeFile(file,zip);
  await assert.rejects(planUpgrade({root:ctx.app,zipPath:file}),/Removing existing module/);
 }finally{await rm(ctx.base,{recursive:true,force:true})}
});

test('R2.6: CLI plan and status are usable from an extracted future kit against an old installation',{timeout:90000},async()=>{
 const ctx=await fixture('site',{legacy:true});
 try{
  const staged=join(ctx.base,'staged');await mkdir(staged);await extract(await readFile(ctx.zipPath),staged);
  const binary=join(staged,'deploy/upgrade.mjs');
  const output=spawnSync(process.execPath,[binary,'plan',ctx.zipPath,'--installed='+ctx.app],{encoding:'utf8'});
  assert.equal(output.status,0,output.stderr);assert.equal(JSON.parse(output.stdout).to,1);
  const status=spawnSync(process.execPath,[binary,'status','--installed='+ctx.app],{encoding:'utf8'});
  assert.equal(status.status,0,status.stderr);assert.deepEqual(JSON.parse(status.stdout),{active:null,history:[]});
 }finally{await rm(ctx.base,{recursive:true,force:true})}
});
