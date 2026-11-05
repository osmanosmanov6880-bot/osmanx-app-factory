/** R3.7 real Docker acceptance for SYNTHETIC clients only.
 * No published ports, only internal loopback HTTP and disposable volumes.
 * Run on Linux runner with Docker Engine, not against production instances.
 * Signs no releases; signed upgrade/rollback is covered by R3.1 Docker suite.
 */
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {makeSitePages} from '../src/site/model.mjs';

const src=resolve(import.meta.dirname,'..');
const dockerTimeout=180000;
function run(args,cwd,timeout=dockerTimeout){
 const r=spawnSync(args[0],args.slice(1),{cwd,timeout,encoding:'utf8',maxBuffer:2*1024*1024});
 if(r.error||r.status!==0)throw Error('Synthetic command failed: '+args.slice(0,5).join(' ')+
    ' '+String(r.error?.message||r.stderr||r.stdout).slice(-700));
 return String(r.stdout||'').trim();
}
export function assertNoPublishedPorts(ports){
 if(!ports||typeof ports!=='object'||Array.isArray(ports))throw Error('Missing Docker port inventory');
 for(const bindings of Object.values(ports))
   if(bindings!==null && !(Array.isArray(bindings)&&bindings.length===0))
     throw Error('Synthetic app exposes a host port; refusing the test');
 return true;
}
const project=(id,type)=>({id,type,name:'R37 Synthetic '+type,
 industry:type==='site'?'business':'restaurant',
 modules:type==='site'?['auth','cms','leads']:['auth','clients','tasks'],
 pages:type==='site'?makeSitePages('R37 Synthetic'):[],entities:[],automationPresets:[],
 settings:{accent:'#7793a0',currency:'RUB',primaryAction:'navigate_overview'}});
