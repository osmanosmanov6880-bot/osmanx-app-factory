import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm,mkdir,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {studioDb} from '../src/studio/db.mjs';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {initFleetIdentity,createFleetSnapshot,signFleetSnapshot,saveFleetSnapshot} from '../templates/deploy/fleet-agent.mjs';
import {validateFleetEnvelope,pinFleetIdentity,importFleetSnapshot,fleetStatus,fleetOverview} from '../src/studio/fleet.mjs';

const values=(docker='warning',https='warning')=>({inventory:'pass',publisher:'pass',secrets:'pass',backups:'pass',upgrade:'pass',docker,https});
const packet=(id,key,payload)=>({payload,signature:sign(null,Buffer.from(JSON.stringify(payload)),key.privateKey).toString('base64'),algorithm:'Ed25519',keyFingerprint:__fp(key.publicKey)});
import {createHash} from 'node:crypto';
const __fp=key=>createHash('sha256').update(key.export({format:'der',type:'spki'})).digest('hex');
const at=(offsetMs)=>new Date(Date.now()+offsetMs).toISOString();
const v2=(projectId,releaseSequence,offsetMs,requestedChecks)=>({format:'osmanx-fleet-status',version:2,projectId,service:'crm',releaseSequence,observedAt:at(offsetMs),nonce:__fp(generateKeyPairSync('ed25519').publicKey).slice(0,32),offlineOnly:!requestedChecks.docker&&!requestedChecks.https,checks:values(requestedChecks.docker?'pass':'warning',requestedChecks.https?'pass':'warning'),requestedChecks});
const identity=()=>generateKeyPairSync('ed25519');

test('R3.5 signed opt-in evidence is not accepted as verified unless requested',{timeout:10000},()=>{
 const id=randomUUID(),key=identity();
 const p=v2(id,2,-2000,{docker:true,https:true});
 assert.equal(validateFleetEnvelope(packet(id,key,p),key.publicKey.export({format:'pem',type:'spki'}),id).requestedChecks.https,true);
 const forged={...p,requestedChecks:{docker:false,https:true}};
 assert.throws(()=>validateFleetEnvelope(packet(id,key,forged),key.publicKey.export({format:'pem',type:'spki'}),id),/requested checks/);
 const unsupported={...p,requestedChecks:{docker:true,https:false}};
 assert.throws(()=>validateFleetEnvelope(packet(id,key,unsupported),key.publicKey.export({format:'pem',type:'spki'}),id),/requested checks/);
});

test('R3.5 owner portfolio separates projects and marks release rollback, opt-in HTTPS only',{timeout:20000},async()=>{
 const temp=await mkdtemp(join(tmpdir(),'r35-fleet-db-'));const db=studioDb(join(temp,'studio.sqlite'));
 try{
  const owner=randomUUID(),other=randomUUID(),id=randomUUID(),otherId=randomUUID(),now=new Date().toISOString();
  const insUser=db.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)');
  insUser.run(owner,'o35@test.example','Owner','test','owner',now);insUser.run(other,'a35@test.example','Alien','test','owner',now);
  const insProj=db.prepare('INSERT INTO projects(id,owner_id,name,type,industry,modules_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)');
  insProj.run(id,owner,'Actual CRM','crm','restaurant','[]','{}',now,now);insProj.run(otherId,other,'Private CRM','crm','restaurant','[]','{}',now,now);
  const key=identity(),pub=key.publicKey.export({format:'pem',type:'spki'});
  pinFleetIdentity(db,owner,id,pub);
  const previous=v2(id,5,-30000,{docker:false,https:false});
  previous.version=1;delete previous.requestedChecks;
  importFleetSnapshot(db,owner,id,packet(id,key,previous));
  const later=v2(id,4,-10000,{docker:true,https:true});
  importFleetSnapshot(db,owner,id,packet(id,key,later));
  const status=fleetStatus(db,owner,id);
  assert.equal(status.health,'rollback');assert.equal(status.evidence.httpsVerified,true);
  assert.equal(status.evidence.dockerConfigChecked,true);assert.equal(status.evidence.liveMonitoring,false);
  const view=fleetOverview(db,owner);assert.equal(view.total,1);assert.equal(view.rows[0].name,'Actual CRM');
  assert.equal(view.rows[0].observedRollback,true);assert.equal(view.counts.needsAttention,1);
  const alien=fleetOverview(db,other);assert.equal(alien.total,1);assert.equal(alien.rows[0].name,'Private CRM');assert.equal(alien.rows[0].trusted,false);
 }finally{db.close();await rm(temp,{recursive:true,force:true})}
});

test('R3.5 client agent explicitly scopes Docker/HTTPS evidence and prevents redirected output inside install',{timeout:30000},async()=>{
 const base=await mkdtemp(join(tmpdir(),'r35-client-evidence-'));
 try{
  const root=join(base,'install'),id=randomUUID();await mkdir(root);
  const project={id,type:'crm',industry:'restaurant',name:'Synthetic',modules:['auth','clients','tasks'],settings:{accent:'#456789',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]};
  const entries=parseStoredZip(await exportDeploymentBundle(project,resolve(import.meta.dirname,'..'),'client.example.org'),{maxFiles:450,maxBytes:90e6});
  for(const [name,bytes] of entries){const target=join(root,name);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes)}
  const key=await initFleetIdentity(root),calls=[];
  const doctor=async flags=>{
   calls.push({docker:flags.docker,live:flags.live});
   return {format:'osmanx-deployment-acceptance',version:1,projectId:id,releaseSequence:0,
    checks:Object.entries(values('pass','pass')).map(([id,status])=>({id,status}))};
  };
  const payload=await createFleetSnapshot({root,doctor,docker:true,live:true});
  assert.equal(payload.version,2);assert.equal(payload.offlineOnly,false);
  assert.deepEqual(calls,[{docker:true,live:true}]);
  const signed=await signFleetSnapshot({root,payload});
  validateFleetEnvelope(signed,key.publicKeyPem,id);
  await assert.rejects(createFleetSnapshot({root,doctor,docker:false,live:false}),/Unrequested Docker/);
  if(process.platform!=='win32'){
   const redirect=join(base,'redirect');await symlink(root,redirect);
   await assert.rejects(saveFleetSnapshot(join(redirect,'bad.json'),signed,{root}),/outside/);
  }
  const saved=await saveFleetSnapshot(join(base,'safe.json'),signed,{root});assert.equal(saved,join(base,'safe.json'));
 }finally{await rm(base,{recursive:true,force:true})}
});
