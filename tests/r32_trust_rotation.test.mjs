import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {createZip} from '../src/common/zip.mjs';
import {SIGNATURE_PATH,makeReleaseSignature} from '../templates/deploy/signature.mjs';
import {getPublisherTrustStatus,managePublisherTrust} from '../templates/deploy/trust-policy.mjs';
import {planUpgrade} from '../templates/deploy/upgrade.mjs';
const source=resolve(import.meta.dirname,'..');
const id='f2233445-0a31-43bb-a877-335588990022';
const domain='rotate.example.org';
const project=n=>({id,name:n,type:'crm',industry:'restaurant',modules:['auth','clients','tasks'],
 settings:{accent:'#558877',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]});
const release=p=>({id:'aabbbbbb-1111-4222-8333-cccccccccccc',sequence:1,
 snapshotSha256:createHash('sha256').update(JSON.stringify(p)).digest('hex'),createdAt:'2026-11-05T00:00:00Z'});
const pair=()=>{const p=generateKeyPairSync('ed25519');return {
 privatePem:p.privateKey.export({format:'pem',type:'pkcs8'}),publicPem:p.publicKey.export({format:'pem',type:'spki'})}};
async function sandbox(){
 const base=await mkdtemp(join(tmpdir(),'osmanx-r32-trust-')),installed=join(base,'app');await mkdir(installed);
 const current=parseStoredZip(await exportDeploymentBundle(project('Old'),source,domain),{maxFiles:400,maxBytes:80e6});
 for(const [name,buf] of current){await mkdir(dirname(join(installed,name)),{recursive:true});await writeFile(join(installed,name),buf)}
 const next=project('New');const update=parseStoredZip(await exportDeploymentBundle(next,source,domain,release(next)),{maxFiles:400,maxBytes:80e6});
 return {base,installed,update,close:()=>rm(base,{recursive:true,force:true})};
}
async function signed(f,k,name){const e=new Map(f.update);e.set(SIGNATURE_PATH,makeReleaseSignature(e,k.privatePem));
 const path=join(f.base,name);await writeFile(path,createZip([...e].map(([name,data])=>({name,data}))));return path}
async function storeKey(f,k,n){const path=join(f.base,n+'.pem');await writeFile(path,k.publicPem,{mode:0o600});return path}

test('R3.2 keyring: migrate pinned legacy key, stage second key, revoke old and block old signatures',{timeout:60000},async()=>{
 const f=await sandbox();try{
  const a=pair(),b=pair();const aPath=await storeKey(f,a,'old'),bPath=await storeKey(f,b,'new');
  const trustDir=join(f.installed,'.osmanx-trust');await mkdir(trustDir,{mode:0o700});
  await writeFile(join(trustDir,'release-public.pem'),a.publicPem,{mode:0o600});
  const old=await signed(f,a,'old.zip'),newer=await signed(f,b,'new.zip');
  assert.equal((await getPublisherTrustStatus(f.installed)).mode,'legacy');
  assert.equal((await planUpgrade({root:f.installed,zipPath:old})).summary.publisher.verified,true);
  await assert.rejects(managePublisherTrust({root:f.installed,action:'init',keyPath:bPath,confirm:true}),/match the existing pinned legacy/);
  await assert.rejects(managePublisherTrust({root:f.installed,action:'init',keyPath:aPath}),/requires --confirm/);
  const badPrivate=join(f.base,'private-material.pem');await writeFile(badPrivate,a.privatePem,{mode:0o600});
  await assert.rejects(managePublisherTrust({root:f.installed,action:'init',keyPath:badPrivate,confirm:true}),/PUBLIC KEY PEM/);
  const init=await managePublisherTrust({root:f.installed,action:'init',keyPath:aPath,confirm:true});
  assert.equal(init.active,1);
  const add=await managePublisherTrust({root:f.installed,action:'add',keyPath:bPath,confirm:true});
  assert.equal(add.active,2);
  assert.equal((await planUpgrade({root:f.installed,zipPath:old})).summary.publisher.verified,true);
  assert.equal((await planUpgrade({root:f.installed,zipPath:newer})).summary.publisher.verified,true);
  await assert.rejects(planUpgrade({root:f.installed,zipPath:old,trustKeyPath:aPath}),/cannot be bypassed/);
  const revoke=await managePublisherTrust({root:f.installed,action:'revoke',target:init.fingerprint,confirm:true});
  assert.equal(revoke.active,1);
  await assert.rejects(planUpgrade({root:f.installed,zipPath:old}),/revoked/);
  assert.equal((await planUpgrade({root:f.installed,zipPath:newer})).summary.publisher.verified,true);
  await assert.rejects(managePublisherTrust({root:f.installed,action:'add',keyPath:aPath,confirm:true}),/permanently revoked/);
  await assert.rejects(managePublisherTrust({root:f.installed,action:'revoke',target:add.fingerprint,confirm:true}),/last active/);
  const status=await getPublisherTrustStatus(f.installed);
  assert.deepEqual(status.keys.map(x=>x.status),['revoked','active']);
 }finally{await f.close()}
});

test('R3.2 keyring: policy tampering, incomplete directory and mismatched file are rejected',{timeout:40000},async()=>{
 const f=await sandbox();try{
  const a=pair();const key=await storeKey(f,a,'only');
  await managePublisherTrust({root:f.installed,action:'init',keyPath:key,confirm:true});
  const trust=join(f.installed,'.osmanx-trust');const status=await getPublisherTrustStatus(f.installed);
  const target=join(trust,'keys',status.keys[0].fingerprint+'.pem');
  await writeFile(target,pair().publicPem);
  await assert.rejects(getPublisherTrustStatus(f.installed),/fingerprint does not match/);
  await writeFile(target,a.publicPem);
  const policyFile=join(trust,'release-keyring.json');const good=JSON.parse(await readFile(policyFile,'utf8'));
  good.keys.push({...good.keys[0]});await writeFile(policyFile,JSON.stringify(good));
  await assert.rejects(getPublisherTrustStatus(f.installed),/duplicate/);
  good.keys.pop();await writeFile(policyFile,JSON.stringify(good));
  if(process.platform!=='win32'){
   await chmod(policyFile,0o666);await assert.rejects(getPublisherTrustStatus(f.installed),/must not be writable/);
   await chmod(policyFile,0o600);
  }
  await rm(policyFile);await assert.rejects(getPublisherTrustStatus(f.installed),/incomplete/);
 }finally{await f.close()}
});
