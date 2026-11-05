/**
 * OSMANX deployment update controller. Run on the VPS host, not inside Docker.
 * R2.6 preview: fixed Compose identity, offline DB backup, startup gate and rollback.
 * ZIP hashes detect corruption, NOT authenticity. Install only trusted factory releases.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, rm, lstat, readdir, stat, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStoredZip } from '../../src/common/archive.mjs';
import { observeRollout } from './rollout-observe.mjs';
import { SIGNATURE_PATH, verifyReleaseSignature } from './signature.mjs';
import { selectTrustedPublicKey } from './trust-policy.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const assert = (ok, message) => { if (!ok) throw Error(message); };
const kitFiles = ['manifest.json', 'deploy/manifest.json'];
const stateName = '.osmanx-upgrades';
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const isObject = obj => obj && typeof obj === 'object' && !Array.isArray(obj);
function safePath(path) {
  return typeof path === 'string' && path.length <= 200 && !path.startsWith('/') &&
    /^[a-zA-Z0-9_.\/-]+$/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..');
}
function assertManagedPath(path) {
  assert(safePath(path), 'Invalid package file path: ' + String(path));
  assert(![ '.env', 'backups', 'data' ].includes(path) && !path.endsWith('/.env') &&
    !path.startsWith('backups/') && !path.startsWith('data/') && !path.startsWith('.osmanx-trust/') && !path.startsWith(stateName+'/'),
    'Attempt to overwrite private/runtime file: ' + path);
  assert(/^(src\/(common|crm|site)\/|public\/(crm|site)\/|deploy\/|config\/)/.test(path) ||
    ['run.mjs','ops.mjs','package.json','manifest.json','compose.yaml','Dockerfile','.dockerignore','.env.example','.gitignore','README.md'].includes(path),
    'Unexpected managed path: ' + path);
}
async function noLink(path) {
  const s = await lstat(path);
  assert(!s.isSymbolicLink(), 'Symbolic link forbidden: ' + path);
  return s;
}
async function safeTarget(root, name, { allowMissing = false } = {}) {
  assertManagedPath(name);
  const target = resolve(root, name);
  assert(target.startsWith(root + sep), 'Managed path escapes installation');
  let part = root;
  for (const element of name.split('/')) {
    part = join(part, element);
    try { await noLink(part); } catch (e) {
      if (e.code === 'ENOENT' && allowMissing) continue;
      throw e;
    }
  }
  return target;
}
async function loadJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
function manifestInventory(manifest, deployment) {
  assert(isObject(manifest) && isObject(deployment), 'Release manifest missing');
  assert(manifest.manifestVersion === 1 &&
    ['osmanx-standalone-release', 'osmanx-standalone-site'].includes(manifest.format), 'Unknown application manifest format');
  assert(deployment.format === 'osmanx-deployment-kit' && deployment.version === 2,
    'Unsupported deployment kit; R2.4 format v1 cannot be upgraded automatically');
  assert(idPattern.test(manifest.projectId) && deployment.projectId === manifest.projectId,
    'Project identity mismatch');
  const expectedCompose = 'osmanx_' + manifest.projectId.replaceAll('-', '').slice(0, 12);
  assert(deployment.composeProject === expectedCompose, 'Compose project identity mismatch');
  assert(typeof deployment.domain === 'string' && /^[a-z0-9.-]{3,253}$/.test(deployment.domain),
    'Invalid deployment domain');
  assert(Number.isSafeInteger(manifest.release?.sequence) && manifest.release.sequence >= 0,
    'Invalid application release sequence');
  assert(typeof manifest.applicationVersion === 'string' && manifest.applicationVersion.length <= 32,
    'Missing application engine version');
  assert(isObject(manifest.files) && isObject(deployment.files), 'File hashes missing');
  const hashes = new Map();
  for (const group of [manifest.files, deployment.files]) {
    for (const [name, digest] of Object.entries(group)) {
      assertManagedPath(name);
      assert(!kitFiles.includes(name) && !hashes.has(name), 'Duplicate inventory path: ' + name);
      assert(/^[0-9a-f]{64}$/.test(digest), 'Invalid SHA256: ' + name);
      hashes.set(name, digest);
    }
  }
  assert(hashes.size > 15 && hashes.size <= 380, 'Unexpected deployment file count');
  return { hashes, type: manifest.format === 'osmanx-standalone-site' ? 'site' : 'crm' };
}
function checkConfigCompatibility(previous, next, type) {
  assert(isObject(previous) && isObject(next) && previous.id === next.id &&
    previous.type === next.type && next.type === type, 'Project configuration identity mismatch');
  assert(Array.isArray(previous.modules) && Array.isArray(next.modules), 'Missing module list');
  for (const module of previous.modules)
    assert(next.modules.includes(module), 'Removing existing module needs manual migration: ' + module);
  if (type !== 'crm') return;
  const nextEntities = new Map((next.entities || []).map(e => [e.slug, e]));
  for (const old of previous.entities || []) {
    const target = nextEntities.get(old.slug);
    assert(target && Array.isArray(old.fields) && Array.isArray(target.fields),
      'Entity removal or corruption is not supported: ' + old.slug);
    const newFields = new Map(target.fields.map(f => [f.key, f]));
    for (const oldField of old.fields) {
      const newer = newFields.get(oldField.key);
      assert(newer && JSON.stringify(newer) === JSON.stringify(oldField),
        'Changing/removing existing entity field needs manual migration: ' + old.slug + '.' + oldField.key);
    }
    for (const field of target.fields)
      if (!old.fields.some(f => f.key === field.key)) {
        assert(field.required !== true && field.unique !== true,
          'New required/unique field needs manual migration: ' + old.slug + '.' + field.key);
      }
  }
}
function parseKitArchive(bytes) {
  const entries = parseStoredZip(bytes, { maxFiles: 400, maxBytes: 80 * 1024 * 1024 });
  assert(entries.has('manifest.json') && entries.has('deploy/manifest.json'), 'Missing release manifests');
  const app = JSON.parse(entries.get('manifest.json').toString('utf8'));
  const deploy = JSON.parse(entries.get('deploy/manifest.json').toString('utf8'));
  const { hashes, type } = manifestInventory(app, deploy);
  assert(sha(entries.get('manifest.json')) === deploy.applicationManifestSha256,
    'Application manifest hash mismatch');
  assert(entries.size === hashes.size + 2 + Number(entries.has(SIGNATURE_PATH)), 'Untracked or missing ZIP entries');
  assert(!hashes.has(SIGNATURE_PATH), 'Signature must be a detached, untracked ZIP entry');
  for (const [name, digest] of hashes)
    assert(entries.has(name) && sha(entries.get(name)) === digest, 'ZIP checksum mismatch: ' + name);
  assert(entries.has('deploy/upgrade.mjs'), 'Candidate lacks R2.6 update/recovery support');
  const project = JSON.parse(entries.get('config/project.json').toString('utf8'));
  assert(project.id === app.projectId && project.type === type, 'Invalid archived project config');
  assert(sha(JSON.stringify(project)) === app.snapshotSha256, 'Release snapshot hash mismatch');
  assert(entries.get('compose.yaml').toString('utf8').includes('name: '+deploy.composeProject+'\n'),
    'Compose file does not preserve the fixed project ID');
  return { entries, app, deploy, hashes, type, project };
}
async function installedKit(root) {
  root = resolve(root);
  const rootStat = await noLink(root);
  assert(rootStat.isDirectory(), 'Installed root is not a directory');
  const appBytes = await readFile(await safeTarget(root, 'manifest.json'));
  const app = JSON.parse(appBytes.toString('utf8'));
  const deploy = await loadJson(await safeTarget(root, 'deploy/manifest.json'));
  const { hashes, type } = manifestInventory(app, deploy);
  assert(sha(appBytes) === deploy.applicationManifestSha256, 'Installed application manifest mismatch');
  for (const [name, digest] of hashes) {
    const path = await safeTarget(root, name);
    assert((await noLink(path)).isFile(), 'Managed path is not a regular file: ' + name);
    assert(sha(await readFile(path)) === digest, 'Locally modified managed file: ' + name);
  }
  const project = await loadJson(await safeTarget(root, 'config/project.json'));
  assert(project.id === app.projectId && project.type === type, 'Installed project mismatch');
  assert(sha(JSON.stringify(project)) === app.snapshotSha256, 'Installed project snapshot mismatch');
  const privateEnv = join(root, '.env');
  if (existsSync(privateEnv)) {
    const privateStat = await noLink(privateEnv);
    assert(privateStat.isFile(), '.env must be a regular file');
    if (process.platform !== 'win32') assert((privateStat.mode & 0o077) === 0, '.env must not be accessible to group/others');
  }
  return { root, app, deploy, type, hashes, project };
}
async function readRelease(path) {
  assert((await noLink(resolve(path))).isFile(), 'Release ZIP must be a regular file');
  const s = await stat(path);
  assert(s.size <= 80*1024*1024, 'Release ZIP exceeds 80 MB');
  const bytes = await readFile(path);
  return { ...parseKitArchive(bytes), zipSha256:sha(bytes) };
}
export async function planUpgrade({ root, zipPath, trustKeyPath = null, requireSignature = false }) {
  const [old, next] = await Promise.all([installedKit(root), readRelease(zipPath)]);
  const trustedKey = await selectTrustedPublicKey(old.root,next.entries,{overridePath:trustKeyPath});
  if (requireSignature && !trustedKey) throw Error('Signature required but no trusted publisher public key is configured');
  const signature = verifyReleaseSignature(next.entries, trustedKey, {requireSignature});
  assert(next.app.projectId === old.app.projectId && next.type === old.type,
    'Refusing another project or application type');
  assert(next.deploy.domain === old.deploy.domain && next.deploy.composeProject === old.deploy.composeProject,
    'Domain or Compose identity changed: explicit manual deployment required');
  assert(next.app.applicationVersion === old.app.applicationVersion,
    'Application engine version changed: manual migration review required');
  assert(next.app.release.sequence > old.app.release.sequence,
    'New release sequence must be higher than the installed sequence');
  const coreFiles = old.type==='site'?['src/site/schema.sql','src/site/db.mjs','src/site/model.mjs']:
    ['src/crm/schema.sql','src/crm/db.mjs','src/crm/entities.mjs'];
  for (const name of [...coreFiles,'src/common/db.mjs']) {
    if (old.hashes.has(name) && next.hashes.has(name))
      assert(old.hashes.get(name) === next.hashes.get(name),
        'Core database schema/engine changed: manual migration review required: ' + name);
  }
  checkConfigCompatibility(old.project, next.project, old.type);
  for (const name of next.hashes.keys()) {
    const dest = await safeTarget(old.root, name, { allowMissing:true });
    if (!old.hashes.has(name) && existsSync(dest))
      throw Error('New managed file collides with an unmanaged local file: ' + name);
  }
  assert(!existsSync(join(old.root,stateName,'active.json')), 'Interrupted upgrade exists: run recover first');
  return {
    old, next, summary: {
      ok:true, projectId:old.app.projectId, type:old.type, domain:old.deploy.domain,
      from:old.app.release.sequence, to:next.app.release.sequence, candidateSha256:next.zipSha256,
      changed:[...next.hashes].filter(([name,digest])=>old.hashes.get(name)!==digest).length,
      added:[...next.hashes.keys()].filter(name=>!old.hashes.has(name)).length,
      removed:[...old.hashes.keys()].filter(name=>!next.hashes.has(name)).length,
      requiresStoppedApp:true, databaseBackupRequired:true, hostDockerRequired:true,
      publisher:signature,
      warning:signature.verified?'Release signature verified against an externally pinned Ed25519 public key.':'UNSIGNED COMPATIBILITY MODE: SHA256 alone does not prove publisher identity. Install a pinned publisher public key to enforce signed releases.'
    }
  };
}
async function syncDirectory(dir) {
  if(process.platform==='win32')return;
  const handle=await open(dir,'r');
  try{await handle.sync()}finally{await handle.close()}
}
async function atomic(path, bytes, {durable=false}={}) {
  await mkdir(dirname(path), { recursive:true, mode:0o700 });
  const tmp=path+'.tmp-'+randomBytes(8).toString('hex');
  try {
    await writeFile(tmp,bytes,{flag:'wx',mode:0o600});
    if(durable){const file=await open(tmp,'r');try{await file.sync()}finally{await file.close()}}
    await rename(tmp,path);
    if(durable)await syncDirectory(dirname(path));
  }finally{await rm(tmp,{force:true})}
}
function validateJournal(state) {
  assert(isObject(state) && state.format==='osmanx-upgrade-journal' && state.version===1,
    'Invalid interrupted upgrade journal');
  assert(/^\d{14}-[a-f0-9]{12}$/.test(state.id||'') && idPattern.test(state.projectId),
    'Invalid upgrade journal identity');
  assert(Number.isSafeInteger(state.from) && state.from>=0 && Number.isSafeInteger(state.to) && state.to>state.from,
    'Invalid upgrade journal version sequence');
  assert(state.composeProject==='osmanx_'+state.projectId.replaceAll('-','').slice(0,12) &&
    typeof state.domain==='string' && /^[a-z0-9.-]{3,253}$/.test(state.domain) &&
    /^[a-f0-9]{64}$/.test(state.zipSha256||''), 'Invalid upgrade journal deployment identity');
  assert(['preparing','stopped','database-backed-up','files-updated','service-started',
    'observing','activating','gateway-open','manual-review-required','recovery-required',
    'completed','completed-after-manual-review','rolled-back','recovered'].includes(state.phase),
    'Unknown interrupted upgrade phase');
  assert((state.backupId===null || /^\d{14}-[a-f0-9]{12}$/.test(state.backupId||'')) &&
    Array.isArray(state.added) && state.added.length<=380 &&
    new Set(state.added).size===state.added.length, 'Invalid upgrade journal managed files');
  for(const name of state.added)assertManagedPath(name);
  return state;
}
async function saveState(root,state) {
  validateJournal(state);
  await atomic(join(root,stateName,'active.json'),Buffer.from(JSON.stringify(state,null,2)+'\n'),{durable:true});
}
async function snapshot(old, snapshotDir) {
  await mkdir(snapshotDir,{recursive:true,mode:0o700});
  const all=[...old.hashes.keys(),...kitFiles];
  if (existsSync(join(old.root,SIGNATURE_PATH))) all.push(SIGNATURE_PATH);
  for (const name of all) await atomic(join(snapshotDir,'files',name),await readFile(await safeTarget(old.root,name)));
  const ledger={projectId:old.app.projectId,domain:old.deploy.domain,composeProject:old.deploy.composeProject,
    sequence:old.app.release.sequence,files:Object.fromEntries(all.map(name=>[name,
      old.hashes.get(name)||null]))};
  ledger.files['manifest.json']=sha(await readFile(join(snapshotDir,'files/manifest.json')));
  ledger.files['deploy/manifest.json']=sha(await readFile(join(snapshotDir,'files/deploy/manifest.json')));
  if (all.includes(SIGNATURE_PATH)) ledger.files[SIGNATURE_PATH]=sha(await readFile(join(snapshotDir,'files',SIGNATURE_PATH)));
  await atomic(join(snapshotDir,'snapshot.json'),Buffer.from(JSON.stringify(ledger,null,2)+'\n'),{durable:true});
}
async function restoreCode(root,state) {
  const snapshotDir=join(root,stateName,'snapshots',state.id);
  const ledger=await loadJson(join(snapshotDir,'snapshot.json'));
  assert(ledger.projectId===state.projectId && ledger.composeProject===state.composeProject,
    'Snapshot identity mismatch: manual recovery required');
  const prior = new Set(Object.keys(ledger.files));
  // Verify the entire code snapshot before changing any live file.
  for (const [name,digest] of Object.entries(ledger.files)) {
    assertManagedPath(name);
    const path=join(snapshotDir,'files',name);
    assert((await noLink(path)).isFile() && sha(await readFile(path))===digest,
      'Snapshot checksum mismatch: '+name);
    await safeTarget(root,name,{allowMissing:true});
  }
  for (const name of state.added || []) {
    assertManagedPath(name);
    if(!prior.has(name)) await rm(await safeTarget(root,name,{allowMissing:true}),{force:true});
  }
  for (const name of prior)
    await atomic(await safeTarget(root,name,{allowMissing:true}),await readFile(join(snapshotDir,'files',name)));
  return ledger;
}
async function installCode(root, old, next) {
  const protectedFiles = new Set(kitFiles);
  // Manifest files are installed last. Runtime secrets and backups are never in the bundle.
  // Detached signature is release metadata, not part of the hashed application inventory.
  for (const [name,bytes] of next.entries)
    if(!protectedFiles.has(name) && name!==SIGNATURE_PATH) await atomic(await safeTarget(root,name,{allowMissing:true}),bytes);
  for (const name of old.hashes.keys())
    if(!next.hashes.has(name)) await rm(await safeTarget(root,name),{force:true});
  for (const name of kitFiles)
    await atomic(await safeTarget(root,name),next.entries.get(name));
  const signatureTarget=await safeTarget(root,SIGNATURE_PATH,{allowMissing:true});
  if (next.entries.has(SIGNATURE_PATH)) await atomic(signatureTarget,next.entries.get(SIGNATURE_PATH));
  else await rm(signatureTarget,{force:true});
}
function docker(cwd,args,timeout=180000) {
  const result=spawnSync('docker',['compose',...args],{cwd,encoding:'utf8',timeout,maxBuffer:2*1024*1024});
  if(result.error)throw Error('Docker Compose unavailable: '+result.error.message);
  if(result.status!==0)throw Error('docker compose '+args.join(' ')+' failed: '+String(result.stderr||result.stdout).slice(-1600));
  return String(result.stdout||'');
}
function outputObject(output) {
  const lines=output.trim().split('\n');
  for(let i=lines.length-1;i>=0;i--){try{const j=JSON.parse(lines[i]);if(j?.ok===true)return j;}catch{}}
  throw Error('Maintenance returned no valid JSON result');
}
export function dockerAdapter() {
  return {
    async preflight(root){docker(root,['version'],15000);docker(root,['config','--quiet'],30000);},
    async stop(root){
      // Block public ingress first; then allow in-flight DB writes to finish gracefully.
      docker(root,['stop','--timeout','30','gateway'],60000);
      docker(root,['stop','--timeout','90','app'],120000);
    },
    async backup(root){return outputObject(docker(root,['--profile','maintenance','run','--rm','--no-deps','maintenance','backup']));},
    async restore(root,id){return outputObject(docker(root,['--profile','maintenance','run','--rm','--no-deps','maintenance','restore',id,'--confirm']));},
    async up(root){docker(root,['up','-d','--build','--wait','--wait-timeout','120','app'],240000);},
    async activate(root){docker(root,['up','-d','--wait','--wait-timeout','120','gateway'],120000);},
    async health(root){docker(root,['exec','-T','app','node','deploy/healthcheck.mjs'],30000);},
    async observe(root){return observeRollout({root,samples:3,intervalMs:3000,record:true});}
  };
}
/** Linux /proc start ticks and boot ID bind a lock to a PROCESS INSTANCE,
 * not just a PID (which may be reused after a container/host restart).
 * No fingerprint => fail closed when an apparently live PID owns a lock. */
