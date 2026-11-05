/**
 * R2.8 opt-in Docker Engine integration exercise on Linux VPS / GitHub Actions.
 * Uses ONLY synthetic SQLite and fresh randomly named Docker volumes.
 * Never pulls images, binds ports, starts the business application or migrates real data.
 * Skips with exit code 2 if the operator has not explicitly opted in.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { parseStoredZip } from '../src/common/archive.mjs';
import { createZip } from '../src/common/zip.mjs';
import { exportDeploymentBundle } from '../src/studio/deployment.mjs';
import { dockerVolumeAdapter, migrationPlan, migrateVolumes, recoverVolumes,
  migrationStatus, verifyMigratedVolumes } from '../templates/deploy/volume-migrate.mjs';

const source=resolve(import.meta.dirname,'..');
const hash=b=>createHash('sha256').update(b).digest('hex');
const runId=randomBytes(8).toString('hex');
const adapter=dockerVolumeAdapter;
function docker(args){
 const result=spawnSync('docker',args,{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
 if(result.error||result.status!==0)throw Error('Docker failed: '+(result.error?.message||result.stderr||result.stdout).slice(-500));
 return result.stdout.trim();
}
async function unpack(bytes,directory){
 const m=parseStoredZip(bytes,{maxFiles:400,maxBytes:80*1024*1024});
 for(const [name,data] of m){const dest=join(directory,name);await mkdir(dirname(dest),{recursive:true});await writeFile(dest,data)}
 return m;
}
async function createSyntheticFixture(root,ordinal){
 const projectId=randomUUID(),legacyProject='osmanxr28'+runId.slice(0,6)+ordinal;
 const targetProject='osmanx_'+projectId.replaceAll('-','').slice(0,12);
 const domain='r28-'+ordinal+'.example.org';
 const project={id:projectId,type:'crm',industry:'restaurant',name:'Synthetic E2E '+ordinal,
  modules:['auth','clients','tasks'],settings:{accent:'#386f61',currency:'RUB',primaryAction:'navigate_overview'},
  pages:[],entities:[],automationPresets:[]};
 const old=join(root,ordinal+'-old'),next=join(root,ordinal+'-new');
 await Promise.all([mkdir(old),mkdir(next)]);
 const v2=await exportDeploymentBundle(project,source,domain,{
  id:randomUUID(),sequence:1,snapshotSha256:hash(JSON.stringify(project)),createdAt:'2026-11-05T00:00:00Z'});
 await unpack(v2,next);
 const files=parseStoredZip(await exportDeploymentBundle(project,source,domain),{maxFiles:400,maxBytes:80*1024*1024});
 const meta=JSON.parse(files.get('deploy/manifest.json').toString());meta.version=1;delete meta.composeProject;
 for(const name of ['deploy/upgrade.mjs','deploy/volume-migrate.mjs','deploy/maintenance.mjs','deploy/verify-live.mjs']){
  files.delete(name);delete meta.files[name];
 }
 const compose=Buffer.from(files.get('compose.yaml').toString().replace(/^name: [^\n]+\n/,''));
 files.set('compose.yaml',compose);meta.files['compose.yaml']=hash(compose);
 files.set('deploy/manifest.json',Buffer.from(JSON.stringify(meta,null,2)+'\n'));
 await unpack(createZip([...files].map(([name,data])=>({name,data}))),old);
 const seeds={};
 for(const kind of ['app_data','caddy_data','caddy_config']){
  const dir=join(root,ordinal+'-'+kind);await mkdir(dir,{mode:0o700});
  if(kind==='app_data'){
   const db=new DatabaseSync(join(dir,'crm.sqlite'));
   db.exec('CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
   db.prepare('INSERT INTO customers(name) VALUES(?)').run('Synthetic-'+ordinal+'-'+runId);db.close();
   await writeFile(join(dir,'marker.txt'),'Synthetic R28 - no personal data');
  }else await writeFile(join(dir,'marker.txt'),'NOT a real TLS certificate');
  seeds[kind]=dir;
 }
 return {projectId,legacyProject,targetProject,domain,old,next,seeds,ordinal};
}
async function seedDockerVolumes(f,volumes){
 const a=adapter();
 for(const kind of ['app_data','caddy_data','caddy_config']){
  const name=f.legacyProject+'_'+kind;
  await a.create(name,{
   'com.docker.compose.project':f.legacyProject,
   'com.docker.compose.volume':kind,
   'io.osmanx.test-run':runId,'io.osmanx.test-only':'true'});
  volumes.add(name);
  const copied=await a.copy({directory:f.seeds[kind]},name,{dbName:kind==='app_data'?'crm.sqlite':null});
  assert.equal(copied.files,kind==='app_data'?2:1);
 }
}
async function cleanVolumes(f,volumes){
 const a=adapter();
 const status=await migrationStatus({root:f.next}).catch(()=>null);
 const migrationId=status?.active?.id||status?.history?.[0]?.id;
 for(const kind of ['caddy_config','caddy_data','app_data']){
  for(const name of [f.targetProject+'_'+kind,f.legacyProject+'_'+kind]){
   const meta=await a.inspect(name).catch(()=>null);
   if(!meta)continue;
   const ours=meta.Labels?.['io.osmanx.test-run']===runId ||
     (migrationId && name.startsWith(f.targetProject+'_') &&
     meta.Labels?.['com.docker.compose.project']===f.targetProject &&
     meta.Labels?.['com.docker.compose.volume']===kind &&
     meta.Labels?.['io.osmanx.migration-id']===migrationId);
   if(!ours){console.error('Refusing to clean unowned Docker volume '+name);continue}
   assert.equal(await a.anyContainer(name),false,'A container still references test volume '+name);
   await a.remove(name);volumes.delete(name);
  }
 }
}
async function positive(root){
 const f=await createSyntheticFixture(root,'ok');const made=new Set();
 try{
  await seedDockerVolumes(f,made);
  const a=adapter();
  const plan=await migrationPlan({legacyRoot:f.old,root:f.next,legacyProject:f.legacyProject,adapter:a});
  assert.equal(plan.summary.volumes.length,3);
  const result=await migrateVolumes({legacyRoot:f.old,root:f.next,legacyProject:f.legacyProject,
    confirm:true,offlineConfirmed:true,adapter:a});
  assert.equal(result.phase,'completed');
  const verified=await verifyMigratedVolumes({root:f.next,adapter:a});
  assert.equal(verified.volumes.length,3);
  for(const v of verified.volumes){assert.match(v.sha256,/^[0-9a-f]{64}$/)}
  return {success:true,phase:'completed',verifiedVolumes:verified.volumes.length,projectId:f.projectId};
 }finally{await cleanVolumes(f,made)}
}
async function interrupted(root){
 const f=await createSyntheticFixture(root,'fault');const made=new Set();
 try{
  await seedDockerVolumes(f,made);
  const a=adapter();let inject=true;
  const failing={...a,copy:async(src,dst,options)=>{
   if(inject&&typeof dst==='string'&&dst===f.targetProject+'_app_data'){
    inject=false;throw Error('R28 intentionally injected failure before data restore');
   }
   return a.copy(src,dst,options);
  }};
  await assert.rejects(migrateVolumes({legacyRoot:f.old,root:f.next,legacyProject:f.legacyProject,
    confirm:true,offlineConfirmed:true,adapter:failing}),/intentionally injected failure/);
  assert.equal((await migrationStatus({root:f.next})).active.phase,'recovery-required');
  const recovered=await recoverVolumes({root:f.next,adapter:a,confirm:true,recreateTargets:true});
  assert.equal(recovered.phase,'recovered');
  const checked=await verifyMigratedVolumes({root:f.next,adapter:a});
  assert.equal(checked.volumes.length,3);
  return {success:true,phase:'recovered',verifiedVolumes:checked.volumes.length,projectId:f.projectId};
 }finally{await cleanVolumes(f,made)}
}
async function main(){
 if(!process.argv.includes('--confirm-isolated-test')){
  console.error('Opt-in required: node scripts/r28_docker_e2e.mjs --confirm-isolated-test');
  process.exitCode=2;return;
 }
 if(process.platform!=='linux')throw Error('Linux Docker Engine required');
 docker(['info','--format','{{.ServerVersion}}']);
 const a=adapter();
 if(!await a.helperReady())throw Error('Helper image missing. Manually run: docker pull node:22-bookworm-slim');
 const temp=await mkdtemp(join(tmpdir(),'osmanx-docker-r28-'));
 try{
  const started=Date.now();
  const results=[await positive(temp),await interrupted(temp)];
  console.log(JSON.stringify({ok:true,runId,mode:'real-docker-volume-test',syntheticDataOnly:true,
   publicHttpsTested:false,realDockerVolumeOperations:true,results,durationMs:Date.now()-started},null,2));
 }finally{await rm(temp,{recursive:true,force:true})}
}
main().catch(e=>{console.error('R2.8 DOCKER E2E FAILED: '+e.message);process.exitCode=1});
