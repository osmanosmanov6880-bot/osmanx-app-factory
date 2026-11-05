/** R3.0 offline signing utility. NEVER store signing private keys in a deployment ZIP. */
import { generateKeyPairSync } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from '../src/common/zip.mjs';
import { parseStoredZip } from '../src/common/archive.mjs';
import { SIGNATURE_PATH, makeReleaseSignature, verifyReleaseSignature } from '../templates/deploy/signature.mjs';

const option = (args, name) => args.find(a=>a.startsWith(name+'='))?.slice(name.length+1);
const requireOption = (args,name) => { const result=option(args,name); if(!result)throw Error('Missing '+name+'=PATH');return resolve(result); };
async function readPlainFile(path, privateFile=false) {
  const s=await lstat(path);
  if (!s.isFile() || s.isSymbolicLink()) throw Error('Not a regular file: '+path);
  if(privateFile && process.platform!=='win32' && (s.mode & 0o077)!==0)
    throw Error('Private signing key must be accessible only to its owner (chmod 600)');
  return readFile(path);
}
async function writeNew(path, bytes, mode=0o600) {
  await mkdir(dirname(path),{recursive:true});
  await writeFile(path,bytes,{flag:'wx',mode});
}
export async function releaseSignCLI(args) {
  const [command,file]=args;
  if(command==='keygen') {
    const privatePath=requireOption(args,'--private'), publicPath=requireOption(args,'--public');
    if(privatePath===publicPath || existsSync(privatePath) || existsSync(publicPath)) throw Error('Key output already exists or paths are identical');
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');
    await writeNew(privatePath,privateKey.export({type:'pkcs8',format:'pem'}),0o600);
    try {await writeNew(publicPath,publicKey.export({type:'spki',format:'pem'}),0o644);}
    catch(e){await rm(privatePath,{force:true});throw e;}
    return {ok:true,privateKeyCreated:true,publicKeyCreated:true,note:'Never commit or distribute the private key. Pin the public key on each VPS.'};
  }
  if(command==='sign') {
    if(!file)throw Error('sign requires an unsigned deployment ZIP');
    const keyPath=requireOption(args,'--private'), out=requireOption(args,'--out');
    if(resolve(file)===out)throw Error('Output must differ from input ZIP');
    const data=await readPlainFile(resolve(file));
    const entries=parseStoredZip(data,{maxFiles:400,maxBytes:80*1024*1024});
    const signature=makeReleaseSignature(entries,await readPlainFile(keyPath,true));
    if(existsSync(out))throw Error('Signed release destination already exists');
    await writeNew(out,createZip([...entries].map(([name,data])=>({name,data})).concat([{name:SIGNATURE_PATH,data:signature}])),0o600);
    return {ok:true,signed:true,output:out};
  }
  if(command==='verify') {
    if(!file)throw Error('verify requires a signed deployment ZIP');
    const keyPath=requireOption(args,'--public');
    const entries=parseStoredZip(await readPlainFile(resolve(file)),{maxFiles:400,maxBytes:80*1024*1024});
    const result=verifyReleaseSignature(entries,await readPlainFile(keyPath),{requireSignature:true});
    return {ok:true,...result};
  }
  throw Error('Usage: release_sign.mjs keygen --private=/secure/private.pem --public=/secure/public.pem | sign FILE.zip --private=... --out=SIGNED.zip | verify SIGNED.zip --public=...');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  releaseSignCLI(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value,null,2)))
    .catch(e=>{console.error('OSMANX RELEASE SIGN: '+e.message);process.exitCode=1});
}
