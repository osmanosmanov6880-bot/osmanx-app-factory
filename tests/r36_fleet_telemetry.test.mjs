import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {parseStoredZip} from '../src/common/archive.mjs';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {createFleetSnapshot} from '../templates/deploy/fleet-agent.mjs';
import {validateFleetEnvelope,pinFleetIdentity,importFleetSnapshot,fleetOverview,fleetStatus} from '../src/studio/fleet.mjs';
import {studioDb} from '../src/studio/db.mjs';
const root=resolve(import.meta.dirname,'..');
const checks=()=>['inventory','publisher','secrets','backups','upgrade','docker','https'].map(id=>({id,status:['docker','https'].includes(id)?'warning':'pass'}));
const metric={status:'observed',windowHours:24,capturedAt:new Date().toISOString(),requests:25,clientErrors:2,serverErrors:1,maintenanceUnavailable:0};
const fingerprint=key=>createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex');
const packet=(payload,key)=>({payload,algorithm:'Ed25519',signature:sign(null,Buffer.from(JSON.stringify(payload)),key.privateKey).toString('base64'),keyFingerprint:fingerprint(key.publicKey)});
const project=id=>({id,type:'crm',industry:'restaurant',name:'Synthetic',modules:['auth','clients'],settings:{accent:'#123456',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]});

test('R3.6 signed v3 accepts only a bounded telemetry summary from matching installation',async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'r36-fleet-'));const id=randomUUID(),key=generateKeyPairSync('ed25519');
 try{
  const entries=parseStoredZip(await exportDeploymentBundle(project(id),root,'crm.example.net'),{maxFiles:450,maxBytes:90e6});
  for(const [name,data] of entries){const dest=join(tmp,name);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,data)}
  const data=await createFleetSnapshot({root:tmp,telemetry:true,doctor:async()=>({format:'osmanx-deployment-acceptance',version:1,projectId:id,releaseSequence:0,checks:checks()}),readTelemetry:async()=>metric});
  const pub=key.publicKey.export({format:'pem',type:'spki'});
  assert.equal(data.version,3);assert.equal(data.requestedTelemetry,true);assert.deepEqual(data.telemetry,metric);
  validateFleetEnvelope(packet(data,key),pub,id);
  for(const value of [{...metric,serverErrors:26},{...metric,host:'private'}, {...metric,requests:'25'}, {...metric,capturedAt:'not a date'}]){
   assert.throws(()=>validateFleetEnvelope(packet({...data,telemetry:value},key),pub,id),/telemetry/);
  }
  assert.throws(()=>validateFleetEnvelope(packet({...data,requestedTelemetry:false},key),pub,id),/telemetry/);
  assert.throws(()=>validateFleetEnvelope(packet(data,{...key,privateKey:generateKeyPairSync('ed25519').privateKey}),pub,id),/signature/);
 }finally{await rm(tmp,{recursive:true,force:true})}
});

test('R3.6 owner-scoped fleet dashboard preserves telemetry without exposing other tenants',async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'r36-tenant-'));const db=studioDb(join(tmp,'studio.sqlite'));
 try{
  const owner=randomUUID(),other=randomUUID(),id=randomUUID(),otherId=randomUUID(),ts=new Date().toISOString();
  const u=db.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)');
  u.run(owner,'r36-o@example.org','Owner','test','owner',ts);u.run(other,'r36-t@example.org','Tenant','test','owner',ts);
  const p=db.prepare('INSERT INTO projects(id,owner_id,name,type,industry,modules_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)');
  p.run(id,owner,'Main CRM','crm','restaurant','[]','{}',ts,ts);p.run(otherId,other,'Secret CRM','crm','restaurant','[]','{}',ts,ts);
  const key=generateKeyPairSync('ed25519');const pub=key.publicKey.export({format:'pem',type:'spki'});
  pinFleetIdentity(db,owner,id,pub);
  const payload={format:'osmanx-fleet-status',version:3,projectId:id,service:'crm',releaseSequence:2,
   observedAt:new Date(Date.now()-1000).toISOString(),nonce:'a'.repeat(32),offlineOnly:true,
   checks:Object.fromEntries(checks().map(x=>[x.id,x.status])),requestedChecks:{docker:false,https:false},requestedTelemetry:true,
   telemetry:{...metric,capturedAt:new Date(Date.now()-2000).toISOString()}};
  const report=importFleetSnapshot(db,owner,id,packet(payload,key));
  assert.equal(report.telemetry.serverErrors,1);assert.equal(report.health,'warning');
  assert.equal(fleetOverview(db,owner).counts.reportedServerErrors,1);
  assert.equal(fleetOverview(db,other).counts.reportedServerErrors,0);
  assert.throws(()=>fleetStatus(db,other,id),/Project not found/);
  assert.throws(()=>importFleetSnapshot(db,owner,id,packet(payload,key)),/replayed/);
 }finally{db.close();await rm(tmp,{recursive:true,force:true})}
});
