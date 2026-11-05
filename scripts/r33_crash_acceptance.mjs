/**
 * R3.3 real SIGKILL interruption on synthetic local CRM and site upgrade.
 * Confirms durable journals permit operator-controlled recovery of both code
 * and an SQLite canary. Never runs Docker or accesses a customer VPS.
 */
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,generateKeyPairSync,createHash} from 'node:crypto';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {createZip} from '../src/common/zip.mjs';
import {SIGNATURE_PATH,makeReleaseSignature} from '../templates/deploy/signature.mjs';
import {runMaintenance} from '../templates/deploy/maintenance.mjs';
import {recoverUpgrade,getUpgradeStatus} from '../templates/deploy/upgrade.mjs';
const src=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sha=value=>createHash('sha256').update(value).digest('hex');
const project=(id,type,name)=>({id,name,type,industry:type==='site'?'business':'restaurant',
 modules:type==='site'?['auth','cms','leads']:['auth','clients','tasks'],
 settings:{accent:'#a78b73',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]});
async function extract(zip,root){
 for(const [name,buf] of parseStoredZip(zip,{maxFiles:400,maxBytes:80e6})){
  const file=join(root,name);await mkdir(dirname(file),{recursive:true});await writeFile(file,buf)
 }
}
function readCanary(file){const db=new DatabaseSync(file,{readOnly:true});
 try{return {value:db.prepare('SELECT value FROM r33_canary').get().value,
  integrity:db.prepare('PRAGMA integrity_check').get().integrity_check}}
 finally{db.close()}}
async function scenario(type,phase){
 const base=await mkdtemp(join(tmpdir(),'osmanx-r33-crash-'));
 try{
  const installed=join(base,'kit'),dataDir=join(base,'db'),backupDir=join(installed,'backups');
  await mkdir(installed);await mkdir(dataDir);await mkdir(backupDir,{mode:0o700});await chmod(backupDir,0o700);
  const id=randomUUID(),domain='r33-synthetic.example.org';
  await extract(await exportDeploymentBundle(project(id,type,'Before'),src,domain),installed);
  await writeFile(join(installed,'.env'),'APP_DOMAIN='+domain+'\nSETUP_TOKEN=R33_SYNTHETIC_ONLY\n',{mode:0o600});
  const file=join(dataDir,type==='crm'?'crm.sqlite':'site.sqlite');
  const db=new DatabaseSync(file);db.exec("CREATE TABLE r33_canary(value TEXT NOT NULL);INSERT INTO r33_canary VALUES('original-only')");db.close();
  const pair=generateKeyPairSync('ed25519');
  const trust=join(installed,'.osmanx-trust');await mkdir(trust,{mode:0o700});
  await writeFile(join(trust,'release-public.pem'),pair.publicKey.export({format:'pem',type:'spki'}),{mode:0o600});
  const next=project(id,type,'Next');
  const release={id:randomUUID(),sequence:1,snapshotSha256:sha(JSON.stringify(next)),createdAt:new Date().toISOString()};
  const entries=parseStoredZip(await exportDeploymentBundle(next,src,domain,release),{maxFiles:400,maxBytes:80e6});
  entries.set(SIGNATURE_PATH,makeReleaseSignature(entries,pair.privateKey.export({format:'pem',type:'pkcs8'})));
  const zip=join(base,'signed.zip');await writeFile(zip,createZip([...entries].map(([name,data])=>({name,data}))));
  const proc=spawnSync(process.execPath,['scripts/r33_crash_worker.mjs',installed,zip,dataDir,phase],{
   cwd:src,env:{...process.env,OSMANX_R33_SYNTHETIC_CRASH:'YES',NODE_NO_WARNINGS:'1'},timeout:30000,encoding:'utf8'});
  if(proc.signal!=='SIGKILL')throw Error('Child did not reach intentional SIGKILL point: '+(proc.stderr||'').slice(-450));
  const interrupted=await getUpgradeStatus({root:installed});
  if(!interrupted.active)throw Error('Abrupt process exit did not persist recovery journal');
  // The parent is a DIFFERENT process and uses actual SQLite maintenance restore.
  let restored=0;
  const adapter={
   async stop(){},async up(){},async health(){},async activate(){},
   async restore(_root,backupId){restored++;return runMaintenance({root:installed,dataDir,backupDir,command:'restore',id:backupId,confirm:true})}
  };
  const recovered=await recoverUpgrade({root:installed,confirm:true,adapter});
  const finalState=await getUpgradeStatus({root:installed});
  const app=JSON.parse(await readFile(join(installed,'manifest.json')));
  const canary=readCanary(file);
  if(app.release.sequence!==0||canary.value!=='original-only'||canary.integrity!=='ok'||finalState.active!==null||finalState.history[0]?.phase!=='recovered')
   throw Error('Crash recovery failed to restore original code and SQLite');
  if(restored!==(phase==='before-new-boot'?1:0))throw Error('Unexpected SQLite restore count');
  return {type,crashAt:phase,processReallyKilled:true,durableJournalRecovered:true,
   recoveredRelease:app.release.sequence,sqliteIntegrity:canary.integrity,databaseRestoreCount:restored};
 }finally{await rm(base,{recursive:true,force:true})}
}
export async function runCrashAcceptance(){
 const results=[];
 for(const type of ['crm','site'])for(const phase of ['after-stop','before-new-boot'])results.push(await scenario(type,phase));
 return {format:'osmanx-r33-crash-acceptance',version:1,ok:true,syntheticOnly:true,
  realAbruptProcessKill:true,realSqlite:true,realDocker:false,results};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const out=process.argv.find(a=>a.startsWith('--out='))?.slice(6);
 runCrashAcceptance().then(async report=>{
  if(out){process.umask(0o077);await writeFile(resolve(out),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600})}
  console.log(JSON.stringify(report,null,2));
 }).catch(error=>{console.error('R3.3 CRASH ACCEPTANCE FAILED: '+error.message);process.exitCode=1});
}
