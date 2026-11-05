/**
 * OSMANX R3.4: opt-in, offline, signed fleet snapshot.
 * No customer rows, host names, passwords, addresses, or external sends.
 * Generate a per-installation signing identity on the actual client server.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, lstat, readFile, writeFile, open, realpath } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectDeployment } from './doctor.mjs';
import { loadRuntimeSummary } from '../../src/common/runtime-health.mjs';

const STATUS = new Set(['pass', 'warning', 'fail']);
export const FLEET_CHECK_IDS = Object.freeze(['inventory', 'publisher', 'secrets', 'backups', 'upgrade', 'docker', 'https']);
const ensure = (valid, reason) => { if (!valid) throw Error(reason); };
const privateDir = root => join(resolve(root), '.osmanx-fleet');
const paths = root => ({ dir: privateDir(root), priv: join(privateDir(root), 'agent-private.pem'), pub: join(privateDir(root), 'agent-public.pem') });
export const fingerprintOf = key => createHash('sha256').update((key?.type==='public'?key:createPublicKey(key)).export({format:'der', type:'spki'})).digest('hex');

async function privateDirectory(path) {
  const st = await lstat(path);
  ensure(st.isDirectory() && !st.isSymbolicLink(), 'Invalid fleet key directory');
  if (process.platform !== 'win32') ensure((st.mode & 0o077) === 0, 'Fleet key directory must be private');
}
async function safeReadKey(path, label) {
  const st = await lstat(path);
  ensure(st.isFile() && !st.isSymbolicLink() && st.size <= 5000, 'Unsafe ' + label + ' key file');
  if (process.platform !== 'win32') ensure((st.mode & 0o077) === 0, label + ' key permissions must be private');
  return readFile(path, 'utf8');
}

export async function initFleetIdentity(root) {
  const p = paths(root);
  try { await mkdir(p.dir, {mode:0o700}); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  await privateDirectory(p.dir);
  const pair = generateKeyPairSync('ed25519');
  const priv = pair.privateKey.export({format:'pem', type:'pkcs8'});
  const pub = pair.publicKey.export({format:'pem', type:'spki'});
  // Never overwrite an existing private key, including a symlink.
  const fd = await open(p.priv, 'wx', 0o600);
  try { await fd.writeFile(priv); await fd.sync(); }
  finally { await fd.close(); }
  try { await writeFile(p.pub, pub, {flag:'wx', mode:0o600}); }
  catch (e) { /* retain the private key; never silently rotate it */ throw e; }
  return {fingerprint:fingerprintOf(pair.publicKey),publicKeyPem:String(pub)};
}
export async function getFleetPublicKey(root) {
  const p = paths(root); await privateDirectory(p.dir);
  const publicPem = await safeReadKey(p.pub, 'public');
  ensure(createPublicKey(publicPem).asymmetricKeyType === 'ed25519', 'Unexpected public key algorithm');
  return {publicKeyPem:publicPem, fingerprint:fingerprintOf(publicPem)};
}
export async function readRuntimeEvidence({root,projectId,service,releaseSequence,now}){
  const local=await loadRuntimeSummary({dataDir:join(root,'data'),projectId,service,releaseSequence,now});
  if(local.status!=='unavailable')return local;
  // The named app volume is not mounted on the host. Read the exact same,
  // allowlisted summary from inside the running container. No remote network.
  const result=spawnSync('docker',['compose','exec','-T','app','node','deploy/telemetry-read.mjs'],
    {cwd:root,encoding:'utf8',timeout:20000,maxBuffer:16384});
  if(result.error||result.status!==0)throw Error('Opt-in telemetry unavailable: app container is not accessible');
  const parsed=JSON.parse(result.stdout.trim());
  // Fleet verifier validates every field; this file cannot contain raw logs.
  return parsed;
}
export async function createFleetSnapshot({root, doctor=inspectDeployment, when=new Date(), docker=false, live=false, telemetry=false, readTelemetry=readRuntimeEvidence} = {}) {
  root=resolve(root);
  if(typeof docker!=='boolean'||typeof live!=='boolean'||typeof telemetry!=='boolean')throw Error('Explicit check modes must be boolean');
  const report=await doctor({root, docker, live});
  ensure(report && report.format === 'osmanx-deployment-acceptance' && report.version === 1, 'Unknown diagnostic format');
  ensure(/^[0-9a-f-]{36}$/i.test(report.projectId||'') && Number.isSafeInteger(report.releaseSequence), 'Missing release identity');
  const app=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
  const service=app.format === 'osmanx-standalone-site' ? 'site' : app.format === 'osmanx-standalone-release' ? 'crm' : null;
  ensure(service && app.projectId===report.projectId && app.release.sequence===report.releaseSequence, 'Inconsistent local identity');
  const statuses = {};
  for (const id of FLEET_CHECK_IDS) {
    const found=report.checks.find(item=>item.id===id);
    ensure(found && STATUS.has(found.status), 'Invalid diagnostic status: '+id);
    statuses[id]=found.status;
  }
  const requestedChecks={docker,https:live};
  if(!docker && statuses.docker!=='warning')throw Error('Unrequested Docker check must remain unverified');
  if(!live && statuses.https!=='warning')throw Error('Unrequested public HTTPS check must remain unverified');
  const payload={
    format:'osmanx-fleet-status',version:telemetry?3:docker||live?2:1,projectId:app.projectId,service,
    releaseSequence:app.release.sequence,observedAt:when.toISOString(),
    nonce:randomBytes(16).toString('hex'),
    offlineOnly:!docker&&!live,checks:statuses
  };
  if(payload.version>=2)payload.requestedChecks=requestedChecks;
  if(telemetry){
    // The source is a local aggregate status-counter file, never request logs.
    // No implicit Docker or HTTPS probes are initiated.
    payload.requestedTelemetry=true;
    payload.telemetry=await readTelemetry({root,projectId:app.projectId,service,releaseSequence:app.release.sequence,now:when.getTime()});
  }
  return payload;
}
export async function signFleetSnapshot({root, payload}) {
  const p=paths(root); await privateDirectory(p.dir);
  const key=createPrivateKey(await safeReadKey(p.priv, 'private'));
  ensure(key.asymmetricKeyType==='ed25519', 'Expected Ed25519 private key');
  const publicKey=createPublicKey(key);
  const known=await getFleetPublicKey(root);
  ensure(fingerprintOf(publicKey)===known.fingerprint, 'Fleet public/private key mismatch');
  const signature=sign(null,Buffer.from(JSON.stringify(payload)),key).toString('base64');
  return {payload,signature,algorithm:'Ed25519',keyFingerprint:known.fingerprint};
}
export async function saveFleetSnapshot(path,packet,{root}={}) {
  const target=resolve(path);
  ensure(target.endsWith('.json'),'Expected JSON output file');
  const parent=await realpath(dirname(target));
  const actual=join(parent,target.split(sep).at(-1));
  if(root){const install=await realpath(resolve(root));ensure(actual!==install&&!actual.startsWith(install+sep),'Save fleet reports outside the client installation directory');}
  const handle=await open(actual,'wx',0o600);
  try {await handle.writeFile(JSON.stringify(packet,null,2)+'\n');await handle.sync();}
  finally {await handle.close();}
  return actual;
}
async function main() {
  process.umask(0o077);
  const args=process.argv.slice(2),cmd=args[0],opt=k=>args.find(x=>x.startsWith('--'+k+'='))?.slice(k.length+3);
  const root=opt('installed')?resolve(opt('installed')):resolve(dirname(fileURLToPath(import.meta.url)),'..');
  if (cmd==='init') {
    ensure(args.includes('--confirm'), 'init requires --confirm');
    const {fingerprint}=await initFleetIdentity(root);
    console.log(JSON.stringify({initialized:true,fingerprint,networkRequests:0}));
  } else if (cmd==='public') {
    const {publicKeyPem,fingerprint}=await getFleetPublicKey(root);
    console.log(JSON.stringify({publicKeyPem,fingerprint}));
  } else if (cmd==='snapshot') {
    const output=opt('out');ensure(output,'snapshot requires --out=/private/status.json');
    // Network and Docker checks run only when the operator explicitly asks for them.
    const payload=await createFleetSnapshot({root,docker:args.includes('--docker'),live:args.includes('--live'),telemetry:args.includes('--telemetry')});
    const packet=await signFleetSnapshot({root,payload});
    await saveFleetSnapshot(output,packet,{root});
    console.log(JSON.stringify({saved:true,projectId:payload.projectId,releaseSequence:payload.releaseSequence,offlineOnly:payload.offlineOnly,requestedChecks:payload.requestedChecks||{docker:false,https:false},telemetryIncluded:payload.requestedTelemetry===true}));
  } else throw Error('Usage: fleet-agent.mjs init --confirm | public | snapshot --out=/private/status.json [--docker] [--live] [--telemetry]');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(e=>{console.error('OSMANX FLEET: '+e.message);process.exitCode=1});