export async function linuxProcessIdentity(pid, read = readFile) {
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const [stat, boot] = await Promise.all([
      read(`/proc/${pid}/stat`, 'utf8'),
      read('/proc/sys/kernel/random/boot_id', 'utf8')
    ]);
    const end = stat.lastIndexOf(')');
    if(end < 0) return null;
    const fields = stat.slice(end + 1).trim().split(/\s+/); // begins at field 3
    const ticks = fields[19]; // kernel stat field 22 = process starttime
    const bootId = String(boot).trim().toLowerCase();
    if (!/^[0-9]+$/.test(ticks||'') || !/^[0-9a-f-]{36}$/.test(bootId)) return null;
    return `${bootId}:${ticks}`;
  } catch {return null}
}
export function mayReclaimOwner(owner,{alive,currentIdentity}={}) {
  if (!alive) return true;
  // Old v1 locks do not contain a boot-aware process fingerprint.
  return owner?.version===2 && typeof owner.processIdentity==='string' &&
    /^[a-f0-9-]{36}:[0-9]+$/.test(owner.processIdentity) &&
    typeof currentIdentity==='string' && currentIdentity.length>0 &&
    currentIdentity!==owner.processIdentity;
}
function processAlive(pid){
  if(!Number.isSafeInteger(pid)||pid<1)return true;
  try{process.kill(pid,0);return true}catch(e){return e.code!=='ESRCH'}
}
async function reclaimDeadLock(path) {
  // Only for explicitly confirmed recovery/resume, never automatic apply.
  const dir=await noLink(path);
  assert(dir.isDirectory() && (process.platform==='win32'||(dir.mode&0o077)===0),
    'Unsafe pre-existing upgrade lock');
  const ownerFile=join(path,'owner.json');
  const ownerInfo=await noLink(ownerFile);
  assert(ownerInfo.isFile() && ownerInfo.size<=2048 &&
    (process.platform==='win32'||(ownerInfo.mode&0o077)===0),
    'Unverifiable stale lock; manual investigation required');
  const owner=await loadJson(ownerFile);
  assert(owner?.format==='osmanx-upgrade-lock' && [1,2].includes(owner.version) &&
    Number.isSafeInteger(owner.pid) && owner.pid>0 && /^[a-f0-9]{24}$/.test(owner.token||'') &&
    (owner.version===1 || owner.processIdentity===null ||
      /^[a-f0-9-]{36}:[0-9]+$/.test(owner.processIdentity||'')),
    'Invalid lock owner record');
  const alive=processAlive(owner.pid);
  const currentIdentity=alive ? await linuxProcessIdentity(owner.pid) : null;
  assert(mayReclaimOwner(owner,{alive,currentIdentity}),
    'Another upgrade is still running, or PID reuse cannot be safely excluded');
  const tombstone=path+'.stale-'+randomBytes(6).toString('hex');
  await rename(path,tombstone);
  await rm(tombstone,{recursive:true});
}
async function withLock(root, task, {reclaimStale=false}={}) {
  const updates=join(root,stateName);
  if (existsSync(updates)) {
    const s=await noLink(updates);
    assert(s.isDirectory() && (process.platform==='win32' || (s.mode & 0o077)===0),
      'Upgrade history directory must be private and not a symlink');
  } else await mkdir(updates,{mode:0o700});
  const path=join(updates,'lock');
  try{await mkdir(path,{mode:0o700})}catch(e){
    if(e.code!=='EEXIST')throw e;
    if(!reclaimStale)throw Error('Another upgrade is running or lock needs manual review');
    await reclaimDeadLock(path);
    await mkdir(path,{mode:0o700});
  }
  try{
    await atomic(join(path,'owner.json'),Buffer.from(JSON.stringify({
      format:'osmanx-upgrade-lock',version:2,pid:process.pid,
      processIdentity:await linuxProcessIdentity(process.pid),
      token:randomBytes(12).toString('hex'),startedAt:new Date().toISOString()
    })+'\n'),{durable:true});
    return await task();
  }finally{await rm(path,{recursive:true,force:true})}
}
async function finishState(root,state,phase) {
  state.phase=phase;state.finishedAt=new Date().toISOString();
  await saveState(root,state);
  await mkdir(join(root,stateName,'history'),{recursive:true,mode:0o700});
  await rename(join(root,stateName,'active.json'),join(root,stateName,'history',state.id+'.json'));
  await syncDirectory(join(root,stateName,'history'));
  await syncDirectory(join(root,stateName));
}
/** Explicit forward recovery only. Never restore an old SQLite snapshot after gateway ingress
 * could have resumed: doing so would discard client writes. Requires operator review. */
