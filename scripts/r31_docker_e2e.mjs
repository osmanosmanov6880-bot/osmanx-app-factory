/**
 * R3.1 opt-in REAL Docker signed-upgrade, rollback and forward-resume acceptance test.
 * Creates a random, isolated project with synthetic SQLite data; NO published ports.
 * Runs a signed upgrade, then forces a crash after a second signed upgrade, checking
 * rollback of both real Docker-managed application files and SQLite contents.
 * Requires Linux Docker Engine/Compose and a pre-pulled node:22-bookworm-slim base.
 * This file is prepared for CI/VPS execution; do not treat node --check as E2E proof.
 */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { exportDeploymentBundle } from '../src/studio/deployment.mjs';
import { parseStoredZip } from '../src/common/archive.mjs';
import { createZip } from '../src/common/zip.mjs';
import { SIGNATURE_PATH, makeReleaseSignature } from '../templates/deploy/signature.mjs';
import { planUpgrade, applyUpgrade, resumeUpgrade, dockerAdapter, getUpgradeStatus } from '../templates/deploy/upgrade.mjs';
const src=resolve(import.meta.dirname,'..');
const projectId=randomUUID();
const projectName='osmanx_'+projectId.replaceAll('-','').slice(0,12);
const domain='r31-synthetic.example.org';
const hash=x=>createHash('sha256').update(x).digest('hex');
const project=name=>({id:projectId,name,type:'crm',industry:'restaurant',
 modules:['auth','clients','tasks'],settings:{accent:'#386f61',currency:'RUB',primaryAction:'navigate_overview'},
 pages:[],entities:[],automationPresets:[]});
