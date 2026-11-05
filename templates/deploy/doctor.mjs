/**
 * R3.2 deployment acceptance doctor. Offline by default: no DNS/HTTP or Docker calls.
 * Optional --docker and --live checks are explicit. No secrets, PII or SQLite rows in report.
 * A passing report is NOT a security audit or production certification.
 */
import {createHash,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {lstat,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve,sep,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {selectTrustedPublicKey,getPublisherTrustStatus} from './trust-policy.mjs';
import {SIGNATURE_PATH,verifyReleaseSignature} from './signature.mjs';
import {verifyPublicHttps} from './verify-live.mjs';

const digest=v=>createHash('sha256').update(v).digest('hex');
const validFile=name=>typeof name==='string'&&name.length<=200&&/^[A-Za-z0-9_./-]+$/.test(name)&&
 !name.startsWith('/')&&name.split('/').every(s=>s&&s!=='.'&&s!=='..');
async function realFile(path){const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink())throw Error('Not a regular file');return st}
async function readManaged(root,name){
 if(!validFile(name))throw Error('Unsafe managed file name');
 const path=resolve(root,name);if(!path.startsWith(root+sep))throw Error('Managed path escapes installation');
 let cursor=root;
 for(const chunk of name.split('/')){
  cursor=join(cursor,chunk);
  const st=await lstat(cursor);
  if(st.isSymbolicLink())throw Error('Symbolic link in managed path');
 }
 await realFile(path);return readFile(path);
}
function checkItem(id,status,detail){return {id,status,detail}}
export async function inspectDeployment({root,docker=false,live=false,dockerRun=null,liveProbe=verifyPublicHttps}={}){
 if(!root)throw Error('Installed directory required');root=resolve(root);
 const checks=[];const pass=(id,detail)=>checks.push(checkItem(id,'pass',detail));
 const warn=(id,detail)=>checks.push(checkItem(id,'warning',detail));
 const fail=(id,detail)=>checks.push(checkItem(id,'fail',detail));
 let app,dep,inventory;
 try{
  const appRaw=await readManaged(root,'manifest.json'),depRaw=await readManaged(root,'deploy/manifest.json');
  app=JSON.parse(appRaw);dep=JSON.parse(depRaw);
  if(!app||!dep||dep.format!=='osmanx-deployment-kit'||dep.version!==2||
    app.projectId!==dep.projectId||!/^osmanx_[0-9a-f]{12}$/.test(dep.composeProject)||
    dep.composeProject!=='osmanx_'+app.projectId.replaceAll('-','').slice(0,12)||
    dep.applicationManifestSha256!==digest(appRaw)||
    !['osmanx-standalone-release','osmanx-standalone-site'].includes(app.format)||
    !Number.isSafeInteger(app.release?.sequence)||app.release.sequence<0||
    !app.files||!dep.files)throw Error('Invalid deployment or application identity');
  inventory=new Map([['manifest.json',appRaw],['deploy/manifest.json',depRaw]]);
  const listed=new Set(inventory.keys());
  for(const group of [app.files,dep.files])for(const [name,expected] of Object.entries(group)){
   if(!validFile(name)||listed.has(name)||!/^[0-9a-f]{64}$/.test(expected))throw Error('Malformed file inventory');
   listed.add(name);
   const bytes=await readManaged(root,name);if(digest(bytes)!==expected)throw Error('Managed source hash mismatch');
   inventory.set(name,bytes);
  }
  pass('inventory','Application and deployment manifests match the installed files');
 }catch{fail('inventory','Manifest identity, file hashes or safe paths did not pass');}
 let trust=null;
 try{
  trust=await getPublisherTrustStatus(root);
  if(trust.mode==='not-configured')warn('publisher','No publisher key pinned; authenticity cannot be established');
  else if(!inventory)warn('publisher','Publisher keys available, but inventory verification failed');
  else {
   if(existsSync(join(root,SIGNATURE_PATH)))inventory.set(SIGNATURE_PATH,await readManaged(root,SIGNATURE_PATH));
   const pub=await selectTrustedPublicKey(root,inventory);
   const verified=verifyReleaseSignature(inventory,pub,{requireSignature:true});
   if(!verified.verified)throw Error('Publisher signature not verified');
   pass('publisher','Ed25519 release authenticated against operator-pinned '+trust.mode+' keys');
  }
 }catch{fail('publisher','Publisher trust policy or installed signature invalid');}
 try{
  const path=join(root,'.env');const st=await realFile(path);
  if(process.platform!=='win32'&&(st.mode&0o077)!==0)throw Error('Unsafe permissions');
  if(st.size>16384)throw Error('Environment too large');
  const vals={};for(const line of (await readFile(path,'utf8')).split(/\r?\n/)){
   if(!line||line.startsWith('#'))continue;
   const eq=line.indexOf('=');if(eq<1||Object.hasOwn(vals,line.slice(0,eq)))throw Error('Bad environment');
   vals[line.slice(0,eq)]=line.slice(eq+1);
  }
  const port=app?.format==='osmanx-standalone-site'?'4181':'4180';
  if(vals.APP_DOMAIN!==dep?.domain||vals.COOKIE_SECURE!=='1'||vals.HOST!=='0.0.0.0'||
    vals.PORT!==port||!vals.SETUP_TOKEN||vals.SETUP_TOKEN.length<32||vals.SETUP_TOKEN.includes('REPLACE_')||
    (port==='4181'&&vals.PUBLIC_SITE_URL!=='https://'+dep.domain))throw Error('Unsafe application settings');
  pass('secrets','Private environment configuration validated (values never reported)');
 }catch{fail('secrets','Private .env missing, unsafe, or inconsistent with deployment');}
 try{
  const st=await lstat(join(root,'backups'));
  if(!st.isDirectory()||st.isSymbolicLink()||
    (process.platform!=='win32'&&(st.mode&0o077)!==0))throw Error('Unsafe backups directory');
  pass('backups','Private backup directory present; restore test is a separate step');
 }catch{warn('backups','Create a restricted backups directory and run an independent restore drill');}
 if(existsSync(join(root,'.osmanx-upgrades','active.json')))
  fail('upgrade','An interrupted upgrade requires operator review');
 else pass('upgrade','No active interrupted upgrade journal detected');
 if(docker){
  try{
   const run=dockerRun||(()=>spawnSync('docker',['compose','config','--quiet'],{cwd:root,timeout:15000,encoding:'utf8'}));
   const r=await run(root);
   if(r.error||r.status!==0)throw Error('Compose configuration check failed');
   pass('docker','Docker Compose configuration accepted (not a running-container test)');
  }catch{fail('docker','Docker Compose configuration could not be verified');}
 }else warn('docker','Not checked; run --docker explicitly on the Linux host');
 if(live){
  try{
   if(!dep||!app)throw Error('Unknown release identity');
   const verified=await liveProbe(dep.domain,{expected:{
    service:app.format==='osmanx-standalone-site'?'osmanx-website':'osmanx-business-crm',
    projectId:app.projectId,releaseSequence:app.release.sequence}});
   if(!verified?.ok||!verified?.identityVerified||!verified?.sslCertificateValidated)throw Error('Unverified HTTPS identity');
   pass('https','Public HTTPS certificate and deployed release identity confirmed');
  }catch{fail('https','Public TLS certificate or deployed release identity could not be verified');}
 }else warn('https','Not checked; run --live explicitly after publishing');
 const mandatory=['inventory','publisher','secrets','backups','upgrade','docker','https'];
 const lookup=new Map(checks.map(x=>[x.id,x.status]));
 const report={format:'osmanx-deployment-acceptance',version:1,generatedAt:new Date().toISOString(),
  projectId:app?.projectId||null,releaseSequence:app?.release?.sequence??null,
  domain:dep?.domain||null,checks,offlineOnly:!docker&&!live,
  allRequestedChecksPassed:!checks.some(x=>x.status==='fail'),
  fullTechnicalGatePassed:mandatory.every(id=>lookup.get(id)==='pass'),
  productionCertification:false,
  note:'This is an operational preflight report; it does not replace a security audit, real customer-data restore, or monitoring.'};
 report.sha256=digest(Buffer.from(JSON.stringify(report)));
 return report;
}
export async function writeAcceptanceReport(path,report){
 if(!path||!resolve(path).startsWith('/'))throw Error('Report output requires a local file path');
 const file=resolve(path);
 const payload=Buffer.from(JSON.stringify(report,null,2)+'\n');
 await writeFile(file,payload,{flag:'wx',mode:0o600});
 return {written:true,path:file,sha256:digest(payload)};
}
const main=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(main){
 process.umask(0o077);
 const a=process.argv.slice(2),val=k=>a.find(x=>x.startsWith('--'+k+'='))?.slice(k.length+3);
 const root=val('installed')||resolve(dirname(fileURLToPath(import.meta.url)),'..');
 inspectDeployment({root,docker:a.includes('--docker'),live:a.includes('--live')})
  .then(async r=>{if(val('out'))await writeAcceptanceReport(val('out'),r);console.log(JSON.stringify(r,null,2));if(r.checks.some(x=>x.status==='fail'))process.exitCode=1})
  .catch(e=>{console.error('OSMANX DOCTOR: '+e.message);process.exitCode=1});
}
