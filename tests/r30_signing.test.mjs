import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseStoredZip } from '../src/common/archive.mjs';
import { createZip } from '../src/common/zip.mjs';
import { exportDeploymentBundle } from '../src/studio/deployment.mjs';
import { releaseSignCLI } from '../scripts/release_sign.mjs';
import { SIGNATURE_PATH, makeReleaseSignature, verifyReleaseSignature } from '../templates/deploy/signature.mjs';
import { planUpgrade, applyUpgrade, getUpgradeStatus } from '../templates/deploy/upgrade.mjs';
import { runMaintenance } from '../templates/deploy/maintenance.mjs';

const source=resolve(import.meta.dirname,'..');
const id='c2a98e10-50a0-40f8-a2ef-001122334455';
const domain='secure.osmanx.co';
const checksum=x=>createHash('sha256').update(x).digest('hex');
const project=(name,type='crm')=>({id,name,type,industry:type==='site'?'business':'restaurant',
  modules:type==='site'?['auth','cms','leads']:['auth','clients','tasks'],settings:{accent:'#6c8b8a',primaryAction:'navigate_overview',currency:'RUB'},pages:[],entities:[],automationPresets:[]});
const release=(p,sequence)=>({id:'aaaaaaaa-1111-4222-8333-cccccccccccc',sequence,
  snapshotSha256:checksum(JSON.stringify(p)),createdAt:'2026-11-05T00:00:00Z'});
const entriesOf=bytes=>parseStoredZip(bytes,{maxFiles:400,maxBytes:80*1024*1024});
const zip=entries=>createZip([...entries].map(([name,data])=>({name,data})));
async function fixture(type='crm') {
  const base=await mkdtemp(join(tmpdir(),'osmanx-r30-')); const root=join(base,'installed');const data=join(base,'db');
  await mkdir(root);await mkdir(data);
  const first=entriesOf(await exportDeploymentBundle(project('Old',type),source,domain));
  for(const [name,bytes] of first){await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),bytes)}
  const next=project('New',type);
  const unsigned=await exportDeploymentBundle(next,source,domain,release(next,1));
  const unsignedPath=join(base,'unsigned.zip');await writeFile(unsignedPath,unsigned);
  return {base,root,data,first,unsigned,unsignedPath,next,close:()=>rm(base,{recursive:true,force:true})};
}
function keys(){const {privateKey,publicKey}=generateKeyPairSync('ed25519');return {
  privatePem:privateKey.export({format:'pem',type:'pkcs8'}),publicPem:publicKey.export({format:'pem',type:'spki'})};}
function signZip(original,privatePem){const e=entriesOf(original);e.set(SIGNATURE_PATH,makeReleaseSignature(e,privatePem));return zip(e)}
async function pin(root,pem){const dir=join(root,'.osmanx-trust');await mkdir(dir,{mode:0o700});await chmod(dir,0o700);
  await writeFile(join(dir,'release-public.pem'),pem,{mode:0o644});}

// Covers both app types: signing does not change the normal application manifest or OBSIDIAN UI.
test('R3.0: both CRM and site export a tracked verification engine, but never private keys',async()=>{
 for(const type of ['crm','site']){
  const f=await fixture(type);try{
   const e=entriesOf(f.unsigned);const dep=JSON.parse(e.get('deploy/manifest.json'));
   assert.equal(dep.files['deploy/signature.mjs'],checksum(e.get('deploy/signature.mjs')));
   assert.match(e.get('deploy/upgrade.mjs').toString(),/verifyReleaseSignature/);
   assert.match(e.get('.dockerignore').toString(),/\.osmanx-trust/);
   assert.equal(e.has(SIGNATURE_PATH),false);
   assert.equal(e.has('.osmanx-trust/release-public.pem'),false);
  }finally{await f.close()}
 }
});

test('R3.0: offline Ed25519 signature matches the pinned publisher key',async()=>{
 const f=await fixture();try{
  const k=keys(),signed=entriesOf(signZip(f.unsigned,k.privatePem));
  const checked=verifyReleaseSignature(signed,k.publicPem,{requireSignature:true});
  assert.equal(checked.signed,true);assert.equal(checked.verified,true);
  assert.match(checked.keyFingerprintSha256,/^[0-9a-f]{64}$/);
  assert.throws(()=>verifyReleaseSignature(signed,keys().publicPem),/Untrusted release signer/);
  assert.throws(()=>verifyReleaseSignature(signed),/requires a trusted public key/);
  assert.throws(()=>verifyReleaseSignature(entriesOf(f.unsigned),k.publicPem),/Unsigned release refused/);
  const e=entriesOf(f.unsigned);e.set('untracked-private.txt',Buffer.from('secret'));
  assert.throws(()=>makeReleaseSignature(e,k.privatePem),/Unexpected or untracked/);
 }finally{await f.close()}
});