const release=(p,n)=>({id:randomUUID(),sequence:n,snapshotSha256:hash(JSON.stringify(p)),createdAt:new Date().toISOString()});
function docker(args,cwd,env,timeout=180000){
 const result=spawnSync('docker',args,{cwd,env,encoding:'utf8',timeout,maxBuffer:2*1024*1024});
 if(result.error||result.status!==0)throw Error('Docker '+args.join(' ')+' failed: '+String(result.error?.message||result.stderr||result.stdout).slice(-900));
 return String(result.stdout||'').trim();
}
async function unpack(bytes,path){
 const files=parseStoredZip(bytes,{maxFiles:400,maxBytes:80*1024*1024});
 for(const [name,content] of files){await mkdir(dirname(join(path,name)),{recursive:true});await writeFile(join(path,name),content)}
}
function signed(bytes,pem){const entries=parseStoredZip(bytes,{maxFiles:400,maxBytes:80*1024*1024});
 entries.set(SIGNATURE_PATH,makeReleaseSignature(entries,pem));
 return createZip([...entries].map(([name,data])=>({name,data})));
}
function assertOnlySyntheticCompose(config,root,env){
 // Maintenance is an opt-in profile: explicitly include it for inventory validation.
 const obj=JSON.parse(docker(['compose','--profile','maintenance','-f',config,'config','--format','json'],root,env));
 assert.equal(obj.name,projectName);
 assert.deepEqual(Object.keys(obj.services).sort(),['app','gateway','maintenance']);
 for(const service of Object.values(obj.services))assert.equal(service.ports?.length||0,0,'Test must never publish ports');
}
async function canary(root,env,sql){
 const js=`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/data/crm.sqlite');`+sql+`db.close();`;
 return docker(['compose','exec','-T','app','node','-e',js],root,env,30000);
}
async function main(){
 if(!process.argv.includes('--confirm-isolated-test'))throw Error('Explicit opt-in required: --confirm-isolated-test');
 if(process.platform!=='linux')throw Error('Docker acceptance tests require Linux');
 docker(['info','--format','{{.ServerVersion}}'],src,process.env,15000);
 docker(['image','inspect','node:22-bookworm-slim'],src,process.env,15000);
 const root=await mkdtemp(join(tmpdir(),'osmanx-r31-real-docker-'));
 const kit=join(root,'kit');await mkdir(kit);
 const composeFile=join(kit,'compose.r31.test.yaml');let composeReady=false;
 const env={...process.env,COMPOSE_FILE:composeFile};
 const previousComposeFile=process.env.COMPOSE_FILE;
 try{
  await unpack(await exportDeploymentBundle(project('Initial'),src,domain),kit);
  // Host-only synthetic fixture, never bundled into client archives.
  const content=`name: ${projectName}\nservices:\n  app:\n    build: .\n    restart: "no"\n    env_file: [.env]\n    read_only: true\n    tmpfs: [/tmp]\n    volumes: [app_data:/app/data]\n    healthcheck:\n      test: ["CMD", "node", "deploy/healthcheck.mjs"]\n      interval: 3s\n      timeout: 3s\n      retries: 7\n      start_period: 15s\n  gateway:\n    image: node:22-bookworm-slim\n    restart: "no"\n    command: ["node", "-e", "setInterval(() => {}, 100000)"]\n    depends_on:\n      app:\n        condition: service_healthy\n  maintenance:\n    profiles: [maintenance]\n    build: .\n    user: "0:0"\n    network_mode: "none"\n    read_only: true\n    tmpfs: [/tmp]\n    env_file: [.env]\n    volumes: [app_data:/app/data, ./backups:/backups]\n    entrypoint: ["node", "deploy/maintenance.mjs"]\nvolumes:\n  app_data:\n`;
  await writeFile(composeFile,content,{mode:0o600});
  const backups=join(kit,'backups');await mkdir(backups,{mode:0o700});await chmod(backups,0o700);
  const prepare=spawnSync(process.execPath,['deploy/prepare.mjs'],{cwd:kit,encoding:'utf8'});
  assert.equal(prepare.status,0,prepare.stderr);
  assertOnlySyntheticCompose(composeFile,kit,env);composeReady=true;
  // dockerAdapter and rollout observer read the environment of THIS Node process.
  // Never permit them to fall back to the exported production Compose file.
  process.env.COMPOSE_FILE=composeFile;
  docker(['compose','up','-d','--build','--wait','--wait-timeout','120','app','gateway'],kit,env,240000);
  await canary(kit,env,"db.exec(\"CREATE TABLE IF NOT EXISTS r31_canary(value TEXT);DELETE FROM r31_canary;INSERT INTO r31_canary VALUES('original');\");");
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const priv=privateKey.export({format:'pem',type:'pkcs8'}),pub=publicKey.export({format:'pem',type:'spki'});
  const trust=join(kit,'.osmanx-trust');await mkdir(trust,{mode:0o700});await chmod(trust,0o700);
  await writeFile(join(trust,'release-public.pem'),pub,{mode:0o600});
  const p1=project('Signed version 1');const z1=join(root,'signed-one.zip');
  await writeFile(z1,signed(await exportDeploymentBundle(p1,src,domain,release(p1,1)),priv));
  const planned=await planUpgrade({root:kit,zipPath:z1,requireSignature:true});
  assert.equal(planned.summary.publisher.verified,true);
  const good=await applyUpgrade({root:kit,zipPath:z1,confirm:true,requireSignature:true});
  assert.equal(good.upgraded,true);assert.equal(good.rolloutObserved,true);
  assert.match(await canary(kit,env,"console.log(db.prepare('SELECT value FROM r31_canary').get().value);"),/original/);
  const p2=project('Synthetic failure version 2');const z2=join(root,'signed-two.zip');
  await writeFile(z2,signed(await exportDeploymentBundle(p2,src,domain,release(p2,2)),priv));
  const original=dockerAdapter();
  const crash={...original,async observe(where){
    await canary(where,env,"db.exec(\"UPDATE r31_canary SET value='BAD_NEW_RELEASE'\");");
    docker(['compose','stop','app'],where,env,60000);
    return original.observe(where);
  }};
  await assert.rejects(applyUpgrade({root:kit,zipPath:z2,confirm:true,adapter:crash,requireSignature:true}),/old version restored/);
  const last=JSON.parse(await readFile(join(kit,'manifest.json')));
  assert.equal(last.release.sequence,1,'Code must revert to signed version 1');
  assert.match(await canary(kit,env,"console.log(db.prepare('SELECT value FROM r31_canary').get().value);"),/original/);
  const report=await getUpgradeStatus({root:kit});
  assert.equal(report.history[0].phase,'rolled-back');
  // Third stage: gateway activation uncertain. Preserve the NEW database, never roll back
  // potential client writes, then explicitly forward-resume after signed-code verification.
  const ambiguous={...original,async activate(){throw Error('synthetic gateway activation uncertainty')}};
  await assert.rejects(applyUpgrade({root:kit,zipPath:z2,confirm:true,adapter:ambiguous,requireSignature:true}),/Gateway activation uncertain/);
  assert.equal((await getUpgradeStatus({root:kit})).active.phase,'manual-review-required');
  docker(['compose','up','-d','--wait','--wait-timeout','120','app'],kit,env,180000);
  await canary(kit,env,"db.exec(\"UPDATE r31_canary SET value='post-activation-client-write'\");");
  const resumed=await resumeUpgrade({root:kit,confirm:true,adapter:original});
  assert.equal(resumed.keptNewVersion,true);
  assert.equal(resumed.databaseRestored,false);
  assert.match(await canary(kit,env,"console.log(db.prepare('SELECT value FROM r31_canary').get().value);"),/post-activation-client-write/);
  assert.equal(JSON.parse(await readFile(join(kit,'manifest.json'))).release.sequence,2);
  console.log(JSON.stringify({ok:true,realDocker:true,syntheticOnly:true,publicPorts:0,
    firstSignedRollout:'completed',secondSignedRollout:'rolled-back',databaseRestored:true,
    ambiguousGateway:'resumed-forward',clientWritesPreserved:true,retainedSequence:2,publicHttpsVerified:false},null,2));
 }catch(error){
  // Diagnostic evidence is gathered ONLY from this random, synthetic Compose
  // fixture before its volumes are destroyed. Never log real customer containers.
  if(composeReady){
   try {
    const logs=docker(['compose','logs','--no-color','--tail','35','app'],kit,env,15000);
    console.error('R3.8 synthetic app boot evidence (bounded): '+logs.slice(-3000));
   }catch(e){console.error('R3.8 synthetic app logs unavailable: '+e.message)}
  }
  throw error;
 }finally{
  if(composeReady){try{
    assertOnlySyntheticCompose(composeFile,kit,env);
    docker(['compose','down','--remove-orphans','--volumes'],kit,env,120000);
   }catch(error){console.error('Inspect test Docker resources manually: '+error.message)}}
  // Synthetic test volumes may be root-owned when Docker maintenance used root.
  // A no-network helper chowns only this freshly-created temporary test directory.
  if(composeReady){try{
    const uid=process.getuid?.()??1000,gid=process.getgid?.()??1000;
    docker(['run','--rm','--network','none','-v',root+':/cleanup','node:22-bookworm-slim',
      'chown','-R',uid+':'+gid,'/cleanup'],src,env,30000);
   }catch(error){console.error('Synthetic test directory needs manual cleanup: '+error.message)}}
  await rm(root,{recursive:true,force:true}).catch(e=>console.error('Unable to remove synthetic test directory: '+e.message));
  if(previousComposeFile===undefined)delete process.env.COMPOSE_FILE;
  else process.env.COMPOSE_FILE=previousComposeFile;
 }
}
main().catch(error=>{console.error('R3.1 REAL DOCKER ACCEPTANCE NOT PASSED: '+error.message);process.exitCode=1});
