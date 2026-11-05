/**
 * R2.9 opt-in REAL Docker check: isolated synthetic CRM container, zero host ports.
 * Requires a pre-pulled node:22-bookworm-slim image. Never touches customer data.
 * Validates rollout observation, then simulates an app stop and checks fail-closed behavior.
 * NOT a public HTTPS or full Docker upgrade rollback test.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join,dirname } from 'node:path';
import { exportDeploymentBundle } from '../src/studio/deployment.mjs';
import { parseStoredZip } from '../src/common/archive.mjs';
import { observeRollout } from '../templates/deploy/rollout-observe.mjs';
const src=resolve(import.meta.dirname,'..');
const exec=(args,cwd,env=process.env)=>{
 const p=spawnSync('docker',args,{cwd,env,encoding:'utf8',timeout:120000,maxBuffer:1048576});
 if(p.error||p.status!==0)throw Error('Docker: '+String(p.error?.message||p.stderr||p.stdout).slice(-600));
 return String(p.stdout||'').trim();
};
const projectId=randomUUID();
const composeName='osmanx_'+projectId.replaceAll('-','').slice(0,12);
const project={id:projectId,type:'crm',industry:'restaurant',name:'R29 synthetic rollout E2E',
 modules:['auth','clients','tasks'],settings:{accent:'#386f61',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]};
const quote=s=>JSON.stringify(s);
async function main(){
 if(!process.argv.includes('--confirm-isolated-test')){
  console.error('Explicit opt-in required: node scripts/r29_docker_e2e.mjs --confirm-isolated-test');
  process.exitCode=2;return;
 }
 if(process.platform!=='linux')throw Error('Linux with Docker Engine required');
 exec(['info','--format','{{.ServerVersion}}'],src);
 exec(['image','inspect','node:22-bookworm-slim'],src);
 const base=await mkdtemp(join(tmpdir(),'osmanx-r29-docker-'));
 const kit=join(base,'kit');await mkdir(kit);
 let config=null,composeEnv=null;
 try{
  const zip=await exportDeploymentBundle(project,src,'r29-synthetic.example.org');
  const entries=parseStoredZip(zip,{maxFiles:400,maxBytes:80*1024*1024});
  for(const [name,buffer] of entries){await mkdir(dirname(join(kit,name)),{recursive:true});await writeFile(join(kit,name),buffer)}
  const compose=`name: ${composeName}\nservices:\n  app:\n    image: node:22-bookworm-slim\n    working_dir: /app\n    command: ["node", "run.mjs"]\n    read_only: true\n    tmpfs: ["/tmp"]\n    environment:\n      HOST: "0.0.0.0"\n      PORT: "4180"\n      COOKIE_SECURE: "0"\n      DATA_DIR: "/app/data"\n      SETUP_TOKEN: "synthetic-integration-token-at-least-32-characters"\n    volumes:\n      - ${quote(kit+':/app:ro')}\n      - app_data:/app/data\n    healthcheck:\n      test: ["CMD", "node", "deploy/healthcheck.mjs"]\n      interval: 2s\n      timeout: 3s\n      retries: 5\n      start_period: 10s\nvolumes:\n  app_data:\n`;
  config=join(kit,'compose.r29.test.yaml');await writeFile(config,compose);
  composeEnv={...process.env,COMPOSE_FILE:config};
  // Check no host-published ports, even if the author changes this script in the future.
  const parsed=exec(['compose','-f',config,'config','--format','json'],kit,composeEnv);
  const parsedObj=JSON.parse(parsed);
  assert.equal(Object.keys(parsedObj.services).length,1);
  assert.deepEqual(parsedObj.services.app.ports,undefined,'No host ports are permitted');
  exec(['compose','-f',config,'up','-d','--wait','--wait-timeout','90','--pull','never'],kit,composeEnv);
  const originalEnv=process.env.COMPOSE_FILE;process.env.COMPOSE_FILE=config;
  let success,failureDetected=false;
  try{
   success=await observeRollout({root:kit,samples:3,intervalMs:1000,record:true});
   exec(['compose','-f',config,'stop','app'],kit,composeEnv);
   await assert.rejects(observeRollout({root:kit,samples:2,intervalMs:0,record:true}),/Rollout stability gate failed/);
   failureDetected=true;
  }finally{
   if(originalEnv===undefined)delete process.env.COMPOSE_FILE;else process.env.COMPOSE_FILE=originalEnv;
  }
  assert.equal(success.observedStable,true);
  assert.equal(failureDetected,true);
  console.log(JSON.stringify({ok:true,syntheticOnly:true,projectId,observedStable:true,
    stoppedContainerFailureDetected:true,publicHttpsVerified:false,hostPortsPublished:false},null,2));
 }finally{
  if(config){
   try{exec(['compose','-f',config,'down','--remove-orphans'],kit,composeEnv||process.env)}
   catch(e){console.error('Cleanup needs manual inspection: '+e.message)}
   const name=composeName+'_app_data';
   try{
    const labels=JSON.parse(exec(['volume','inspect',name],kit,composeEnv||process.env));
    if(labels.length===1 && labels[0].Labels?.['com.docker.compose.project']===composeName &&
       labels[0].Labels?.['com.docker.compose.volume']==='app_data')exec(['volume','rm',name],kit,composeEnv||process.env);
   }catch(e){if(!String(e.message).includes('No such volume'))console.error('Inspect test volume before cleanup: '+e.message)}
  }
  await rm(base,{recursive:true,force:true});
 }
}
main().catch(e=>{console.error('R2.9 REAL DOCKER E2E DID NOT PASS: '+e.message);process.exitCode=1});
