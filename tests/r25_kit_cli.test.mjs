import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
const root=resolve(import.meta.dirname,'..');
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const n=s.address().port;await new Promise(r=>s.close(r));return n}
async function unpack(entries,dir){for(const [path,data] of entries){await mkdir(dirname(join(dir,path)),{recursive:true});await writeFile(join(dir,path),data)}}
async function boot(dir,env,portNumber){
 const proc=spawn(process.execPath,['run.mjs'],{cwd:dir,env:{...process.env,...env,PORT:String(portNumber),HOST:'127.0.0.1',NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
 let output='';proc.stderr.on('data',d=>output+=d);proc.stdout.on('data',d=>output+=d);
 for(let i=0;i<80;i++){
  if(proc.exitCode!==null)throw Error('Server exited: '+output);
  try{const r=await fetch('http://127.0.0.1:'+portNumber+'/api/health');if(r.ok)return proc}catch{}
  await new Promise(r=>setTimeout(r,100));
 }
 proc.kill('SIGTERM');throw Error('Server boot timeout: '+output);
}

test('R2.5: exported CRM and site launch and their packaged offline CLI backs up and verifies actual SQLite',{timeout:90000},async()=>{
 for(const type of ['crm','site']){
  const project={id:type==='crm'?'00000000-1111-4222-8333-444444444444':'99999999-1111-4222-8333-444444444444',
   name:'R25 CLI',type,industry:type==='site'?'business':'restaurant',
   modules:type==='crm'?['auth','clients']:['auth','cms','leads'],settings:{accent:'#386f61',primaryAction:'navigate_overview',currency:'RUB'},pages:[],entities:[],automationPresets:[]};
  const temp=await mkdtemp(join(tmpdir(),'osmanx-kit-r25-'));
  try{
   const entries=parseStoredZip(await exportDeploymentBundle(project,root,'client.acme.co'),{maxFiles:350,maxBytes:60*1024*1024});
   const app=join(temp,'app'),dataDir=join(temp,'data'),backupDir=join(temp,'backups');
   await Promise.all([mkdir(app),mkdir(dataDir),mkdir(backupDir)]);
   await unpack(entries,app);
   let result=spawnSync(process.execPath,['deploy/verify.mjs'],{cwd:app,encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);
   const p=await port();const proc=await boot(app,{DATA_DIR:dataDir,COOKIE_SECURE:'0'},p);
   proc.kill('SIGTERM');await new Promise(r=>proc.once('exit',r));
   const env={...process.env,NODE_NO_WARNINGS:'1',DATA_DIR:dataDir,BACKUP_DIR:backupDir};
   result=spawnSync(process.execPath,['deploy/maintenance.mjs','backup'],{cwd:app,encoding:'utf8',env});
   assert.equal(result.status,0,result.stderr);
   const output=JSON.parse(result.stdout.trim());assert.equal(output.ok,true);
   result=spawnSync(process.execPath,['deploy/maintenance.mjs','verify',output.id],{cwd:app,encoding:'utf8',env});
   assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).sha256,output.sha256);
  }finally{await rm(temp,{recursive:true,force:true})}
 }
});
