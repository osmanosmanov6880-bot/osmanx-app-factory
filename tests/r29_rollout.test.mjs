import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createZip } from '../src/common/zip.mjs';
import { parseStoredZip } from '../src/common/archive.mjs';
import { exportDeploymentBundle } from '../src/studio/deployment.mjs';
import { observeRollout, getRolloutReports } from '../templates/deploy/rollout-observe.mjs';
import { applyUpgrade, recoverUpgrade, getUpgradeStatus } from '../templates/deploy/upgrade.mjs';
import { runMaintenance } from '../templates/deploy/maintenance.mjs';
const source=resolve(import.meta.dirname,'..');
const digest=b=>createHash('sha256').update(b).digest('hex');
const projectId='459aa8ae-3333-4333-8333-58d86dc456ac';
const domain='factory.osmanx.co';
const composeName='osmanx_'+projectId.replaceAll('-','').slice(0,12);
const project=name=>({id:projectId,name,type:'crm',industry:'restaurant',modules:['auth','clients','tasks'],settings:{accent:'#386f61',primaryAction:'navigate_overview',currency:'RUB'},pages:[],entities:[],automationPresets:[]});
const good=()=>({id:'a'.repeat(64),project:composeName,status:'running',health:'healthy',restartCount:0});
async function extract(bytes,where){
 const entries=parseStoredZip(bytes,{maxFiles:400,maxBytes:80*1024*1024});
 for(const [name,buffer] of entries){await mkdir(dirname(join(where,name)),{recursive:true});await writeFile(join(where,name),buffer)}
 return entries;
}
async function fixture(){
 const base=await mkdtemp(join(tmpdir(),'osmanx-r29-')),root=join(base,'kit'),data=join(base,'database');
 await mkdir(root);await mkdir(data);
 await extract(await exportDeploymentBundle(project('Before'),source,domain),root);
 return {base,root,data,cleanup:()=>rm(base,{recursive:true,force:true})};
}
function adapterFor(steps,tracking=[]){let i=0;return{
 async inspect(){tracking.push('inspect');return steps[Math.min(i++,steps.length-1)]},
 async health(){tracking.push('health')}
}}

test('R2.9: exported CRM and site contain isolated private rollout observer with verified manifest hash',{timeout:30000},async()=>{
 for(const type of ['crm','site']){
  const p={...project('App'),type,industry:type==='site'?'business':'restaurant',modules:type==='site'?['auth','cms','leads']:['auth','clients','tasks']};
  const files=parseStoredZip(await exportDeploymentBundle(p,source,domain),{maxFiles:400,maxBytes:80*1024*1024});
  const dep=JSON.parse(files.get('deploy/manifest.json'));
  const name='deploy/rollout-observe.mjs';
  assert.equal(dep.files[name],digest(files.get(name)));
  assert.match(files.get('deploy/upgrade.mjs').toString(),/observeRollout/);
  assert.match(files.get('.dockerignore').toString(),/\.osmanx-rollout/);
  assert.match(files.get('deploy/DEPLOY.md').toString(),/R2\.9 LOCAL ROLLOUT/);
 }
});

test('R2.9: multiple healthy samples produce a private minimal observation report',{timeout:30000},async()=>{
 const f=await fixture();try{
  const calls=[];
  const result=await observeRollout({root:f.root,samples:4,intervalMs:0,adapter:adapterFor([good()],calls),sleep:async()=>{},record:true});
  assert.equal(result.observedStable,true);assert.equal(result.samplesCompleted,4);assert.equal(result.publicHttpsVerified,false);
  assert.equal(calls.filter(v=>v==='health').length,4);
  const dir=join(f.root,'.osmanx-rollout');assert.equal((await readdir(dir)).length,1);
  const stat=await lstat(dir);if(process.platform!=='win32')assert.equal(stat.mode&0o077,0);
  const reports=await getRolloutReports({root:f.root});assert.equal(reports.length,1);
  assert.equal(reports[0].projectId,projectId);assert.equal(reports[0].releaseSequence,0);
  assert.equal(JSON.stringify(reports).includes('SETUP_TOKEN'),false);
  assert.equal(JSON.stringify(reports).includes('customers'),false);
 }finally{await f.cleanup()}
});