const js=source=>['node','-e',source];
function syntheticHttpProgram(type,n){
 const port=type==='site'?4181:4180;
 return `
(async()=>{
const root='http://127.0.0.1:${port}', token=process.env.SETUP_TOKEN;
const headers={'content-type':'application/json'};
const setup=await fetch(root+'${type==='site'?'/api/site/setup':'/api/setup'}',{
 method:'POST',headers,body:JSON.stringify({name:'Synthetic Owner',email:'owner@r37.invalid',
 password:'SyntheticLocalOnly_123!',setup_token:token})});
const initial=await setup.json();if(setup.status!==201)throw Error('synthetic setup HTTP '+setup.status);
const cookie=setup.headers.get('set-cookie')?.split(';')[0];
const target='${type==='site'?'/api/site/leads':'/api/clients'}';
const attempts=await Promise.all(Array.from({length:${n}},(_,i)=>{
 const h={...headers};
 ${type==='crm'?"h.cookie=cookie;h['x-csrf-token']=initial.csrf;":''}
 const body=${type==='site'?"{page:'contacts',name:'Test '+i,email:'test'+i+'@example.invalid',message:'synthetic only'}":"{full_name:'Test '+i,source:'other'}"};
 return fetch(root+target,{method:'POST',headers:h,body:JSON.stringify(body)})
  .then(x=>x.status);
}));
if(attempts.some(s=>s!==201))throw Error('synthetic writes rejected '+attempts.join(','));
const health=await Promise.all(Array.from({length:25},()=>fetch(root+'/api/health').then(r=>r.status)));
if(health.some(s=>s!==200))throw Error('synthetic health failed');
console.log(JSON.stringify({created:attempts.length,health:health.length}));
})().catch(e=>{console.error(e.message);process.exitCode=1});
`;
}
function sqlVerify(type,n){
 const file=type==='site'?'site.sqlite':'crm.sqlite',table=type==='site'?'leads':'clients';
 return `const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/app/data/${file}',{readOnly:true});
const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;
const count=db.prepare('SELECT count(*) AS n FROM ${table}').get().n;
db.close();if(integrity!=='ok'||count!==${n})throw Error('SQLite records lost');
console.log(JSON.stringify({count,integrity}));`;
}
export async function dockerSyntheticTraffic(type,{exec=run}={}){
 if(!['crm','site'].includes(type))throw Error('Unknown synthetic application type');
 const base=await mkdtemp(join(tmpdir(),'osmanx-r37-docker-'));
 let started=false,error=null,cleanupError=null,result=null;
 const command=(args,ms)=>exec(args,base,ms);
 const uuid=randomUUID(),name='osmanx_'+uuid.replaceAll('-','').slice(0,12),count=type==='crm'?24:6;
 try{
   const files=parseStoredZip(await exportDeploymentBundle(project(uuid,type),src,'r37-synthetic.example.org'),
     {maxFiles:400,maxBytes:90e6});
   for(const [filename,bytes] of files){const target=join(base,filename);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes)}
   command([process.execPath,'deploy/verify.mjs'],30000);
   command([process.execPath,'deploy/prepare.mjs'],30000);
   command([process.execPath,'deploy/preflight.mjs'],30000);
   const compose=await readFile(join(base,'compose.yaml'),'utf8');
   if(!compose.includes('name: '+name+'\n')||!compose.includes('stop_grace_period: 90s'))
     throw Error('Unexpected isolated Compose project');
   started=true;
   command(['docker','compose','config','--quiet'],30000);
   command(['docker','compose','up','-d','--build','--wait','app'],240000);
   const id=command(['docker','compose','ps','-q','app'],30000);
   if(!/^[a-f0-9]{12,64}$/i.test(id))throw Error('Synthetic container missing');
   const ports=JSON.parse(command(['docker','inspect','--format','{{json .NetworkSettings.Ports}}',id],30000));
   assertNoPublishedPorts(ports);
   const label=command(['docker','inspect','--format','{{index .Config.Labels "com.docker.compose.project"}}',id],30000);
   if(label!==name)throw Error('Wrong Compose project attached');
   const traffic=JSON.parse(command(['docker','compose','exec','-T','app',...js(syntheticHttpProgram(type,count))],60000));
   if(traffic.created!==count||traffic.health!==25)throw Error('Incomplete internal HTTP traffic');
   let sql=JSON.parse(command(['docker','compose','exec','-T','app',...js(sqlVerify(type,count))],30000));
   if(sql.count!==count||sql.integrity!=='ok')throw Error('DB failed before restart');
   command(['docker','compose','stop','--timeout','90','app'],120000);
   command(['docker','compose','up','-d','--wait','app'],150000);
   sql=JSON.parse(command(['docker','compose','exec','-T','app',...js(sqlVerify(type,count))],30000));
   if(sql.count!==count)throw Error('DB lost data after graceful restart');
   command(['docker','compose','kill','-s','SIGKILL','app'],30000);
   command(['docker','compose','up','-d','--wait','app'],150000);
   sql=JSON.parse(command(['docker','compose','exec','-T','app',...js(sqlVerify(type,count))],30000));
   if(sql.count!==count)throw Error('DB lost data after SIGKILL');
   result={type,syntheticOnly:true,realDocker:true,realHttp:true,
     persistentWrites:count,healthRequests:25,gracefulRestart:true,forcedRestart:true,
     sqliteIntegrity:sql.integrity,publicPorts:0,publicHttpsVerified:false};
 }catch(e){error=e}
 finally{
   if(started)try{command(['docker','compose','down','--volumes','--remove-orphans'],120000)}
     catch(e){cleanupError=e}
   if(!cleanupError)await rm(base,{recursive:true,force:true});
 }
 if(cleanupError)throw new AggregateError([...(error?[error]:[]),cleanupError],
   'Synthetic Docker cleanup failed; inspect isolated directory '+base);
 if(error)throw error;
 return result;
}
export async function runDockerR37({exec=run}={}){
 if(process.platform!=='linux')throw Error('Linux Docker required');
 exec(['docker','info'],src,15000);
 exec(['docker','compose','version'],src,15000);
 const results=[];
 for(const type of ['crm','site'])results.push(await dockerSyntheticTraffic(type,{exec}));
 return {format:'osmanx-r37-docker-e2e',version:1,ok:true,realDocker:true,syntheticOnly:true,
   noPublicPorts:true,productionCertified:false,results};
}
const main=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(main){
 if(!process.argv.includes('--confirm-isolated-test')){
   console.error('Explicit opt-in required: --confirm-isolated-test');process.exitCode=2;
 }else runDockerR37().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{
   console.error('R3.7 Docker acceptance NOT PASSED: '+e.message);process.exitCode=1;
 });
}
