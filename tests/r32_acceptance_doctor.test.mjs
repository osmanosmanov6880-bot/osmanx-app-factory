import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,chmod,symlink,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {makeReleaseSignature,SIGNATURE_PATH} from '../templates/deploy/signature.mjs';
import {managePublisherTrust} from '../templates/deploy/trust-policy.mjs';
import {inspectDeployment,writeAcceptanceReport} from '../templates/deploy/doctor.mjs';
const source=resolve(import.meta.dirname,'..');
const id='a5589900-0a31-43bb-a877-335588990033',domain='doctor.osmanx.co';
const secret='PRIVATE_TOKEN_'+randomBytes(30).toString('hex');
const project=type=>({id,name:'Private Fixture',type,industry:type==='crm'?'restaurant':'business',
 modules:type==='crm'?['auth','clients','tasks']:['auth','cms','leads'],settings:{accent:'#558877',currency:'RUB',primaryAction:'navigate_overview'},
 pages:[],entities:[],automationPresets:[]});
const entries=bytes=>parseStoredZip(bytes,{maxFiles:400,maxBytes:80e6});
async function fixture(type='crm'){
 const base=await mkdtemp(join(tmpdir(),'osmanx-r32-doctor-')),root=join(base,'app');await mkdir(root);
 const zipped=entries(await exportDeploymentBundle(project(type),source,domain));
 const pair=generateKeyPairSync('ed25519');
 zipped.set(SIGNATURE_PATH,makeReleaseSignature(zipped,pair.privateKey.export({format:'pem',type:'pkcs8'})));
 for(const [name,data] of zipped){await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),data)}
 const pub=join(base,'test-public.pem');await writeFile(pub,pair.publicKey.export({format:'pem',type:'spki'}),{mode:0o600});
 await managePublisherTrust({root,action:'init',keyPath:pub,confirm:true});
 const port=type==='site'?'4181':'4180';
 await writeFile(join(root,'.env'),`APP_DOMAIN=${domain}\nHOST=0.0.0.0\nPORT=${port}\nCOOKIE_SECURE=1\nSETUP_TOKEN=${secret}\n${type==='site'?'PUBLIC_SITE_URL=https://'+domain+'\n':''}`,{mode:0o600});
 await mkdir(join(root,'backups'),{mode:0o700});await chmod(join(root,'backups'),0o700);
 return {root,base,close:()=>rm(base,{recursive:true,force:true})};
}
const status=(r,id)=>r.checks.find(c=>c.id===id)?.status;

test('R3.2 doctor: offline checks validate signature and secrets but never claim Docker or public HTTPS',async()=>{
 for(const type of ['crm','site']){
  const f=await fixture(type);try{
   const r=await inspectDeployment({root:f.root});
   for(const name of ['inventory','publisher','secrets','backups','upgrade'])assert.equal(status(r,name),'pass');
   assert.equal(status(r,'docker'),'warning');assert.equal(status(r,'https'),'warning');
   assert.equal(r.offlineOnly,true);assert.equal(r.fullTechnicalGatePassed,false);
   assert.equal(r.productionCertification,false);
   assert.equal(JSON.stringify(r).includes(secret),false,'Never print .env values');
   const out=join(f.base,'acceptance.json');await writeAcceptanceReport(out,r);
   assert.equal(JSON.parse(await readFile(out,'utf8')).sha256,r.sha256);
   await assert.rejects(writeAcceptanceReport(out,r),/EEXIST/);
   if(process.platform!=='win32')assert.equal((await stat(out)).mode&0o077,0);
  }finally{await f.close()}
 }
});

test('R3.2 doctor: Docker and public live probe are opt-in, enforce installed project and release identity',async()=>{
 const f=await fixture('crm');try{
  let dockerCalls=0,liveCalls=0;
  const r=await inspectDeployment({root:f.root,docker:true,live:true,
   dockerRun:async()=>{dockerCalls++;return {status:0}},
   liveProbe:async(name,{expected})=>{
    liveCalls++;assert.equal(name,domain);assert.equal(expected.projectId,id);
    assert.equal(expected.service,'osmanx-business-crm');assert.equal(expected.releaseSequence,0);
    return {ok:true,identityVerified:true,sslCertificateValidated:true};
   }});
  assert.equal(dockerCalls,1);assert.equal(liveCalls,1);
  assert.equal(status(r,'docker'),'pass');assert.equal(status(r,'https'),'pass');
  assert.equal(r.fullTechnicalGatePassed,true);
  assert.equal(r.productionCertification,false);
  const denied=await inspectDeployment({root:f.root,docker:true,live:true,
   dockerRun:async()=>({status:1}),liveProbe:async()=>({ok:true,identityVerified:false,sslCertificateValidated:true})});
  assert.equal(status(denied,'docker'),'fail');assert.equal(status(denied,'https'),'fail');
 }finally{await f.close()}
});

test('R3.2 doctor: rejects tampered managed files, unsafe secrets and pending upgrade, no private data in report',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.root,'deploy/healthcheck.mjs'),'tampered managed file');
  let r=await inspectDeployment({root:f.root});assert.equal(status(r,'inventory'),'fail');
  assert.equal(JSON.stringify(r).includes(secret),false);
  if(process.platform!=='win32'){
   await chmod(join(f.root,'.env'),0o644);
   r=await inspectDeployment({root:f.root});assert.equal(status(r,'secrets'),'fail');
  }
  await mkdir(join(f.root,'.osmanx-upgrades'));await writeFile(join(f.root,'.osmanx-upgrades','active.json'),'{}');
  r=await inspectDeployment({root:f.root});assert.equal(status(r,'upgrade'),'fail');
 }finally{await f.close()}
});

test('R3.2: every exported CRM and site contains tracked doctor and key rotation, no secrets or private trust files',async()=>{
 for(const type of ['crm','site']){
  const e=entries(await exportDeploymentBundle(project(type),source,domain));
  const meta=JSON.parse(e.get('deploy/manifest.json'));
  for(const name of ['deploy/trust-policy.mjs','deploy/doctor.mjs']){
   assert.ok(e.has(name));assert.match(meta.files[name],/^[0-9a-f]{64}$/);
  }
  const dockerignore=e.get('.dockerignore').toString();
  assert.match(dockerignore,/\.osmanx-trust/);
  assert.match(dockerignore,/\.osmanx-acceptance/);
  assert.equal(e.has('deploy/release-signature.json'),false);
  assert.equal(e.has('.env'),false);
  assert.equal(e.has('.osmanx-trust/release-keyring.json'),false);
  assert.match(e.get('.gitignore').toString(),/\.osmanx-trust/);
  assert.match(e.get('.gitignore').toString(),/\*\.pem/);
 }
});
