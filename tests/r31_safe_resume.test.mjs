import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {createZip} from '../src/common/zip.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {makeReleaseSignature,SIGNATURE_PATH} from '../templates/deploy/signature.mjs';
import {applyUpgrade,resumeUpgrade,recoverUpgrade,getUpgradeStatus} from '../templates/deploy/upgrade.mjs';
import {runMaintenance} from '../templates/deploy/maintenance.mjs';
const root=resolve(import.meta.dirname,'..');
const id='f8326125-0a31-43bb-a877-335588990011';
const domain='staging.osmanx.co';
const hash=x=>createHash('sha256').update(x).digest('hex');
const project=(type,name)=>({id,name,type,industry:type==='site'?'business':'restaurant',
 modules:type==='site'?['auth','cms','leads']:['auth','clients','tasks'],
 settings:{accent:'#578884',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]});
const entries=x=>parseStoredZip(x,{maxFiles:400,maxBytes:80*1024*1024});
async function fixture(type='crm') {
 const base=await mkdtemp(join(tmpdir(),'osmanx-r31-'));
 const installed=join(base,'installed'),data=join(base,'data'),backups=join(installed,'backups');
 await mkdir(installed,{recursive:true});await mkdir(data,{recursive:true});await mkdir(backups,{recursive:true,mode:0o700});await chmod(backups,0o700);
 const previous=project(type,'Original');
 for(const [name,buf] of entries(await exportDeploymentBundle(previous,root,domain))){
  await mkdir(dirname(join(installed,name)),{recursive:true});await writeFile(join(installed,name),buf);
 }
 await writeFile(join(installed,'.env'),'SETUP_TOKEN=synthetic-only\nAPP_DOMAIN='+domain+'\n',{mode:0o600});
 const d=new DatabaseSync(join(data,type==='site'?'site.sqlite':'crm.sqlite'));
 d.exec("CREATE TABLE canary(value TEXT NOT NULL);INSERT INTO canary VALUES('initial')");d.close();
 const next=project(type,'Updated');
 const release={id:'aaaaaaaa-1111-4222-8333-cccccccccccc',sequence:1,snapshotSha256:hash(JSON.stringify(next)),createdAt:'2026-11-05T00:00:00Z'};
 const e=entries(await exportDeploymentBundle(next,root,domain,release));
 const pair=generateKeyPairSync('ed25519');
 const privatePem=pair.privateKey.export({format:'pem',type:'pkcs8'}),publicPem=pair.publicKey.export({format:'pem',type:'spki'});
 e.set(SIGNATURE_PATH,makeReleaseSignature(e,privatePem));
 const zip=join(base,'next-signed.zip');await writeFile(zip,createZip([...e].map(([name,data])=>({name,data}))));
 const trust=join(installed,'.osmanx-trust');await mkdir(trust,{mode:0o700});await chmod(trust,0o700);
 await writeFile(join(trust,'release-public.pem'),publicPem,{mode:0o600});
 const dbPath=join(data,type==='site'?'site.sqlite':'crm.sqlite');
 const canary=()=>{const db=new DatabaseSync(dbPath);try{return db.prepare('SELECT value FROM canary').get().value}finally{db.close()}};
 const writeCanary=value=>{const db=new DatabaseSync(dbPath);try{db.prepare('UPDATE canary SET value=?').run(value)}finally{db.close()}};
 const calls=[];
 const adapter={
  async stop(){calls.push('stop')},
  async backup(){calls.push('backup');return runMaintenance({root:installed,dataDir:data,backupDir:backups,command:'backup'})},
  async restore(_root,backupId){calls.push('restore');return runMaintenance({root:installed,dataDir:data,backupDir:backups,command:'restore',id:backupId,confirm:true})},
  async up(){calls.push('up')},async health(){calls.push('health')},
  async observe(){calls.push('observe');return {observedStable:true,samplesCompleted:3}},
  async activate(){calls.push('activate');if(failActivate){failActivate=false;throw Error('gateway response unknown')}}
 };
 let failActivate=true;
 return {base,installed,backups,zip,adapter,calls,canary,writeCanary,dbPath,trust,
  close:()=>rm(base,{recursive:true,force:true})};
}

