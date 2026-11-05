import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, generateKeyPairSync, sign} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {initFleetIdentity,getFleetPublicKey,createFleetSnapshot,signFleetSnapshot,saveFleetSnapshot} from '../templates/deploy/fleet-agent.mjs';
import {parseFleetPublicKey,validateFleetEnvelope} from '../src/studio/fleet.mjs';
const source=resolve(import.meta.dirname,'..');
const project=(type,id)=>({id,name:'Fleet Test',type,industry:type==='site'?'business':'restaurant',
 modules:type==='site'?['auth','cms','leads']:['auth','clients','tasks'],
 settings:{accent:'#456789',primaryAction:'navigate_overview',currency:'RUB'},pages:[],entities:[],automationPresets:[]});
async function fixture(type='crm'){
 const root=await mkdtemp(join(tmpdir(),'ox-r34-agent-'));
 const id=randomUUID();
 const entries=parseStoredZip(await exportDeploymentBundle(project(type,id),source,'fleet.example.org'),{maxFiles:450,maxBytes:90e6});
 for(const [name,data] of entries){await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),data)}
 return {root,id,entries,cleanup:()=>rm(root,{force:true,recursive:true})};
}

test('R3.4 exported CRM and site create signed private offline status and contain no customer data',{timeout:60000},async()=>{
 for(const type of ['crm','site']){
  const f=await fixture(type);
  try{
   assert.ok(f.entries.has('deploy/fleet-agent.mjs'));
   assert.ok(!f.entries.has('.osmanx-fleet/agent-private.pem'));
   assert.match(f.entries.get('.dockerignore').toString(),/\.osmanx-fleet/);
   assert.match(f.entries.get('.gitignore').toString(),/\.osmanx-fleet/);
   const {publicKeyPem,fingerprint}=await initFleetIdentity(f.root);
   assert.equal((await getFleetPublicKey(f.root)).fingerprint,fingerprint);
   if(process.platform!=='win32')assert.equal((await lstat(join(f.root,'.osmanx-fleet'))).mode&0o077,0);
   await assert.rejects(initFleetIdentity(f.root),/EEXIST/);
   const payload=await createFleetSnapshot({root:f.root});
   assert.equal(payload.projectId,f.id);assert.equal(payload.service,type);
   assert.equal(payload.offlineOnly,true);assert.equal(payload.checks.inventory,'pass');
   assert.equal(payload.checks.https,'warning');
   assert.deepEqual(Object.keys(payload.checks),['inventory','publisher','secrets','backups','upgrade','docker','https']);
   const packet=await signFleetSnapshot({root:f.root,payload});
   assert.deepEqual(validateFleetEnvelope(packet,publicKeyPem,f.id),payload);
   const exported=join(dirname(f.root),'fleet-status-'+f.id+'.json');
   await assert.rejects(saveFleetSnapshot(join(f.root,'fleet-status.json'),packet,{root:f.root}),/outside/);
   await saveFleetSnapshot(exported,packet,{root:f.root});
   const saved=await readFile(exported,'utf8');
   assert.ok(!saved.includes('SETUP_TOKEN'));assert.ok(!saved.includes('example.org'));
   assert.ok(!saved.includes('patient'));assert.equal(parseFleetPublicKey(publicKeyPem).fingerprint,fingerprint);
   await assert.rejects(saveFleetSnapshot(exported,packet),/EEXIST/);
   await rm(exported,{force:true});
  }finally{await f.cleanup()}
 }
});

test('R3.4 refuse tampering, wrong signatures, replay fields and unbounded timestamps',{timeout:60000},async()=>{
 const f=await fixture();try{
  const {publicKeyPem}=await initFleetIdentity(f.root);
  const p=await createFleetSnapshot({root:f.root});const packet=await signFleetSnapshot({root:f.root,payload:p});
  const verify=body=>validateFleetEnvelope(body,publicKeyPem,f.id);
  assert.equal(verify(packet).projectId,f.id);
  assert.throws(()=>verify({...packet,payload:{...p,releaseSequence:1}}),/signature/);
  assert.throws(()=>verify({...packet,payload:{...p,clientName:'Private'}}),/identity/);
  assert.throws(()=>verify({...packet,payload:{...p,checks:{...p.checks,clients:'pass'}}}),/checks/);
  assert.throws(()=>verify({...packet,algorithm:'none'}),/signed/);
  assert.throws(()=>validateFleetEnvelope(packet,publicKeyPem,randomUUID()),/identity/);
  assert.throws(()=>verify({...packet,signature:'x'}),/signature encoding/);
  const alien=generateKeyPairSync('ed25519');
  const forged={...packet,signature:sign(null,Buffer.from(JSON.stringify(p)),alien.privateKey).toString('base64')};
  assert.throws(()=>verify(forged),/signature/);
  assert.throws(()=>verify({...packet,payload:{...p,observedAt:'2020-01-01T00:00:00.000Z'}}),/too old/);
 }finally{await f.cleanup()}
});

test('R3.4 key file permissions cannot be weakened for telemetry signing',{timeout:60000},async()=>{
 if(process.platform==='win32')return;
 const f=await fixture();try{
  await initFleetIdentity(f.root);
  await chmod(join(f.root,'.osmanx-fleet','agent-private.pem'),0o644);
  const p=await createFleetSnapshot({root:f.root});
  await assert.rejects(signFleetSnapshot({root:f.root,payload:p}),/private key permissions/);
 }finally{await f.cleanup()}
});