test('R2.9: unstable container, restart, wrong owner, or missing health fail closed',{timeout:30000},async()=>{
 const bad=[
  [good(),{...good(),restartCount:1}],
  [good(),{...good(),id:'b'.repeat(64)}],
  [{...good(),project:'unexpected'}],
  [{...good(),health:'unhealthy'}],
  [{...good(),status:'exited'}],
  [{...good(),restartCount:3}]
 ];
 const f=await fixture();try{
  for(const sequence of bad){
   await assert.rejects(observeRollout({root:f.root,samples:3,intervalMs:0,adapter:adapterFor(sequence),sleep:async()=>{},record:true}),/Rollout stability gate failed/);
  }
  const reports=await getRolloutReports({root:f.root});assert.equal(reports.length,bad.length);
  assert.ok(reports.every(r=>r.observedStable===false&&r.publicHttpsVerified===false));
 }finally{await f.cleanup()}
});

test('R2.9: observation history refuses symlink and open permissions; invalid windows never run Docker',{timeout:30000},async()=>{
 const f=await fixture();try{
  let calls=0;const a={inspect:async()=>{calls++;return good()},health:async()=>{calls++}};
  await assert.rejects(observeRollout({root:f.root,samples:1,adapter:a}),/Samples/);
  await assert.rejects(observeRollout({root:f.root,samples:13,adapter:a}),/Samples/);
  await assert.rejects(observeRollout({root:f.root,samples:3,intervalMs:100000,adapter:a}),/interval/);
  assert.equal(calls,0);
  const outside=join(f.base,'outside');await mkdir(outside,{mode:0o700});
  await symlink(outside,join(f.root,'.osmanx-rollout'),'dir');
  await assert.rejects(observeRollout({root:f.root,samples:2,intervalMs:0,adapter:a,sleep:async()=>{},record:true}),/Unsafe rollout/);
  await rm(join(f.root,'.osmanx-rollout'));
  await mkdir(join(f.root,'.osmanx-rollout'),{mode:0o777});
  await chmod(join(f.root,'.osmanx-rollout'),0o755);
  if(process.platform!=='win32')await assert.rejects(getRolloutReports({root:f.root}),/private/);
 }finally{await f.cleanup()}
});

test('R2.9: stable new release finishes; failed post-start observation rolls back code and actual SQLite',{timeout:90000},async()=>{
 for(const fail of [false,true]){
  const f=await fixture();try{
   const backups=join(f.root,'backups');await mkdir(backups,{mode:0o700});await chmod(backups,0o700);
   await writeFile(join(f.root,'.env'),'APP_DOMAIN='+domain+'\nCOOKIE_SECURE=1\nSETUP_TOKEN=TEST_ONLY\n',{mode:0o600});
   const db=new DatabaseSync(join(f.data,'crm.sqlite'));db.exec('CREATE TABLE important(id INT PRIMARY KEY, value TEXT);INSERT INTO important VALUES(1,\'original\')');db.close();
   const updated=project('After');const release={id:'aaaaaaaa-1111-4222-8333-cccccccccccc',sequence:1,
    snapshotSha256:digest(JSON.stringify(updated)),createdAt:'2026-11-05T00:00:00Z'};
   const z=join(f.base,'update.zip');await writeFile(z,await exportDeploymentBundle(updated,source,domain,release));
   let stops=0,restore=0;
   const adapter={
    async stop(){stops++},
    async backup(){return runMaintenance({root:f.root,dataDir:f.data,backupDir:backups,command:'backup'})},
    async restore(_root,id){restore++;return runMaintenance({root:f.root,dataDir:f.data,backupDir:backups,command:'restore',id,confirm:true})},
    async up(){},async health(){},
    async observe(){
     if(fail){const x=new DatabaseSync(join(f.data,'crm.sqlite'));x.exec("UPDATE important SET value='bad-release'");x.close();
      throw Error('simulated crash during stability window')}
     return observeRollout({root:f.root,samples:2,intervalMs:0,adapter:adapterFor([good()]),sleep:async()=>{},record:true});
    }
   };
   if(fail)await assert.rejects(applyUpgrade({root:f.root,zipPath:z,confirm:true,adapter}),/old version restored/);
   else assert.equal((await applyUpgrade({root:f.root,zipPath:z,confirm:true,adapter})).rolloutObserved,true);
   const installed=JSON.parse(await readFile(join(f.root,'manifest.json')));
   assert.equal(installed.release.sequence,fail?0:1);
   const after=new DatabaseSync(join(f.data,'crm.sqlite'),{readOnly:true});
   assert.equal(after.prepare('SELECT value FROM important WHERE id=1').get().value,'original');after.close();
   const state=await getUpgradeStatus({root:f.root});
   assert.equal(state.history[0].phase,fail?'rolled-back':'completed');
   assert.equal(restore,fail?1:0);assert.equal(stops,fail?2:1);
  }finally{await f.cleanup()}
 }
});