test('R3.0: altering the release while keeping all SHA-256 manifest records consistent invalidates signature',async()=>{
 const f=await fixture();try{
  const k=keys();const signed=entriesOf(signZip(f.unsigned,k.privatePem));
  const app=JSON.parse(signed.get('manifest.json'));app.release.sequence=42;
  const changedApp=Buffer.from(JSON.stringify(app,null,2)+'\n');
  signed.set('manifest.json',changedApp);
  const deploy=JSON.parse(signed.get('deploy/manifest.json'));
  deploy.applicationManifestSha256=checksum(changedApp);
  signed.set('deploy/manifest.json',Buffer.from(JSON.stringify(deploy,null,2)+'\n'));
  assert.throws(()=>verifyReleaseSignature(signed,k.publicPem),/Invalid detached signature format or payload/);
  // Corrupt detached signature bytes, preserving JSON and ZIP checksums.
  const tampered=entriesOf(signZip(f.unsigned,k.privatePem));
  const sig=JSON.parse(tampered.get(SIGNATURE_PATH));
  sig.signature=(sig.signature[0]==='A'?'B':'A')+sig.signature.slice(1);
  tampered.set(SIGNATURE_PATH,Buffer.from(JSON.stringify(sig)));
  assert.throws(()=>verifyReleaseSignature(tampered,k.publicPem),/verification failed/);
 }finally{await f.close()}
});

test('R3.0: default unsigned compatibility works only BEFORE publisher trust is pinned',async()=>{
 const f=await fixture();try{
  const k=keys();const candidate=join(f.base,'signed.zip');await writeFile(candidate,signZip(f.unsigned,k.privatePem));
  const unsignedPlan=await planUpgrade({root:f.root,zipPath:f.unsignedPath});
  assert.equal(unsignedPlan.summary.publisher.verified,false);
  await assert.rejects(planUpgrade({root:f.root,zipPath:candidate}),/requires a trusted public key/);
  await assert.rejects(planUpgrade({root:f.root,zipPath:candidate,requireSignature:true}),/no trusted publisher public key/);
  await pin(f.root,k.publicPem);
  await assert.rejects(planUpgrade({root:f.root,zipPath:f.unsignedPath}),/Unsigned release refused/);
  const checked=await planUpgrade({root:f.root,zipPath:candidate});
  assert.equal(checked.summary.publisher.verified,true);
  assert.equal(checked.summary.to,1);
  const wrong=keys();await writeFile(join(f.root,'.osmanx-trust','release-public.pem'),wrong.publicPem);
  await assert.rejects(planUpgrade({root:f.root,zipPath:candidate}),/Untrusted release signer/);
 }finally{await f.close()}
});

test('R3.0: unsafe trust directory permissions are refused; explicit external trusted key works',async()=>{
 const f=await fixture();try{
  const k=keys();const candidate=join(f.base,'signed.zip');await writeFile(candidate,signZip(f.unsigned,k.privatePem));
  const keyPath=join(f.base,'trusted.pem');await writeFile(keyPath,k.publicPem,{mode:0o644});
  assert.equal((await planUpgrade({root:f.root,zipPath:candidate,trustKeyPath:keyPath})).summary.publisher.verified,true);
  await pin(f.root,k.publicPem);
  if(process.platform!=='win32'){
   await chmod(join(f.root,'.osmanx-trust'),0o777);
   await assert.rejects(planUpgrade({root:f.root,zipPath:candidate}),/Publisher trust directory must not be writable/);
  }
 }finally{await f.close()}
});

test('R3.0: release signing CLI safely generates keys, signs, verifies; refusing overwrite and weak key permissions',async()=>{
 const f=await fixture();try{
  const priv=join(f.base,'keys','signing-private.pem'),pub=join(f.base,'keys','pinned-public.pem');
  const generated=await releaseSignCLI(['keygen','--private='+priv,'--public='+pub]);
  assert.equal(generated.ok,true);
  if(process.platform!=='win32')assert.equal((await lstat(priv)).mode&0o077,0);
  await assert.rejects(releaseSignCLI(['keygen','--private='+priv,'--public='+pub]),/already exists/);
  const signedPath=join(f.base,'verified.zip');
  assert.equal((await releaseSignCLI(['sign',f.unsignedPath,'--private='+priv,'--out='+signedPath])).ok,true);
  assert.equal((await releaseSignCLI(['verify',signedPath,'--public='+pub])).verified,true);
  await assert.rejects(releaseSignCLI(['sign',f.unsignedPath,'--private='+priv,'--out='+signedPath]),/already exists/);
  if(process.platform!=='win32'){
   await chmod(priv,0o644);
   await assert.rejects(releaseSignCLI(['sign',f.unsignedPath,'--private='+priv,'--out='+join(f.base,'bad.zip')]),/chmod 600/);
  }
 }finally{await f.close()}
});