test('R3.1: forward recovery after ambiguous activation preserves new client writes (CRM and site)',{timeout:60000},async()=>{
 for(const type of ['crm','site']){
  const f=await fixture(type);try{
   await assert.rejects(applyUpgrade({root:f.installed,zipPath:f.zip,confirm:true,requireSignature:true,adapter:f.adapter}),/Gateway activation uncertain/);
   assert.equal((await getUpgradeStatus({root:f.installed})).active.phase,'manual-review-required');
   assert.equal(JSON.parse(await readFile(join(f.installed,'manifest.json'))).release.sequence,1);
   f.writeCanary('real-write-after-possible-exposure');
   await assert.rejects(recoverUpgrade({root:f.installed,confirm:true,adapter:f.adapter}),/Manual review required/);
   await assert.rejects(resumeUpgrade({root:f.installed,adapter:f.adapter}),/explicit --confirm/);
   const result=await resumeUpgrade({root:f.installed,confirm:true,adapter:f.adapter});
   assert.equal(result.keptNewVersion,true);assert.equal(result.databaseRestored,false);
   assert.equal(result.releaseSequence,1);assert.equal(f.canary(),'real-write-after-possible-exposure');
   assert.equal(f.calls.filter(x=>x==='restore').length,0,'No restoring SQLite snapshot after gateway exposure');
   const status=await getUpgradeStatus({root:f.installed});
   assert.equal(status.active,null);assert.equal(status.history[0].phase,'completed-after-manual-review');
  }finally{await f.close()}
 }
});

test('R3.1: unsafe forward resume refuses missing trusted key or altered signed code without touching SQLite',{timeout:30000},async()=>{
 const f=await fixture();try{
  await assert.rejects(applyUpgrade({root:f.installed,zipPath:f.zip,confirm:true,requireSignature:true,adapter:f.adapter}),/Gateway activation uncertain/);
  f.writeCanary('keep-me');
  await rm(join(f.trust,'release-public.pem'));
  await assert.rejects(resumeUpgrade({root:f.installed,confirm:true,adapter:f.adapter}),/missing|not configured/i);
  const pub=(await readFile(f.zip));
  assert.ok(pub.length>0);
  assert.equal(f.canary(),'keep-me');
  const pair=generateKeyPairSync('ed25519');
  await writeFile(join(f.trust,'release-public.pem'),pair.publicKey.export({format:'pem',type:'spki'}));
  await assert.rejects(resumeUpgrade({root:f.installed,confirm:true,adapter:f.adapter}),/Untrusted release signer/);
  assert.equal(f.canary(),'keep-me');
  assert.equal((await getUpgradeStatus({root:f.installed})).active.phase,'manual-review-required');
 }finally{await f.close()}
});

test('R3.1: failed forward observation is fail-closed and never invokes destructive restore',{timeout:30000},async()=>{
 const f=await fixture();try{
  await assert.rejects(applyUpgrade({root:f.installed,zipPath:f.zip,confirm:true,requireSignature:true,adapter:f.adapter}),/Gateway activation uncertain/);
  f.writeCanary('new-client-data');
  f.adapter.observe=async()=>({observedStable:false,samplesCompleted:1});
  await assert.rejects(resumeUpgrade({root:f.installed,confirm:true,adapter:f.adapter}),/Forward resume failed/);
  assert.equal(f.canary(),'new-client-data');
  assert.equal(f.calls.filter(x=>x==='restore').length,0);
  assert.equal((await getUpgradeStatus({root:f.installed})).active.phase,'manual-review-required');
 }finally{await f.close()}
});
