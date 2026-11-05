/** R3.2 reproducible, synthetic-only offline release acceptance (no network or Docker). */
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,rm,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {makeReleaseSignature,SIGNATURE_PATH} from '../templates/deploy/signature.mjs';
import {managePublisherTrust} from '../templates/deploy/trust-policy.mjs';
import {runMaintenance} from '../templates/deploy/maintenance.mjs';
import {inspectDeployment,writeAcceptanceReport} from '../templates/deploy/doctor.mjs';
const source=resolve(import.meta.dirname,'..');
async function main(){
 const base=await mkdtemp(join(tmpdir(),'osmanx-r32-acceptance-'));
 try{
  const root=join(base,'app'),backupDir=join(root,'backups'),dataDir=join(base,'db');
  await mkdir(root);await mkdir(backupDir,{mode:0o700});await chmod(backupDir,0o700);await mkdir(dataDir);
  const id=randomUUID(),domain='release.example.org';
  const p={id,name:'Synthetic R3.2 Acceptance',type:'crm',industry:'restaurant',
   modules:['auth','clients','tasks'],settings:{accent:'#678c7c',currency:'RUB',primaryAction:'navigate_overview'},
   pages:[],entities:[],automationPresets:[]};
  const entries=parseStoredZip(await exportDeploymentBundle(p,source,domain),{maxFiles:400,maxBytes:80*1024*1024});
  const pair=generateKeyPairSync('ed25519');
  entries.set(SIGNATURE_PATH,makeReleaseSignature(entries,pair.privateKey.export({type:'pkcs8',format:'pem'})));
  for(const [name,data] of entries){await mkdir(dirname(join(root,name)),{recursive:true});await writeFile(join(root,name),data)}
  const keyPath=join(base,'test-only-public.pem');
  await writeFile(keyPath,pair.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
  const trust=await managePublisherTrust({root,action:'init',keyPath,confirm:true});
  assert.equal(trust.active,1);
  const token=randomBytes(32).toString('hex');
  await writeFile(join(root,'.env'),`APP_DOMAIN=${domain}\nHOST=0.0.0.0\nPORT=4180\nDATA_DIR=/app/data\nCOOKIE_SECURE=1\nSETUP_TOKEN=${token}\n`,{mode:0o600});
  const db=new DatabaseSync(join(dataDir,'crm.sqlite'));
  db.exec('CREATE TABLE synthetic_probe (id INTEGER PRIMARY KEY, text TEXT NOT NULL);');
  db.prepare('INSERT INTO synthetic_probe(text) VALUES(?)').run('TEST-DATA-ONLY');db.close();
  const backup=await runMaintenance({root,dataDir,backupDir,command:'backup'});
  const drill=await runMaintenance({root,dataDir,backupDir,command:'drill',id:backup.id});
  assert.equal(drill.productionDataUntouched,true);
  const report=await inspectDeployment({root});
  assert(report.checks.filter(c=>c.status==='fail').length===0,JSON.stringify(report.checks));
  assert.equal(report.checks.find(c=>c.id==='publisher').status,'pass');
  assert.equal(report.checks.find(c=>c.id==='inventory').status,'pass');
  assert.equal(report.checks.find(c=>c.id==='secrets').status,'pass');
  assert.equal(report.fullTechnicalGatePassed,false,'Offline acceptance must never claim public readiness');
  const outArg=process.argv.find(v=>v.startsWith('--out='));
  if(outArg)await writeAcceptanceReport(outArg.slice(6),report);
  console.log(JSON.stringify({ok:true,syntheticOnly:true,offlineAcceptancePassed:true,
   unitOfWork:'signed client ZIP + backup + disposable restore + doctor',
   inventoryVerified:true,publisherVerified:true,restoreDrillPassed:true,
   dockerExecuted:false,httpsExecuted:false,releaseSequence:report.releaseSequence},null,2));
 }finally{await rm(base,{recursive:true,force:true})}
}
main().catch(e=>{console.error('R3.2 OFFLINE ACCEPTANCE FAILED: '+e.message);process.exitCode=1});
