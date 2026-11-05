// Detached Ed25519 provenance for OSMANX cold PostgreSQL migrations.
// The private signing key NEVER ships in source or migration archives.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyMigration } from './pg-kit.mjs';

const DOMAIN = Buffer.from('OSMANX-PG-MIGRATION-MANIFEST-v1\0');
const HEX64 = /^[a-f0-9]{64}$/;
const BASE64_ED25519 = /^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/;
function ensure(value, message) { if (!value) throw new Error(message); }
function sha(buffer) { return createHash('sha256').update(buffer).digest('hex'); }
async function readRegular(path) {
  const stat = await lstat(path);
  ensure(stat.isFile() && !stat.isSymbolicLink(), 'Refusing linked or non-regular signing input: '+path);
  return readFile(path);
}
function fingerprint(publicKey) {
  const der=publicKey.export({format:'der',type:'spki'});
  return sha(der);
}
function edPublic(value) {
  const key=createPublicKey(value);
  ensure(key.asymmetricKeyType==='ed25519','Only Ed25519 public keys are accepted');
  return key;
}
function edPrivate(value) {
  const key=createPrivateKey(value);
  ensure(key.asymmetricKeyType==='ed25519','Only Ed25519 private keys are accepted');
  return key;
}

/** Generate a separate, private signing identity. The directory must not exist. */
export async function createSigningIdentity(directory) {
  const output=resolve(directory);
  const pair=generateKeyPairSync('ed25519',{
    privateKeyEncoding:{type:'pkcs8',format:'pem'},
    publicKeyEncoding:{type:'spki',format:'pem'}
  });
  await mkdir(output,{recursive:false,mode:0o700});
  await writeFile(join(output,'private.pem'),pair.privateKey,{mode:0o600,flag:'wx'});
  await writeFile(join(output,'public.pem'),pair.publicKey,{mode:0o644,flag:'wx'});
  return {publicKey:join(output,'public.pem'),privateKey:join(output,'private.pem'),keyFingerprint:fingerprint(edPublic(pair.publicKey))};
}

/** Sign only a migration bundle whose SQL and access plan have already passed verification. */
export async function signMigration(directory,privateKeyPath) {
  const root=resolve(directory);
  await verifyMigration(root);
  const secretPath=resolve(privateKeyPath);
  const stat=await lstat(secretPath);
  ensure(stat.isFile() && !stat.isSymbolicLink(),'Private key must be a regular file');
  if(process.platform!=='win32')ensure((stat.mode&0o077)===0,'Private signing key must have 0600 permissions');
  const secret=edPrivate(await readFile(secretPath));
  const publicKey=createPublicKey(secret);
  const manifest=await readRegular(join(root,'manifest.json'));
  const signature=sign(null,Buffer.concat([DOMAIN,manifest]),secret);
  const record={format:'osmanx-pg-ed25519-v1',manifestSha256:sha(manifest),
    keyFingerprint:fingerprint(publicKey),signature:signature.toString('base64')};
  const path=join(root,'manifest.sig.json');
  await writeFile(path,JSON.stringify(record,null,2)+'\n',{mode:0o600,flag:'wx'});
  // Check the saved signature and all signed SQL again; refuse to claim success on an edited bundle.
  await verifyTrustedMigration(root,publicKey.export({type:'spki',format:'pem'}));
  return {signatureFile:path,manifestSha256:record.manifestSha256,keyFingerprint:record.keyFingerprint};
}

/** Verify a pinned external public key; never use a key distributed inside an untrusted bundle. */
export async function verifyTrustedMigration(directory,trustedPublicKey) {
  ensure(trustedPublicKey,'An independently trusted public key is required');
  const root=resolve(directory);
  const publicPem=Buffer.isBuffer(trustedPublicKey)?trustedPublicKey
    :typeof trustedPublicKey==='string' && trustedPublicKey.includes('BEGIN PUBLIC KEY')
      ?trustedPublicKey:await readRegular(resolve(trustedPublicKey));
  const key=edPublic(publicPem);
  const record=JSON.parse((await readRegular(join(root,'manifest.sig.json'))).toString('utf8'));
  ensure(record?.format==='osmanx-pg-ed25519-v1' && HEX64.test(record.manifestSha256)
    && HEX64.test(record.keyFingerprint) && typeof record.signature==='string'
    && BASE64_ED25519.test(record.signature),'Malformed migration signature');
  ensure(record.keyFingerprint===fingerprint(key),'Migration signed by an untrusted key');
  const raw=await readRegular(join(root,'manifest.json'));
  ensure(sha(raw)===record.manifestSha256,'Signed migration manifest has changed');
  ensure(verify(null,Buffer.concat([DOMAIN,raw]),key,Buffer.from(record.signature,'base64')),
    'Ed25519 signature is invalid');
  const manifest=await verifyMigration(root);
  return {manifest,manifestSha256:record.manifestSha256,keyFingerprint:record.keyFingerprint};
}
