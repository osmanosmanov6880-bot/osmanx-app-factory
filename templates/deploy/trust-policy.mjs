/**
 * R3.2 operator-controlled Ed25519 publisher key rotation.
 * The trust policy is created ON THE VPS, never shipped or modified by a release.
 * Revoked fingerprints are retained so they cannot be silently re-enabled.
 */
import {createHash,createPublicKey,randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,rename,rm,lstat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const id=/^[0-9a-f]{64}$/;
const fail=message=>{throw Error(message)};
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
const dirName='.osmanx-trust',policyName='release-keyring.json';
function fingerprint(pem){
 if(!Buffer.from(pem).toString('utf8').startsWith('-----BEGIN PUBLIC KEY-----'))
  fail('Expected an Ed25519 PUBLIC KEY PEM, not private key material');
 const key=createPublicKey(pem);
 if(key.asymmetricKeyType!=='ed25519')fail('Publisher public key must use Ed25519');
 return hash(key.export({format:'der',type:'spki'}));
}
async function real(path,kind){
 const s=await lstat(path);
 if(s.isSymbolicLink()||(kind==='directory'&&!s.isDirectory())||(kind==='file'&&!s.isFile()))fail('Publisher trust path must be a real '+kind);
 if(process.platform!=='win32'&&(s.mode&0o022)!==0)fail(kind==='directory'?'Publisher trust directory must not be writable by group or others':'Publisher key must not be writable by group or others');
 return s;
}
async function keyBytes(path){
 const s=await real(path,'file');if(s.size<64||s.size>8192)fail('Invalid publisher public key size');
 const pem=await readFile(path);return {pem,fingerprint:fingerprint(pem)};
}
function validatePolicy(data){
 if(!data||data.format!=='osmanx-publisher-trust'||data.version!==1||
    !Array.isArray(data.keys)||data.keys.length<1||data.keys.length>8)fail('Invalid publisher trust policy');
 const seen=new Set();let active=0;
 for(const k of data.keys){
  if(!k||!id.test(k.fingerprint)||!['active','revoked'].includes(k.status)||seen.has(k.fingerprint))
    fail('Invalid or duplicate publisher key fingerprint');
  seen.add(k.fingerprint);if(k.status==='active')active++;
 }
 if(!active)fail('Publisher trust policy must retain one active signing key');
 return data;
}
async function atomic(path,data){
 const temp=path+'.pending-'+randomBytes(8).toString('hex');
 try{await writeFile(temp,data,{flag:'wx',mode:0o600});await rename(temp,path)}
 finally{await rm(temp,{force:true})}
}
async function policyState(root){
 const d=join(resolve(root),dirName),policyPath=join(d,policyName);
 if(!existsSync(d))return {directory:d,policy:null,legacy:null};
 await real(d,'directory');
 if(existsSync(policyPath)){
  const stat=await real(policyPath,'file');if(stat.size>16384)fail('Oversized publisher trust policy');
  const p=validatePolicy(JSON.parse(await readFile(policyPath,'utf8')));
  const keysDir=join(d,'keys');await real(keysDir,'directory');
  for(const k of p.keys.filter(x=>x.status==='active')){
   const found=await keyBytes(join(keysDir,k.fingerprint+'.pem'));
   if(found.fingerprint!==k.fingerprint)fail('Publisher key fingerprint does not match trust policy');
  }
  return {directory:d,policy:p,legacy:null};
 }
 // Fail closed if a partially deleted keyring directory exists.
 if(existsSync(join(d,'keys')))fail('Publisher keyring is incomplete; never fall back to legacy trust');
 const old=join(d,'release-public.pem');
 if(!existsSync(old))fail('Publisher trust directory configured but release-public.pem is missing');
 return {directory:d,policy:null,legacy:await keyBytes(old)};
}
export async function getPublisherTrustStatus(root){
 const s=await policyState(root);
 if(s.policy)return {mode:'keyring',keys:s.policy.keys.map(k=>({...k})),active:s.policy.keys.filter(k=>k.status==='active').length};
 if(s.legacy)return {mode:'legacy',keys:[{fingerprint:s.legacy.fingerprint,status:'active'}],active:1};
 return {mode:'not-configured',keys:[],active:0};
}
/** Select an externally pinned key by the signed package's declared fingerprint. */
export async function selectTrustedPublicKey(root,entries,{overridePath=null}={}){
 const s=await policyState(root);
 if(overridePath&&s.policy)fail('Keyring cannot be bypassed with --trust-key');
 if(overridePath)return (await keyBytes(resolve(overridePath))).pem;
 if(s.policy){
  let signer=null;
  if(entries?.has('deploy/release-signature.json')){
   try {signer=JSON.parse(entries.get('deploy/release-signature.json').toString('utf8')).keyFingerprintSha256}
   catch {fail('Invalid signature metadata')}
  }
  const selected=s.policy.keys.find(k=>k.fingerprint===signer);
  if(selected?.status==='revoked')fail('Publisher signer has been revoked by the operator');
  if(signer&&!selected)fail('Untrusted publisher signer: not in active keyring');
  const key=selected || s.policy.keys.find(k=>k.status==='active');
  return (await keyBytes(join(s.directory,'keys',key.fingerprint+'.pem'))).pem;
 }
 return s.legacy?.pem||null;
}
/** Explicit operator actions, never callable from the factory browser or a client ZIP. */
export async function managePublisherTrust({root,action,keyPath=null,target=null,confirm=false}){
 root=resolve(root);
 if(action==='status')return getPublisherTrustStatus(root);
 if(confirm!==true)fail('Changing publisher trust requires --confirm');
 if(!['init','add','revoke'].includes(action))fail('Expected init, add, revoke or status');
 const s=await policyState(root);
 if(action==='init'){
  if(s.policy)fail('Keyring already initialized');
  if(!keyPath)fail('Provide an independently verified public --key path');
  const found=await keyBytes(resolve(keyPath));
  if(s.legacy&&s.legacy.fingerprint!==found.fingerprint)
   fail('Initial key must match the existing pinned legacy publisher key');
  await mkdir(s.directory,{recursive:true,mode:0o700});await real(s.directory,'directory');
  const kd=join(s.directory,'keys');await mkdir(kd,{mode:0o700});await real(kd,'directory');
  await atomic(join(kd,found.fingerprint+'.pem'),found.pem);
  await atomic(join(s.directory,policyName),JSON.stringify({format:'osmanx-publisher-trust',version:1,
   keys:[{fingerprint:found.fingerprint,status:'active'}]},null,2)+'\n');
  return {ok:true,action,active:1,fingerprint:found.fingerprint};
 }
 if(!s.policy)fail('Initialize publisher keyring before adding or revoking keys');
 const policy=structuredClone(s.policy);
 if(action==='add'){
  if(!keyPath)fail('Provide an independently verified public --key path');
  const found=await keyBytes(resolve(keyPath));
  if(policy.keys.some(k=>k.fingerprint===found.fingerprint))fail('Publisher key already present or permanently revoked');
  if(policy.keys.length>=8)fail('Keyring capacity reached');
  await atomic(join(s.directory,'keys',found.fingerprint+'.pem'),found.pem);
  policy.keys.push({fingerprint:found.fingerprint,status:'active'});
  await atomic(join(s.directory,policyName),JSON.stringify(policy,null,2)+'\n');
  return {ok:true,action,fingerprint:found.fingerprint,active:policy.keys.filter(k=>k.status==='active').length};
 }
 if(!id.test(target||''))fail('Provide --fingerprint of a pinned publisher key');
 const item=policy.keys.find(k=>k.fingerprint===target);
 if(!item||item.status!=='active')fail('Publisher key not active or not found');
 if(policy.keys.filter(k=>k.status==='active').length<=1)fail('Cannot revoke the last active publisher key');
 item.status='revoked';await atomic(join(s.directory,policyName),JSON.stringify(policy,null,2)+'\n');
 return {ok:true,action,fingerprint:target,active:policy.keys.filter(k=>k.status==='active').length};
}

const main=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(main){
 process.umask(0o077);
 const args=process.argv.slice(2),option=name=>args.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3);
 const root=option('installed')||resolve(dirname(fileURLToPath(import.meta.url)),'..');
 managePublisherTrust({root,action:args[0],keyPath:option('key'),target:option('fingerprint'),confirm:args.includes('--confirm')})
  .then(r=>console.log(JSON.stringify(r,null,2)))
  .catch(e=>{console.error('OSMANX TRUST: '+e.message);process.exitCode=1});
}