test('R2.9: external gateway activation occurs strictly AFTER the stable observation; rollback reactivates old gateway',{timeout:90000},async()=>{
 for(const fail of [false,true]){
  const f=await fixture();try{
   const backup=join(f.root,'backups');await mkdir(backup,{mode:0o700});await chmod(backup,0o700);
   await writeFile(join(f.root,'.env'),'APP_DOMAIN='+domain+'\nSETUP_TOKEN=synthetic-for-tests-only-not-private\n',{mode:0o600});
   const db=new DatabaseSync(join(f.data,'crm.sqlite'));db.exec('CREATE TABLE data(id INT PRIMARY KEY, value TEXT);INSERT INTO data VALUES(1,\'persist\')');db.close();
   const next=project('Next');const sequence={id:'aaaaaaaa-1111-4222-8333-cccccccccccc',sequence:1,
    snapshotSha256:digest(JSON.stringify(next)),createdAt:'2026-11-05T00:00:00Z'};
   const zipPath=join(f.base,'next.zip');await writeFile(zipPath,await exportDeploymentBundle(next,source,domain,sequence));
   const calls=[];
   const a={
    async stop(){calls.push('stop-gateway-and-app')},
    async backup(){calls.push('backup');return runMaintenance({root:f.root,dataDir:f.data,backupDir:backup,command:'backup'})},
    async restore(_root,id){calls.push('restore');return runMaintenance({root:f.root,dataDir:f.data,backupDir:backup,command:'restore',id,confirm:true})},
    async up(){calls.push('start-app-only')},async health(){calls.push('health')},
    async observe(){calls.push('observe');if(fail)throw Error('unstable app');return {observedStable:true,samplesCompleted:3}},
    async activate(){calls.push('open-gateway')}
   };
   if(fail){
    await assert.rejects(applyUpgrade({root:f.root,zipPath,confirm:true,adapter:a}),/old version restored/);
    assert.deepEqual(calls,['stop-gateway-and-app','backup','start-app-only','health','observe','stop-gateway-and-app','restore','start-app-only','health','open-gateway']);
   }else{
    const outcome=await applyUpgrade({root:f.root,zipPath,confirm:true,adapter:a});
    assert.equal(outcome.rolloutObserved,true);
    assert.deepEqual(calls,['stop-gateway-and-app','backup','start-app-only','health','observe','open-gateway']);
   }
  }finally{await f.cleanup()}
 }
});


test('R2.9: uncertain gateway activation preserves possible new writes instead of rolling back SQLite',{timeout:90000},async()=>{
 const f=await fixture();try{
  const backups=join(f.root,'backups');await mkdir(backups,{mode:0o700});await chmod(backups,0o700);
  await writeFile(join(f.root,'.env'),'APP_DOMAIN='+domain+'\nSETUP_TOKEN=synthetic-for-tests-only\n',{mode:0o600});
  const db=new DatabaseSync(join(f.data,'crm.sqlite'));db.exec("CREATE TABLE important(value TEXT);INSERT INTO important VALUES('original')");db.close();
  const updated=project('Candidate');const release={id:'aaaaaaaa-1111-4222-8333-cccccccccccc',sequence:1,
   snapshotSha256:digest(JSON.stringify(updated)),createdAt:'2026-11-05T00:00:00Z'};
  const zipPath=join(f.base,'candidate.zip');await writeFile(zipPath,await exportDeploymentBundle(updated,source,domain,release));
  let stops=0,restores=0;
  const adapter={async stop(){stops++},async backup(){return runMaintenance({root:f.root,dataDir:f.data,backupDir:backups,command:'backup'})},
   async restore(){restores++;throw Error('should never restore possibly live data')},async up(){},async health(){},
   async observe(){return {observedStable:true,samplesCompleted:3}},
   async activate(){const d=new DatabaseSync(join(f.data,'crm.sqlite'));d.exec("UPDATE important SET value='potential-customer-write'");d.close();throw Error('network interruption after gateway may have started')}
  };
  await assert.rejects(applyUpgrade({root:f.root,zipPath,confirm:true,adapter}),/Automatic database rollback refused/);
  assert.equal(restores,0);assert.equal(stops,2);
  const still=new DatabaseSync(join(f.data,'crm.sqlite'),{readOnly:true});
  assert.equal(still.prepare('SELECT value FROM important').get().value,'potential-customer-write');still.close();
  assert.equal(JSON.parse(await readFile(join(f.root,'manifest.json'))).release.sequence,1);
  assert.equal((await getUpgradeStatus({root:f.root})).active.phase,'manual-review-required');
  await assert.rejects(recoverUpgrade({root:f.root,adapter,confirm:true}),/Manual review required/);
 }finally{await f.cleanup()}
});