test('R3.0: verified release updates with pinned key, private key is not in client files', {timeout:60000},async()=>{
 const f=await fixture();try{
  const k=keys(),candidate=join(f.base,'signed.zip');await pin(f.root,k.publicPem);
  await writeFile(candidate,signZip(f.unsigned,k.privatePem));
  const backups=join(f.root,'backups');await mkdir(backups,{mode:0o700});await chmod(backups,0o700);
  await writeFile(join(f.root,'.env'),'APP_DOMAIN='+domain+'\nSETUP_TOKEN=synthetic-test-token\n',{mode:0o600});
  const db=new DatabaseSync(join(f.data,'crm.sqlite'));db.exec("CREATE TABLE facts(id INTEGER PRIMARY KEY, value TEXT);INSERT INTO facts VALUES(1,'original')");db.close();
  const calls=[];
  const adapter={
   async stop(){calls.push('stop')},
   async backup(){calls.push('backup');return runMaintenance({root:f.root,dataDir:f.data,backupDir:backups,command:'backup'})},
   async restore(_root,id){calls.push('restore');return runMaintenance({root:f.root,dataDir:f.data,backupDir:backups,command:'restore',id,confirm:true})},
   async up(){calls.push('up')},async health(){calls.push('health')},
   async observe(){calls.push('observe');return {observedStable:true,samplesCompleted:3}},
   async activate(){calls.push('activate')}
  };
  const res=await applyUpgrade({root:f.root,zipPath:candidate,confirm:true,adapter});
  assert.equal(res.upgraded,true);assert.equal(res.publisher.verified,true);
  assert.equal((await readFile(join(f.root,SIGNATURE_PATH))).toString().includes('signature'),true);
  assert.equal((await getUpgradeStatus({root:f.root})).history[0].publisher.verified,true);
  assert.deepEqual(calls,['stop','backup','up','health','observe','activate']);
  const opened=new DatabaseSync(join(f.data,'crm.sqlite'),{readOnly:true});
  assert.equal(opened.prepare('SELECT value FROM facts').get().value,'original');opened.close();
  assert.equal(JSON.parse(await readFile(join(f.root,'manifest.json'))).release.sequence,1);
  await assert.rejects(planUpgrade({root:f.root,zipPath:f.unsignedPath}),/Unsigned release refused|higher/);
 }finally{await f.close()}
});

test('R3.0: failed signed rollout restores old code and SQLite and removes new detached signature', {timeout:60000},async()=>{
 const f=await fixture();try{
  const k=keys(),candidate=join(f.base,'signed.zip');await pin(f.root,k.publicPem);
  await writeFile(candidate,signZip(f.unsigned,k.privatePem));
  const backups=join(f.root,'backups');await mkdir(backups,{mode:0o700});await chmod(backups,0o700);
  await writeFile(join(f.root,'.env'),'APP_DOMAIN='+domain+'\nSETUP_TOKEN=synthetic-test-token\n',{mode:0o600});
  const db=new DatabaseSync(join(f.data,'crm.sqlite'));db.exec("CREATE TABLE facts(value TEXT);INSERT INTO facts VALUES('original')");db.close();
  const adapter={async stop(){},async backup(){return runMaintenance({root:f.root,dataDir:f.data,backupDir:backups,command:'backup'})},
   async restore(_root,id){return runMaintenance({root:f.root,dataDir:f.data,backupDir:backups,command:'restore',id,confirm:true})},
   async up(){},async health(){},async observe(){const x=new DatabaseSync(join(f.data,'crm.sqlite'));x.exec("UPDATE facts SET value='wrong'");x.close();throw Error('synthetic probe failure')},
   async activate(){}
  };
  await assert.rejects(applyUpgrade({root:f.root,zipPath:candidate,confirm:true,adapter}),/old version restored/);
  assert.equal(JSON.parse(await readFile(join(f.root,'manifest.json'))).release.sequence,0);
  await assert.rejects(readFile(join(f.root,SIGNATURE_PATH)),/ENOENT/);
  const opened=new DatabaseSync(join(f.data,'crm.sqlite'),{readOnly:true});
  assert.equal(opened.prepare('SELECT value FROM facts').get().value,'original');opened.close();
 }finally{await f.close()}
});

test('R3.0: once trust storage exists, missing publisher key must NEVER downgrade to unsigned compatibility',async()=>{
 const f=await fixture();try{
  await mkdir(join(f.root,'.osmanx-trust'),{mode:0o700});
  await assert.rejects(planUpgrade({root:f.root,zipPath:f.unsignedPath}),/release-public.pem is missing/);
  const k=keys();const signed=join(f.base,'signed.zip');await writeFile(signed,signZip(f.unsigned,k.privatePem));
  await assert.rejects(planUpgrade({root:f.root,zipPath:signed}),/release-public.pem is missing/);
 }finally{await f.close()}
});
