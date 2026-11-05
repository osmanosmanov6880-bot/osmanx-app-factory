/**
 * R3.0 detached Ed25519 signature for OSMANX deployment kits.
 * A signature covers both manifests; those manifests hash every managed file.
 * The trusted public key MUST be provisioned out-of-band on the VPS.
 * Do not trust a key found in the release ZIP itself.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const SIGNATURE_PATH = 'deploy/release-signature.json';
const DOMAIN_SEPARATOR = 'OSMANX-DEPLOY-ED25519-V1\n';
const digest = data => createHash('sha256').update(data).digest('hex');
const fail = message => { throw Error(message); };
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const safeName = name => typeof name === 'string' && /^[a-zA-Z0-9_.\/-]{1,200}$/.test(name) &&
  !name.startsWith('/') && name.split('/').every(p => p !== '.' && p !== '..' && p);

export function validateReleaseInventory(entries) {
  if (!(entries instanceof Map) || !entries.has('manifest.json') || !entries.has('deploy/manifest.json'))
    fail('Release manifests are required for signature verification');
  const appBytes = entries.get('manifest.json');
  const deploymentBytes = entries.get('deploy/manifest.json');
  let app, deployment;
  try { app = JSON.parse(appBytes.toString('utf8')); deployment = JSON.parse(deploymentBytes.toString('utf8')); }
  catch { fail('Invalid JSON in release manifests'); }
  if (!object(app) || !object(deployment) || !object(app.files) || !object(deployment.files) ||
      !['osmanx-standalone-release','osmanx-standalone-site'].includes(app.format) ||
      deployment.format !== 'osmanx-deployment-kit' || deployment.version !== 2 ||
      app.projectId !== deployment.projectId ||
      deployment.applicationManifestSha256 !== digest(appBytes)) fail('Invalid release manifest identity or format');
  const tracked = new Set(['manifest.json', 'deploy/manifest.json']);
  for (const group of [app.files, deployment.files]) {
    for (const [name, expected] of Object.entries(group)) {
      if (!safeName(name) || name === SIGNATURE_PATH || tracked.has(name) ||
          !/^[0-9a-f]{64}$/.test(expected) || !entries.has(name) ||
          digest(entries.get(name)) !== expected) fail('Untrusted or damaged release entry: ' + name);
      tracked.add(name);
    }
  }
  if (tracked.size < 18 || tracked.size > 382 ||
      [...entries.keys()].some(name => !tracked.has(name) && name !== SIGNATURE_PATH))
    fail('Unexpected or untracked file in release ZIP');
  return { app, deployment, appBytes, deploymentBytes };
}

export function signingPayload(entries) {
  const { appBytes, deploymentBytes } = validateReleaseInventory(entries);
  return Buffer.from(DOMAIN_SEPARATOR + digest(appBytes) + '\n' + digest(deploymentBytes) + '\n', 'utf8');
}

function publicKeyFromPem(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') fail('Trusted public key must be Ed25519');
  return key;
}
function fingerprint(pub) { return digest(pub.export({ type:'spki', format:'der' })); }

export function makeReleaseSignature(entries, privatePem) {
  if (entries.has(SIGNATURE_PATH)) fail('Release is already signed; do not replace an existing signature');
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== 'ed25519') fail('Signing key must be Ed25519');
  const pub = publicKeyFromPem(key);
  const payload = signingPayload(entries);
  const signature = sign(null, payload, key);
  return Buffer.from(JSON.stringify({
    format:'osmanx-release-signature', version:1, algorithm:'Ed25519',
    keyFingerprintSha256:fingerprint(pub), payloadSha256:digest(payload),
    signature:signature.toString('base64')
  }, null, 2) + '\n');
}

/** Never silently accept a signed package without an externally pinned key. */
export function verifyReleaseSignature(entries, trustedPublicPem = null, { requireSignature = false } = {}) {
  const payload = signingPayload(entries);
  const hasSignature = entries.has(SIGNATURE_PATH);
  if (!hasSignature) {
    if (requireSignature || trustedPublicPem) fail('Unsigned release refused: pinned publisher key is configured');
    return { signed:false, verified:false, trust:'not-configured' };
  }
  if (!trustedPublicPem) fail('Signed release requires a trusted public key provisioned outside the ZIP');
  let signature;
  try { signature = JSON.parse(entries.get(SIGNATURE_PATH).toString('utf8')); }
  catch { fail('Invalid detached signature JSON'); }
  if (!object(signature) || signature.format !== 'osmanx-release-signature' || signature.version !== 1 ||
      signature.algorithm !== 'Ed25519' || signature.payloadSha256 !== digest(payload) ||
      !/^[0-9a-f]{64}$/.test(signature.keyFingerprintSha256) ||
      !/^[A-Za-z0-9+/]{86}==$/.test(signature.signature || '')) fail('Invalid detached signature format or payload');
  const pub = publicKeyFromPem(trustedPublicPem);
  const fp = fingerprint(pub);
  if (signature.keyFingerprintSha256 !== fp) fail('Untrusted release signer: public key fingerprint mismatch');
  const sigBytes = Buffer.from(signature.signature,'base64');
  if (sigBytes.length !== 64 || !verify(null, payload, pub, sigBytes)) fail('Ed25519 release signature verification failed');
  return {signed:true,verified:true,algorithm:'Ed25519',keyFingerprintSha256:fp};
}
