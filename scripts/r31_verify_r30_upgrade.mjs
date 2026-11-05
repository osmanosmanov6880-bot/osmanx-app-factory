/** Manual compatibility acceptance: supply old R3.0 sample kits via CLI, no Docker. */
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {parseStoredZip} from '../src/common/archive.mjs';
import {createZip} from '../src/common/zip.mjs';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {SIGNATURE_PATH,makeReleaseSignature} from '../templates/deploy/signature.mjs';
import {planUpgrade,applyUpgrade} from '../templates/deploy/upgrade.mjs';
import {runMaintenance} from '../templates/deploy/maintenance.mjs';
const source=resolve(import.meta.dirname,'..');
const args=process.argv.slice(2);
const oldKits=args.filter(s=>s.endsWith('.zip')).map(s=>resolve(s));
const outDir=resolve(args.find(s=>s.startsWith('--out='))?.slice(6)||join(source,'../../r31_matching_pairs'));
assert.equal(oldKits.length,2,'Usage: node scripts/r31_verify_r30_upgrade.mjs OLD_R30_CRM.zip OLD_R30_SITE.zip --out=PATH');
await mkdir(outDir,{recursive:true});
const results=[];
for(const oldPath of oldKits){
 const base=await mkdtemp(join(tmpdir(),'osmanx-r31-real-r30-'));
 try{
  const oldZip=await readFile(oldPath);const entries=parseStoredZip(oldZip,{maxFiles:400,maxBytes:80*1024*1024});
  const meta=JSON.parse(entries.get('deploy/manifest.json')),oldApp=JSON.parse(entries.get('manifest.json'));
  const existing=JSON.parse(entries.get('config/project.json'));const type=existing.type;
  assert.ok(['crm','site'].includes(type));assert.equal(meta.projectId,existing.id);
  const appRoot=join(base,'installed'),data=join(base,'data'),backups=join(appRoot,'backups');
  await mkdir(appRoot);await mkdir(data);await mkdir(backups,{mode:0o700});await chmod(backups,0o700);
  for(const [name,buf] of entries){await mkdir(dirname(join(appRoot,name)),{recursive:true});await writeFile(join(appRoot,name),buf)}
  await writeFile(join(appRoot,'.env'),'APP_DOMAIN='+meta.domain+'\nSETUP_TOKEN=synthetic-only\n',{mode:0o600});
  const db=new DatabaseSync(join(data,type==='site'?'site.sqlite':'crm.sqlite'));
  db.exec("CREATE TABLE r31_marker(value TEXT);INSERT INTO r31_marker VALUES('r30-data')");db.close();
  const next={...existing,name:existing.name+' R3.1 upgrade'};
  const rel={id:randomUUID(),sequence:oldApp.release.sequence+1,createdAt:new Date().toISOString(),
   snapshotSha256:createHash('sha256').update(JSON.stringify(next)).digest('hex')};
  const nextFiles=parseStoredZip(await exportDeploymentBundle(next,source,meta.domain,rel),{maxFiles:400,maxBytes:80*1024*1024});
  const pair=generateKeyPairSync('ed25519');
  const privatePem=pair.privateKey.export({format:'pem',type:'pkcs8'}),pub=pair.publicKey.export({format:'pem',type:'spki'});
  nextFiles.set(SIGNATURE_PATH,makeReleaseSignature(nextFiles,privatePem));
  const signedZip=createZip([...nextFiles].map(([name,data])=>({name,data})));
  const trustDir=join(appRoot,'.osmanx-trust');await mkdir(trustDir,{mode:0o700});await chmod(trustDir,0o700);
  await writeFile(join(trustDir,'release-public.pem'),pub,{mode:0o600});
  const newZipPath=join(base,'signed.zip');await writeFile(newZipPath,signedZip);
  const plan=await planUpgrade({root:appRoot,zipPath:newZipPath,requireSignature:true});
  assert.equal(plan.summary.from,oldApp.release.sequence);assert.equal(plan.summary.to,oldApp.release.sequence+1);
  const adapter={async stop(){},async backup(){return runMaintenance({root:appRoot,dataDir:data,backupDir:backups,command:'backup'})},
   async restore(_root,id){return runMaintenance({root:appRoot,dataDir:data,backupDir:backups,command:'restore',id,confirm:true})},
   async up(){},async health(){},async observe(){return {observedStable:true,samplesCompleted:3}},async activate(){}};
  const result=await applyUpgrade({root:appRoot,zipPath:newZipPath,confirm:true,adapter,requireSignature:true});
  assert.equal(result.upgraded,true);assert.equal(result.publisher.verified,true);
  const check=new DatabaseSync(join(data,type==='site'?'site.sqlite':'crm.sqlite'),{readOnly:true});
  assert.equal(check.prepare('SELECT value FROM r31_marker').get().value,'r30-data');check.close();
  const prefix=type==='crm'?'RESTAURANT':'SITE';
  await writeFile(join(outDir,'OSMANX_'+prefix+'_R30_OLD.zip'),oldZip);
  await writeFile(join(outDir,'OSMANX_'+prefix+'_R31_NEW_SIGNED_DEMO.zip'),signedZip);
  await writeFile(join(outDir,'OSMANX_'+prefix+'_R31_TEST_PUBLIC_KEY.pem'),pub);
  results.push({type,projectId:existing.id,from:plan.summary.from,to:plan.summary.to,
    signatureVerified:true,managedFiles:nextFiles.size,syntheticDbPreserved:true,adapter:'simulated-docker-not-a-real-deploy'});
 }finally{await rm(base,{recursive:true,force:true})}
}
console.log(JSON.stringify({ok:true,results},null,2));