async function readActiveJournal(root) {
  const dir=join(root,stateName);
  const directory=await noLink(dir);
  assert(directory.isDirectory() && (process.platform==='win32'||(directory.mode&0o077)===0),
    'Upgrade journal directory must be private');
  const file=join(dir,'active.json');
  const info=await noLink(file);
  assert(info.isFile() && info.size<=65536 && (process.platform==='win32'||(info.mode&0o077)===0),
    'Upgrade journal must be a small private regular file');
  return validateJournal(await loadJson(file));
}
export async function resumeUpgrade({ root, confirm=false, adapter=dockerAdapter() }) {
  assert(confirm===true,'Resume requires explicit --confirm; inspect status and client writes first');
  root=resolve(root);
  return withLock(root,async()=>{
    const state=await readActiveJournal(root);
    assert(state.phase==='manual-review-required', 'Forward resume is allowed only after ambiguous gateway activation');
    const current=await installedKit(root);
    assert(current.app.projectId===state.projectId &&
      current.deploy.composeProject===state.composeProject && current.deploy.domain===state.domain &&
      current.app.release.sequence===state.to,
      'Installed version differs from pending release: manual investigation required');
    // Fail closed: an operator cannot forward-resume an unsigned or replaced release.
    assert(state.publisher?.verified===true, 'Forward resume requires a previously verified signed release');
    const entries=new Map();
    for(const name of [...current.hashes.keys(),...kitFiles])
      entries.set(name,await readFile(await safeTarget(root,name)));
    const signaturePath=await safeTarget(root,SIGNATURE_PATH);
    entries.set(SIGNATURE_PATH,await readFile(signaturePath));
    const pem=await selectTrustedPublicKey(root,entries);
    assert(pem, 'Publisher trust key is missing; forward resume refused');
    assert(verifyReleaseSignature(entries,pem,{requireSignature:true}).verified===true,
      'Installed signed release verification failed');
    // Re-open the SAME new version only. Do not touch .env or SQLite, do not restore a backup.
    // The previous failure path already attempted to close the gateway, but there is no
    // guarantee no client writes were accepted before that close was complete.
    try {
      await adapter.stop(root);
      await adapter.up(root);
      await adapter.health(root);
      const observation=typeof adapter.observe==='function'?await adapter.observe(root):null;
      assert(observation?.observedStable===true && observation.samplesCompleted>=2,
        'Stable Docker observation is required before reopening ingress');
      state.rollout={observedStable:true,samplesCompleted:observation.samplesCompleted};
      await adapter.activate(root);
      // A failed journal write must never trigger database rollback.
      await finishState(root,state,'completed-after-manual-review');
      return {ok:true,projectId:state.projectId,releaseSequence:state.to,
        keptNewVersion:true,databaseRestored:false,backupId:state.backupId,
        warning:'Gateway reopened; independently verify public HTTPS and business records.'};
    } catch(error) {
      try {await adapter.stop(root)}catch(e){state.stopError=e.message}
      state.phase='manual-review-required';state.resumeError=String(error.message).slice(0,350);
      await saveState(root,state);
      throw Error('Forward resume failed; no automatic database rollback performed: '+error.message);
    }
  },{reclaimStale:true});
}
async function rollbackInternal(root,state,adapter) {
  // Stop newly created containers before touching SQLite, then restore trusted old code.
  await adapter.stop(root);
  await restoreCode(root,state);
  if(state.backupId) {
    const result=await adapter.restore(root,state.backupId);
    assert(result.ok===true, 'Database restore did not succeed');
  }
  await adapter.up(root);
  await adapter.health(root);
  if(typeof adapter.activate==='function')await adapter.activate(root);
  return {ok:true,rolledBackTo:state.from,backupId:state.backupId};
}
export async function applyUpgrade({ root, zipPath, confirm=false, adapter=dockerAdapter(), trustKeyPath=null, requireSignature=false }) {
  assert(confirm===true, 'Apply requires explicit --confirm');
  root=resolve(root);
  return withLock(root,async()=>{
    const {old,next,summary}=await planUpgrade({root,zipPath,trustKeyPath,requireSignature});
    assert(existsSync(join(root,'.env')), 'Missing private .env: prepare installation first');
    const backups=join(root,'backups');
    const backupStat=await noLink(backups);
    assert(backupStat.isDirectory() && (process.platform==='win32' || (backupStat.mode & 0o077)===0),
      'Private backups directory must have restricted permissions');
    if (typeof adapter.preflight === 'function') await adapter.preflight(root);
    const id=new Date().toISOString().replace(/\D/g,'').slice(0,14)+'-'+randomBytes(6).toString('hex');
    const state={format:'osmanx-upgrade-journal',version:1,id,projectId:summary.projectId,
      composeProject:old.deploy.composeProject,domain:summary.domain,from:summary.from,to:summary.to,
      zipSha256:summary.candidateSha256,publisher:summary.publisher,phase:'preparing',backupId:null,
      added:[...next.hashes.keys()].filter(name=>!old.hashes.has(name)).concat(
        next.entries.has(SIGNATURE_PATH) && !existsSync(join(root,SIGNATURE_PATH)) ? [SIGNATURE_PATH] : []),
      createdAt:new Date().toISOString()};
    await snapshot(old,join(root,stateName,'snapshots',id));
    await saveState(root,state);
    try {
      await adapter.stop(root);state.phase='stopped';await saveState(root,state);
      const backup=await adapter.backup(root);
      assert(backup?.ok===true && /^\d{14}-[a-f0-9]{12}$/.test(backup.id||''),
        'Offline backup failed, refusing code replacement');
      state.backupId=backup.id;state.phase='database-backed-up';await saveState(root,state);
      await installCode(root,old,next);state.phase='files-updated';await saveState(root,state);
      await installedKit(root); // All managed files and hashes verified before boot.
      await adapter.up(root);state.phase='service-started';await saveState(root,state);
      await adapter.health(root);
      state.phase='observing';await saveState(root,state);
      // Real Docker adapter performs repeated, local, restart-sensitive health observations.
      // Test adapters without observe retain the original immediate health contract.
      const observation=typeof adapter.observe==='function'?await adapter.observe(root):null;
      if(observation)assert(observation.observedStable===true,'Post-upgrade observation incomplete');
      state.rollout=observation?{observedStable:true,samplesCompleted:observation.samplesCompleted}:null;
      // Keep external gateway OFF until the new app passes the stability gate.
      // This prevents accepting client writes that would be lost on automatic rollback.
      if(typeof adapter.activate==='function'){
        state.phase='activating';await saveState(root,state);
        await adapter.activate(root);
        state.phase='gateway-open';await saveState(root,state);
      }
      await finishState(root,state,'completed');
      return {...summary,upgraded:true,backupId:state.backupId,historyId:state.id,
        rolloutObserved:observation?.observedStable??false,
        note:'Local Compose rollout observed when Docker adapter supports it. Public HTTPS requires separate verify-live --live.'};
    } catch (error) {
      if(['activating','gateway-open'].includes(state.phase)) {
        // Exposure may have begun: replacing SQLite from an earlier backup could erase writes.
        // Stop ingress and leave data/code untouched until an operator inspects both versions.
        state.lastError=error.message;
        try {await adapter.stop(root)}catch(stopError){state.stopError=stopError.message}
        state.phase='manual-review-required';await saveState(root,state);
        throw Error('Gateway activation uncertain. Automatic database rollback refused to protect possible client writes; ingress stopped if possible. Inspect status and backups manually. '+error.message);
      }
      try {
        await rollbackInternal(root,state,adapter);
        await finishState(root,state,'rolled-back');
        throw Object.assign(Error('Upgrade failed, old version restored: '+error.message),{cause:error});
      } catch (rollbackError) {
        if (rollbackError.cause === error) throw rollbackError;
        state.phase='recovery-required';state.lastError=error.message;
        state.rollbackError=rollbackError.message;await saveState(root,state);
        throw Error('Upgrade failed and rollback is incomplete: '+error.message+'; '+rollbackError.message+'; run recover --confirm after investigation');
      }
    }
  });
}
export async function recoverUpgrade({ root, confirm=false, adapter=dockerAdapter() }) {
  assert(confirm, 'Recovery requires --confirm');root=resolve(root);
  return withLock(root,async()=>{
    const state=await readActiveJournal(root);
    assert(!['activating','gateway-open','manual-review-required'].includes(state.phase),
      'Manual review required: gateway may have exposed live writes. Automatic recovery is unsafe.');
    try {
      const result=await rollbackInternal(root,state,adapter);
      await finishState(root,state,'recovered');
      return result;
    }catch(e){state.phase='recovery-required';state.rollbackError=e.message;await saveState(root,state);throw e;}
  },{reclaimStale:true});
}
export async function getUpgradeStatus({root}) {
  const dir=join(resolve(root),stateName);
  if(!existsSync(dir))return {active:null,history:[]};
  const active=existsSync(join(dir,'active.json'))?await readActiveJournal(resolve(root)):null;
  const historyDir=join(dir,'history');
  const names=existsSync(historyDir)?(await readdir(historyDir)).filter(n=>/^\d{14}-[0-9a-f]{12}\.json$/.test(n)).sort().reverse().slice(0,20):[];
  return {active,history:await Promise.all(names.map(async n=>{const path=join(historyDir,n);const info=await noLink(path);
    assert(info.isFile() && info.size<=65536 && (process.platform==='win32'||(info.mode&0o077)===0),
      'Unsafe upgrade history entry');return validateJournal(await loadJson(path));}))};
}
const isMain=process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain) {
  const [command, arg] = process.argv.slice(2);
  const rootOption=process.argv.find(s=>s.startsWith('--installed='));
  const root=resolve(rootOption?rootOption.slice('--installed='.length):dirname(dirname(fileURLToPath(import.meta.url))));
  const trustOption=process.argv.find(s=>s.startsWith('--trust-key='));
  const trustKeyPath=trustOption?resolve(trustOption.slice('--trust-key='.length)):null;
  const requireSignature=process.argv.includes('--require-signature');
  const action=async()=>{
    if(command==='plan')return (await planUpgrade({root,zipPath:resolve(arg),trustKeyPath,requireSignature})).summary;
    if(command==='apply')return applyUpgrade({root,zipPath:resolve(arg),confirm:process.argv.includes('--confirm'),trustKeyPath,requireSignature});
    if(command==='recover')return recoverUpgrade({root,confirm:process.argv.includes('--confirm')});
    if(command==='resume')return resumeUpgrade({root,confirm:process.argv.includes('--confirm')});
    if(command==='status')return getUpgradeStatus({root});
    throw Error('Usage: upgrade.mjs plan NEW.zip | apply NEW.zip --confirm | recover --confirm | resume --confirm | status [--installed=/path/to/old] [--trust-key=/secure/key.pem] [--require-signature]');
  };
  process.umask(0o077);
  action().then(res=>console.log(JSON.stringify(res,null,2))).catch(error=>{
    console.error('OSMANX UPGRADE: '+error.message);process.exitCode=1;
  });
}
