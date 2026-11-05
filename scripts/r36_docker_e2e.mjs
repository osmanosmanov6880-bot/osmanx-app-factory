/**
 * R3.6 real Docker runner (Linux/GitHub Actions only).
 * Two synthetic applications, no published ports, no real customers.
 * Covers graceful stop, persistent volume, forced container restart and SQLite.
 */
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
const source=resolve(import.meta.dirname,'..');
const code=(text)=>['node','-e',text];
const run=(args,cwd,timeout=300000)=>{
 const r=spawnSync(args[0],args.slice(1),{cwd,encoding:'utf8',timeout,maxBuffer:1024*1024});
 if(r.error||r.status!==0)throw Error('Command failed: '+args.slice(0,5).join(' ')+' '+String(r.stderr||r.error?.message||r.stdout).slice(-600));
 return r.stdout.trim();
};
const project=(id,type)=>({id,type,name:'R36 Synthetic '+type,industry:type==='site'?'business':'restaurant',
 modules:type==='site'?['auth','cms','leads']:['auth','clients','tasks'],
 settings:{accent:'#7b8b8d',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]});
export async function dockerRestartScenario(type,{exec=run}={}){
 if(!['crm','site'].includes(type))throw Error('Invalid synthetic app type');
 const root=await mkdtemp(join(tmpdir(),'osmanx-r36-docker-'));
 const id=randomUUID(),identity=project(id,type),marker=randomUUID();
 let composeAttempted=false,primary=null,cleanup=null,result=null;
 const command=(args,timeout=300000)=>exec(args,root,timeout);
 try{
  const entries=parseStoredZip(await exportDeploymentBundle(identity,source,'sandbox.example.org'),{maxFiles:450,maxBytes:90e6});
  for(const [name,bytes] of entries){const path=join(root,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes)}
  command([process.execPath,'deploy/prepare.mjs'],30000);
  command([process.execPath,'deploy/verify.mjs'],30000);
  command([process.execPath,'deploy/preflight.mjs'],30000);
  const compose=await readFile(join(root,'compose.yaml'),'utf8');
  if(!compose.includes('expose:')||!compose.includes('stop_grace_period: 90s'))throw Error('Unexpected Compose service contract');
  // Only app is started. Gateway and its 80/443 published ports stay stopped.
  composeAttempted=true;
  command(['docker','compose','config','--quiet']);
  command(['docker','compose','up','-d','--build','--wait','app']);
  command(['docker','compose','exec','-T','app','node','deploy/healthcheck.mjs'],30000);
  const proofWrite=`require('node:fs').writeFileSync('/app/data/r36-sentinel',${JSON.stringify(marker)},{flag:'wx',mode:0o600})`;
  command(['docker','compose','exec','-T','app',...code(proofWrite)],30000);
  const healthLoad=`Promise.all(Array.from({length:24},()=>fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>{if(!r.ok)throw Error('health')}))).then(()=>console.log('24')).catch(e=>{console.error(e.message);process.exitCode=1})`;
  if(command(['docker','compose','exec','-T','app',...code(healthLoad)],30000)!=='24')throw Error('Internal HTTP load failed');
  // Graceful drain must flush counters before killing/recreating the container.
  command(['docker','compose','stop','--timeout','90','app'],120000);
  command(['docker','compose','up','-d','--wait','app'],120000);
  const summary=JSON.parse(command(['docker','compose','exec','-T','app','node','deploy/telemetry-read.mjs'],30000));
  if(summary.status!=='observed'||summary.requests<24)throw Error('Metrics did not survive a graceful Docker restart');
  // Simulated power failure: same-volume process lock must not mistake new PID 1 for old.
  command(['docker','compose','kill','-s','SIGKILL','app'],30000);
  command(['docker','compose','up','-d','--wait','app'],120000);
  command(['docker','compose','exec','-T','app','node','deploy/healthcheck.mjs'],30000);
  const proofRead="process.stdout.write(require('node:fs').readFileSync('/app/data/r36-sentinel','utf8'))";
  if(command(['docker','compose','exec','-T','app',...code(proofRead)],30000)!==marker)throw Error('Persistent volume data missing after restart');
  const dbFile=type==='site'?'site.sqlite':'crm.sqlite';
  const integrity=`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/data/${dbFile}');const check=db.prepare('PRAGMA quick_check').get();db.close();if(check.quick_check!=='ok')process.exit(1);console.log('ok')`;
  if(command(['docker','compose','exec','-T','app',...code(integrity)],30000)!=='ok')throw Error('SQLite corruption after restart');
  result={type,syntheticOnly:true,appPortPublished:false,successfulHealthRequests:24,
   gracefulRestart:true,forcedRestart:true,persistentSentinel:true,sqliteQuickCheck:'ok',
   telemetryPresent:true,publicHttpsVerified:false};
 }catch(e){primary=e}
 finally{
  if(composeAttempted)try{command(['docker','compose','down','--volumes','--remove-orphans'],120000)}catch(e){cleanup=e}
  if(!cleanup)await rm(root,{recursive:true,force:true});
 }
 if(cleanup)throw new AggregateError([...(primary?[primary]:[]),cleanup],
  'Synthetic Docker cleanup failed; investigate retained isolated project '+root);
 if(primary)throw primary;
 return result;
}
export async function runR36DockerE2E({exec=run}={}){
 exec(['docker','info'],source,15000);exec(['docker','compose','version'],source,15000);
 const results=[];for(const type of ['crm','site'])results.push(await dockerRestartScenario(type,{exec}));
 return {format:'osmanx-r36-docker-e2e',version:1,syntheticOnly:true,realDocker:true,
  noCustomerData:true,publicHttpsVerified:false,results,ok:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv.includes('--confirm-isolated-test')){console.error('Pass --confirm-isolated-test');process.exitCode=2}
 else runR36DockerE2E().then(x=>console.log(JSON.stringify(x,null,2))).catch(e=>{console.error('R3.6 DOCKER E2E FAILED: '+e.message);process.exitCode=1});
}
