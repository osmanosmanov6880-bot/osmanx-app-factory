/**
 * OSMANX R2.8 offline legacy volume migration (R2.4 v1 -> v2 fixed Compose name).
 * Intentionally host-side; no network and NO app startup. Never runs docker volume prune.
 * A completed migration does NOT establish data/application compatibility or live HTTPS.
 */
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, lstat, readdir, rename, rm, chmod, open, statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = b => createHash('sha256').update(b).digest('hex');
const insist = (ok, message) => { if (!ok) throw Error(message); };
const projectId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const composeName = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const volumeName = /^[a-z0-9][a-z0-9_-]{0,160}$/;
const volumeKinds = ['app_data', 'caddy_data', 'caddy_config'];
const stateDirName = '.osmanx-volume-migration';
const helperImage = 'node:22-bookworm-slim';
const isMap = o => o && typeof o === 'object' && !Array.isArray(o);
const sid = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14) + '-' + randomBytes(6).toString('hex');
const idRx = /^\d{14}-[0-9a-f]{12}$/;

async function regular(path, type='file') {
  const s=await lstat(path);
  insist(!s.isSymbolicLink() && (type==='file'?s.isFile():s.isDirectory()), 'Unsafe '+type+' or symbolic link: '+path);
  return s;
}
async function safeDirectory(root) {
  root=resolve(root);
  // Reject intermediate symlinks, not just the final directory.
  let p=resolve(root).startsWith('/')?'/':resolve(root).slice(0,3);
  for(const segment of resolve(root).slice(p.length).split(sep).filter(Boolean)) {
    p=join(p,segment);await regular(p,'directory');
  }
  return root;
}
async function internalFile(root,name) {
  insist(/^[a-zA-Z0-9_./-]{1,150}$/.test(name) && name.split('/').every(s=>s&&s!=='.'&&s!=='..'), 'Invalid source manifest path');
  const absolute=resolve(root,name);
  insist(absolute.startsWith(root+sep), 'Manifest path escapes installation');
  let path=root;
  const segments=name.split('/');
  for(let i=0;i<segments.length;i++) {
    path=join(path,segments[i]);await regular(path,i===segments.length-1?'file':'directory');
  }
  return absolute;
}
async function verifiedKit(root, requiredVersion) {
  root=await safeDirectory(root);
  const appBytes=await readFile(await internalFile(root,'manifest.json'));
  const app=JSON.parse(appBytes.toString('utf8'));
  const dep=JSON.parse(await readFile(await internalFile(root,'deploy/manifest.json'),'utf8'));
  insist(app.manifestVersion===1 && ['osmanx-standalone-release','osmanx-standalone-site'].includes(app.format), 'Invalid app manifest');
  insist(dep.format==='osmanx-deployment-kit' && dep.version===requiredVersion, 'Expected deployment kit format v'+requiredVersion);
  insist(projectId.test(app.projectId) && app.projectId===dep.projectId, 'Project ID mismatch');
  insist(typeof dep.domain==='string' && /^[a-z0-9.-]{3,253}$/.test(dep.domain), 'Invalid deployment domain');
  insist(hash(appBytes)===dep.applicationManifestSha256, 'Manifest checksum mismatch');
  const names=new Set();
  for(const table of [app.files,dep.files]) {
    insist(isMap(table), 'Missing file manifest');
    for(const [name,digest] of Object.entries(table)) {
      insist(!names.has(name) && !['manifest.json','deploy/manifest.json'].includes(name), 'Duplicate or invalid tracked file: '+name);
      insist(/^[0-9a-f]{64}$/.test(digest), 'Invalid hash: '+name);
      names.add(name);
      insist(hash(await readFile(await internalFile(root,name)))===digest,'Kit file checksum mismatch: '+name);
    }
  }
  insist(names.size>=15 && names.size<=380, 'Invalid kit inventory size');
  const config=JSON.parse(await readFile(await internalFile(root,'config/project.json'),'utf8'));
  insist(config.id===app.projectId && config.type===(app.format==='osmanx-standalone-site'?'site':'crm'), 'Project configuration mismatch');
  insist(hash(JSON.stringify(config))===app.snapshotSha256, 'Project snapshot checksum mismatch');
  const compose=await readFile(await internalFile(root,'compose.yaml'),'utf8');
  if(requiredVersion===1)insist(!/^name:\s*/m.test(compose),'Legacy kit unexpectedly declares a fixed Compose project');
  if(requiredVersion===2){
    const expected='osmanx_'+app.projectId.replaceAll('-','').slice(0,12);
    insist(dep.composeProject===expected && compose.startsWith('name: '+expected+'\n'),'New kit Compose project mismatch');
  }
  return {root,app,dep,config};
}
async function privateState(root) {
  const path=join(root,stateDirName);
  if(existsSync(path)) {
    const s=await regular(path,'directory');
    insist(process.platform==='win32'||(s.mode&0o077)===0,'Migration state contains personal data and must be mode 0700');
  } else await mkdir(path,{mode:0o700});
  return path;
}
async function fsyncDirectory(path){
  if(process.platform==='win32')return;
  const h=await open(path,'r');
  try{await h.sync()}finally{await h.close()}
}
async function durableRename(from,to){
  await rename(from,to);
  await fsyncDirectory(dirname(to));
  if(dirname(from)!==dirname(to))await fsyncDirectory(dirname(from));
}
async function atomic(file,data){
  await mkdir(dirname(file),{recursive:true,mode:0o700});
  const tmp=file+'.tmp-'+randomBytes(6).toString('hex');
  try{
    const h=await open(tmp,'wx',0o600);
    try{await h.writeFile(Buffer.from(JSON.stringify(data,null,2)+'\n'));await h.sync()}
    finally{await h.close()}
    await durableRename(tmp,file);
  }finally{await rm(tmp,{force:true})}
}
async function withLock(root,fn){
  const dir=await privateState(root),lock=join(dir,'lock');
  try{await mkdir(lock)}catch(e){if(e.code==='EEXIST')throw Error('Migration is locked: review before removing the lock');throw e}
  try{return await fn(dir)}finally{await rm(lock,{recursive:true,force:true})}
}
function checkVolumeMeta(v,name,owner,kind,{migrationId=null}={}) {
  insist(v && v.Name===name && v.Driver==='local' && isMap(v.Labels),'Unexpected or non-local Docker volume: '+name);
  insist(v.Labels['com.docker.compose.project']===owner && v.Labels['com.docker.compose.volume']===kind, 'Volume Compose labels do not match: '+name);
  if(migrationId!==null)insist(v.Labels['io.osmanx.migration-id']===migrationId,'Target volume is not owned by this migration: '+name);
}
export async function migrationPlan({legacyRoot,root,legacyProject,adapter=dockerVolumeAdapter()}) {
  insist(typeof legacyProject==='string'&&composeName.test(legacyProject),'Supply explicit --legacy-project=name (no guessing from folder)');
  const [old,next]=await Promise.all([verifiedKit(legacyRoot,1),verifiedKit(root,2)]);
  insist(old.app.projectId===next.app.projectId && old.app.format===next.app.format, 'Refusing cross-project/type volume migration');
  insist(old.dep.domain===next.dep.domain && old.app.applicationVersion===next.app.applicationVersion, 'Domain/engine mismatch: review required');
  insist(old.app.release?.sequence<=next.app.release?.sequence, 'New kit is older than the original release');
  insist(legacyProject!==next.dep.composeProject,'Legacy and target Compose names must differ');
  const state=join(next.root,stateDirName,'active.json');
  insist(!existsSync(state),'An interrupted migration exists: recover or investigate first');
  const volumes=[];const missing=[];
  for(const kind of volumeKinds){
    const source=legacyProject+'_'+kind,target=next.dep.composeProject+'_'+kind;
    const src=await adapter.inspect(source);
    if(!src){insist(kind!=='app_data','Missing legacy application data volume: '+source);missing.push(kind);continue}
    checkVolumeMeta(src,source,legacyProject,kind);
    insist(!await adapter.inUse(source), 'Stop legacy containers before migration: '+source);
    insist(!await adapter.inspect(target), 'Target volume already exists; refusing overwrite: '+target);
    volumes.push({kind,source,target});
  }
  insist(volumes.some(v=>v.kind==='app_data'),'Legacy data volume is required');
  if(typeof adapter.helperReady==='function')insist(await adapter.helperReady(), 'Docker helper image '+helperImage+' is not cached; pull explicitly before migration');
  return {old,next,volumes,missing,summary:{ok:true,projectId:old.app.projectId,domain:old.dep.domain,
    legacyProject,targetProject:next.dep.composeProject,
    volumes:volumes.map(v=>({kind:v.kind,source:v.source,target:v.target})),missingOptionalVolumes:missing,
    appDataMustBeOffline:true,sourceVolumesPreserved:true,targetMustNotExist:true,
    notice:'Migration is destructive only to new migration-owned target volumes during explicit recovery. Backup contains personal data. No site is started.'}};
}
async function assertBackupDir(path) {
  await safeDirectory(path); // also rejects symlinks in intermediate path components
  const s=await regular(path,'directory');
  insist(process.platform==='win32'||(s.mode&0o077)===0,'Backup directory must be mode 0700');
}
async function complete(root,dir,state,phase){
  state.phase=phase;state.finishedAt=new Date().toISOString();await atomic(join(dir,'active.json'),state);
  await mkdir(join(dir,'history'),{recursive:true,mode:0o700});
  await durableRename(join(dir,'active.json'),join(dir,'history',state.id+'.json'));
  return {ok:true,phase,id:state.id,projectId:state.projectId,volumes:state.volumes.map(x=>({kind:x.kind,source:x.source,target:x.target,sha256:x.backup?.sha256||null})),
    note:'Old Docker volumes remain untouched. Do NOT run docker compose down -v. Test the app and HTTPS before decommissioning the legacy stack.'};
}
function validatedJournal(state){
  insist(isMap(state) && state.format==='osmanx-volume-migration' && state.version===1 &&
    idRx.test(state.id) && projectId.test(state.projectId), 'Invalid migration journal');
  const expected='osmanx_'+state.projectId.replaceAll('-','').slice(0,12);
  insist(state.targetProject===expected && composeName.test(state.legacyProject) &&
    state.legacyProject!==expected && /^[a-z0-9.-]{3,253}$/.test(state.domain) &&
    ['crm.sqlite','site.sqlite'].includes(state.dbName), 'Invalid journal identity');
  insist(['backup','copying','recovery-required','completed','recovered'].includes(state.phase) &&
    Array.isArray(state.volumes) && state.volumes.length>=1 && state.volumes.length<=3,
    'Invalid journal phase or volume inventory');
  const found=new Set();
  for(const v of state.volumes){
    insist(isMap(v) && volumeKinds.includes(v.kind) && !found.has(v.kind), 'Unexpected or repeated volume kind in journal');
    found.add(v.kind);
    insist(v.source===state.legacyProject+'_'+v.kind && v.target===expected+'_'+v.kind &&
      typeof v.restored==='boolean', 'Journal volume names do not match the project');
    if(v.backup!==null){
      insist(isMap(v.backup) && /^[0-9a-f]{64}$/.test(v.backup.sha256) &&
        Number.isSafeInteger(v.backup.bytes) && v.backup.bytes>=0 &&
        Number.isSafeInteger(v.backup.files) && v.backup.files>=0, 'Invalid journal backup record');
    }
  }
  insist(found.has('app_data'), 'Missing application data in migration journal');
  return state;
}
async function checkedJournal(file){
  const st=await regular(file);
  insist(process.platform==='win32'||(st.mode&0o077)===0,'Migration journal must be mode 0600');
  return validatedJournal(JSON.parse(await readFile(file,'utf8')));
}
async function takeBackups(state,dir,adapter,{retry=false}={}){
  validatedJournal(state);
  const snapshots=join(dir,'snapshots');
  if(existsSync(snapshots))await assertBackupDir(snapshots);else await mkdir(snapshots,{mode:0o700});
  const bRoot=join(snapshots,state.id);
  if(existsSync(bRoot)){insist(retry,'Existing snapshot requires explicit recovery');await assertBackupDir(bRoot)}
  else await mkdir(bRoot,{mode:0o700});
  for(const v of state.volumes){
    insist(!await adapter.inUse(v.source),'Legacy app started during backup: '+v.source);
    const dbName=v.kind==='app_data'?state.dbName:null;
    const dest=join(bRoot,v.kind);
    if(v.backup){
      await assertBackupDir(dest);
      const copy=await adapter.fingerprint({directory:dest},{dbName});
      const original=await adapter.fingerprint(v.source,{dbName});
      insist(copy.sha256===v.backup.sha256 && original.sha256===v.backup.sha256 &&
        copy.bytes===v.backup.bytes && copy.files===v.backup.files,
        'Previously sealed snapshot or original volume changed: '+v.kind);
      continue;
    }
    insist(!retry || state.phase==='backup'||state.phase==='recovery-required',
      'Incomplete snapshots can only be resumed during recovery');
    if(existsSync(dest)){
      insist(retry,'Snapshot target unexpectedly exists: '+v.kind);
      await assertBackupDir(dest);
      // Keep partial data for investigation; never silently overwrite a failed copy.
      await durableRename(dest,join(bRoot,'incomplete-'+v.kind+'-'+randomBytes(5).toString('hex')));
    }
    await mkdir(dest,{mode:0o700});await assertBackupDir(dest);
    const first=await adapter.fingerprint(v.source,{dbName});
    const space=await statfs(dest);
    const free=BigInt(space.bavail)*BigInt(space.bsize);
    insist(free>=BigInt(first.bytes)+16n*1024n*1024n, 'Insufficient free backup space: '+v.kind);
    const result=await adapter.copy(v.source,{directory:dest},{dbName});
    const again=await adapter.fingerprint(v.source,{dbName});
    insist(first.sha256===again.sha256 && result.sha256===first.sha256 &&
      first.bytes===result.bytes && first.files===result.files,
      'Volume changed during backup, or backup checksum mismatch: '+v.source);
    v.backup={sha256:result.sha256,bytes:result.bytes,files:result.files};
    await atomic(join(dir,'active.json'),state);
  }
}
async function createAndRestore(state,dir,adapter,{allowRecreate=false}={}){
  for(const v of state.volumes){
    insist(v.backup && /^[0-9a-f]{64}$/.test(v.backup.sha256),'Missing trusted backup for '+v.kind);
    insist(!await adapter.inUse(v.source),'Legacy volume in use: '+v.source);
    const backup=join(dir,'snapshots',state.id,v.kind);await assertBackupDir(backup);
    const current=await adapter.fingerprint({directory:backup},{dbName:v.kind==='app_data'?state.dbName:null});
    insist(current.sha256===v.backup.sha256,'Backup modified: '+v.kind);
    const labels={'com.docker.compose.project':state.targetProject,
      'com.docker.compose.volume':v.kind,'io.osmanx.migration-id':state.id};
    const target=await adapter.inspect(v.target);
    if(target){
      insist(allowRecreate,'Target exists; recovery requires --recreate-targets');
      checkVolumeMeta(target,v.target,state.targetProject,v.kind,{migrationId:state.id});
      insist(!await adapter.anyContainer(v.target),'Container still references migrated volume: '+v.target);
      await adapter.remove(v.target);
    }
    await adapter.create(v.target,labels);
    const restored=await adapter.copy({directory:backup},v.target,{dbName:v.kind==='app_data'?state.dbName:null});
    insist(restored.sha256===v.backup.sha256,'Restored target differs from verified backup: '+v.kind);
    v.restored=true;await atomic(join(dir,'active.json'),state);
  }
}
export async function migrateVolumes({legacyRoot,root,legacyProject,confirm=false,offlineConfirmed=false,adapter=dockerVolumeAdapter()}){
  insist(confirm && offlineConfirmed,'Requires both --confirm and --offline-confirmed');
  root=await safeDirectory(root);
  return withLock(root,async dir=>{
    const p=await migrationPlan({legacyRoot,root,legacyProject,adapter});
    const state={format:'osmanx-volume-migration',version:1,id:sid(),projectId:p.old.app.projectId,
      targetProject:p.next.dep.composeProject,legacyProject,domain:p.old.dep.domain,
      dbName:p.old.config.type==='site'?'site.sqlite':'crm.sqlite',createdAt:new Date().toISOString(),
      phase:'backup',volumes:p.volumes.map(v=>({...v,backup:null,restored:false}))};
    await atomic(join(dir,'active.json'),state);
    try{
      await takeBackups(state,dir,adapter);
      state.phase='copying';await atomic(join(dir,'active.json'),state);
      await createAndRestore(state,dir,adapter);
      return await complete(root,dir,state,'completed');
    } catch(e){state.phase='recovery-required';state.lastError=String(e.message).slice(0,200);await atomic(join(dir,'active.json'),state);throw Error('Migration halted safely; original volumes retained: '+e.message+'; use status/recover after investigation')}
  });
}
export async function recoverVolumes({root,confirm=false,recreateTargets=false,retryBackups=false,adapter=dockerVolumeAdapter()}){
  insist(confirm && recreateTargets,'Recovery requires --confirm --recreate-targets');root=await safeDirectory(root);
  return withLock(root,async dir=>{
    const state=await checkedJournal(join(dir,'active.json'));
    const next=await verifiedKit(root,2);
    insist(next.app.projectId===state.projectId && next.dep.composeProject===state.targetProject && next.dep.domain===state.domain &&
      state.dbName===(next.config.type==='site'?'site.sqlite':'crm.sqlite'), 'Migration journal does not match this kit');
    insist(state.phase==='recovery-required'||state.phase==='copying'||state.phase==='backup','Not an interrupted migration');
    try{
      if(state.volumes.some(v=>v.backup===null)){
        insist(retryBackups,'Incomplete backup: run recover --confirm --recreate-targets --retry-backups after inspecting source volumes');
        await takeBackups(state,dir,adapter,{retry:true});
      }
      await createAndRestore(state,dir,adapter,{allowRecreate:true});
      return await complete(root,dir,state,'recovered');
    } catch(e){state.phase='recovery-required';state.lastError=String(e.message).slice(0,200);await atomic(join(dir,'active.json'),state);throw e}
  });
}
export async function migrationStatus({root}) {
  const dir=join(await safeDirectory(root),stateDirName);
  if(!existsSync(dir))return {active:null,history:[]};
  await assertBackupDir(dir);
  const active=existsSync(join(dir,'active.json'))?await checkedJournal(join(dir,'active.json')):null;
  const history=join(dir,'history');
  if(existsSync(history))await assertBackupDir(history);
  const names=existsSync(history)?(await readdir(history)).filter(f=>/^\d{14}-[0-9a-f]{12}\.json$/.test(f)).sort().reverse().slice(0,12):[];
  return {active:active&&{...active,volumes:active.volumes.map(v=>({...v,backup:v.backup&&{sha256:v.backup.sha256,bytes:v.backup.bytes,files:v.backup.files}}))},
    history:await Promise.all(names.map(async n=>checkedJournal(join(history,n))))};
}


/** Offline-only acceptance. Does not start Docker or claim public availability. */
export async function verifyMigratedVolumes({root,adapter=dockerVolumeAdapter()}){
  root=await safeDirectory(root);
  const dir=join(root,stateDirName);await assertBackupDir(dir);
  insist(!existsSync(join(dir,'active.json')),'Migration still active; resolve before verifying');
  const history=join(dir,'history');await assertBackupDir(history);
  const names=(await readdir(history)).filter(x=>idRx.test(x.slice(0,-5)) && x.endsWith('.json')).sort().reverse();
  insist(names.length>0,'No completed migration history');
  const state=await checkedJournal(join(history,names[0]));
  insist(['completed','recovered'].includes(state.phase),'Migration is not complete');
  const kit=await verifiedKit(root,2);
  insist(kit.app.projectId===state.projectId && kit.dep.domain===state.domain &&
    kit.dep.composeProject===state.targetProject &&
    state.dbName===(kit.config.type==='site'?'site.sqlite':'crm.sqlite'), 'Completed migration belongs to a different kit');
  const checked=[];
  for(const v of state.volumes){
    insist(v.restored && v.backup,'Volume not fully restored: '+v.kind);
    const [oldVolume,newVolume]=await Promise.all([adapter.inspect(v.source),adapter.inspect(v.target)]);
    checkVolumeMeta(oldVolume,v.source,state.legacyProject,v.kind);
    checkVolumeMeta(newVolume,v.target,state.targetProject,v.kind,{migrationId:state.id});
    insist(!await adapter.inUse(v.source) && !await adapter.inUse(v.target),
      'Offline verification requires both application stacks stopped: '+v.kind);
    const dbName=v.kind==='app_data'?state.dbName:null;
    const backup=join(dir,'snapshots',state.id,v.kind);await assertBackupDir(backup);
    const [a,b,c]=await Promise.all([
      adapter.fingerprint(v.source,{dbName}),
      adapter.fingerprint({directory:backup},{dbName}),
      adapter.fingerprint(v.target,{dbName})]);
    insist([a,b,c].every(x=>x.sha256===v.backup.sha256 &&
      x.bytes===v.backup.bytes && x.files===v.backup.files),
      'Post-migration data discrepancy: '+v.kind);
    checked.push({kind:v.kind,sha256:v.backup.sha256,bytes:v.backup.bytes,files:v.backup.files});
  }
  return {ok:true,id:state.id,projectId:state.projectId,domain:state.domain,
    offlineVolumesVerified:true,applicationStarted:false,publicHttpsVerified:false,
    volumes:checked,notice:'Offline hashes and SQLite verified. Start app manually and run HTTPS/business acceptance before any production cutover.'};
}
/* Zero-network, local-image-only container helper. No shell expansion, no user JS. */
export const volumeHelperSource=String.raw`
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const insist=(b,m)=>{if(!b)throw Error(m)};
const from=process.env.OSMANX_SOURCE_DIR||'/from',to=process.env.OSMANX_TARGET_DIR||'/to',operation=process.env.OSMANX_OPERATION,dbName=process.env.OSMANX_DB_NAME;
function scan(root){
 let size=0,count=0;const digest=crypto.createHash('sha256');
 function visit(dir,base=''){
  for(const name of fs.readdirSync(dir).sort()){
   const rel=base?base+'/'+name:name,full=path.join(dir,name),s=fs.lstatSync(full);
   insist(!s.isSymbolicLink() && (s.isDirectory()||s.isFile()),'Symlink or special file forbidden: '+rel);
   digest.update(rel+'\0'+(s.isFile()?'f':'d')+'\0'+s.uid+':'+s.gid+':'+(s.mode&0o777).toString(8)+'\0');
   if(s.isDirectory())visit(full,rel);
   else{size+=s.size;count++;insist(count<=100000&&size<=128*1024**3,'Volume size/count limit');
    const h=crypto.createHash('sha256'),fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const b=Buffer.alloc(1024*1024);let n;while((n=fs.readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n))}finally{fs.closeSync(fd)}
    digest.update(s.size+':'+h.digest('hex')+'\0');}
  }
 }
 visit(root);return {sha256:digest.digest('hex'),bytes:size,files:count};
}
function checkDb(root){
 if(!dbName)return;
 insist(['crm.sqlite','site.sqlite'].includes(dbName),'Invalid DB selection');
 const p=path.join(root,dbName);insist(fs.existsSync(p),'No SQLite database in legacy app_data volume');
 const db=new DatabaseSync(p,{readOnly:true});
 try{insist(db.prepare('PRAGMA integrity_check').get().integrity_check==='ok','SQLite integrity failed');
     insist(db.prepare('PRAGMA foreign_key_check').all().length===0,'SQLite FK check failed');}
 finally{db.close()}
}
function replicate(src,dst){
 insist(fs.readdirSync(dst).length===0,'Refusing non-empty copy destination');
 function walk(s,d){
  const original=fs.statSync(s);
  for(const name of fs.readdirSync(s)){
   const p=path.join(s,name),q=path.join(d,name),stat=fs.lstatSync(p);
   insist(!stat.isSymbolicLink()&&(stat.isFile()||stat.isDirectory()),'Invalid volume item: '+name);
   if(stat.isDirectory()){fs.mkdirSync(q,{mode:0o700});walk(p,q)}
   else fs.copyFileSync(p,q,fs.constants.COPYFILE_EXCL);
   fs.chownSync(q,stat.uid,stat.gid);fs.chmodSync(q,stat.mode&0o777);
   fs.utimesSync(q,stat.atime,stat.mtime);
   if(stat.isFile()){const fd=fs.openSync(q,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
  }
  const fd=fs.openSync(d,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 }
 const space=fs.statfsSync(dst);
 const enough=BigInt(space.bavail)*BigInt(space.bsize)>=BigInt(scan(src).bytes)+16n*1024n*1024n;
 insist(enough,'Insufficient destination space for offline volume copy');
 walk(src,dst);
}
const initial=scan(from);checkDb(from);
if(operation==='copy'){
 insist(fs.existsSync(to)&&fs.statSync(to).isDirectory(),'Copy destination absent');
 replicate(from,to);const result=scan(to);checkDb(to);
 insist(initial.sha256===result.sha256,'Volume contents differ after copy');
 console.log(JSON.stringify(result));
}else if(operation==='scan')console.log(JSON.stringify(initial));
else throw Error('Unsupported helper operation');
`;
function runDocker(args,timeout=30000){
  const r=spawnSync('docker',args,{encoding:'utf8',timeout,maxBuffer:512*1024,env:{...process.env,DOCKER_CLI_HINTS:'false'}});
  if(r.error)throw Error('Docker command unavailable: '+r.error.message);
  return r;
}
function requiredDocker(args,timeout){
  const r=runDocker(args,timeout);
  if(r.status!==0)throw Error('docker '+args.slice(0,3).join(' ')+' failed: '+String(r.stderr||r.stdout).slice(-500));
  return String(r.stdout||'').trim();
}
function helper(src,dst,operation,dbName){
  const args=['run','--rm','--pull','never','--network','none','--read-only','--security-opt','no-new-privileges:true','--cap-drop','ALL','--cap-add','CHOWN','--cap-add','FOWNER','--pids-limit','128'];
  const mount=(item,location,readonly)=>{
    if(typeof item==='string'){insist(volumeName.test(item),'Invalid Docker volume name');return 'type=volume,source='+item+',target='+location+(readonly?',readonly':'')}
    const dir=resolve(item.directory);
    insist(isAbsolute(dir)&&!/[\n\r,]/.test(dir),'Unsafe host backup directory');
    return 'type=bind,source='+dir+',target='+location+(readonly?',readonly':'');
  };
  args.push('--mount',mount(src,'/from',true));
  if(dst)args.push('--mount',mount(dst,'/to',false));
  args.push('-e','OSMANX_OPERATION='+operation,'-e','OSMANX_DB_NAME='+(dbName||''),helperImage,'node','--disable-warning=ExperimentalWarning','-e',volumeHelperSource);
  const output=requiredDocker(args,30*60*1000);
  const lines=output.split('\n');
  const result=JSON.parse(lines[lines.length-1]);
  insist(/^[a-f0-9]{64}$/.test(result.sha256) && Number.isSafeInteger(result.bytes) && Number.isSafeInteger(result.files),'Invalid helper output');
  return result;
}
export function dockerVolumeAdapter(){
  insist(process.platform==='linux','Offline volume migration requires a Linux Docker host');
  return {
    async inspect(name){
      const result=runDocker(['volume','inspect',name],20000);
      if(result.status!==0){
        if(/No such volume|not found|no such volume/i.test(String(result.stderr)))return null;
        throw Error('Docker volume inspect failed: '+String(result.stderr).slice(-400));
      }
      const data=JSON.parse(result.stdout);return Array.isArray(data)?data[0]:null;
    },
    async inUse(name){return requiredDocker(['ps','--filter','volume='+name,'--format','{{.ID}}'],15000).length>0},
    async anyContainer(name){return requiredDocker(['ps','-a','--filter','volume='+name,'--format','{{.ID}}'],15000).length>0},
    async helperReady(){return runDocker(['image','inspect',helperImage],15000).status===0},
    async fingerprint(source,{dbName=null}={}){return helper(source,null,'scan',dbName)},
    async copy(source,destination,{dbName=null}={}){return helper(source,destination,'copy',dbName)},
    async create(name,labels){
      const flags=Object.entries(labels).flatMap(([key,value])=>['--label',key+'='+value]);
      insist(requiredDocker(['volume','create',...flags,name],20000)===name,'Docker returned unexpected created volume');
    },
    async remove(name){requiredDocker(['volume','rm',name],20000)}
  };
}

const isMain=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
  const [command]=process.argv.slice(2);
  const arg=(key)=>process.argv.find(x=>x.startsWith(key+'='))?.slice(key.length+1);
  const root=arg('--installed')||dirname(dirname(fileURLToPath(import.meta.url)));
  const params={root,legacyRoot:arg('--legacy'),legacyProject:arg('--legacy-project')};
  process.umask(0o077);
  (async()=>{
    if(command==='plan')return (await migrationPlan(params)).summary;
    if(command==='migrate')return migrateVolumes({...params,confirm:process.argv.includes('--confirm'),offlineConfirmed:process.argv.includes('--offline-confirmed')});
    if(command==='recover')return recoverVolumes({root,confirm:process.argv.includes('--confirm'),recreateTargets:process.argv.includes('--recreate-targets'),retryBackups:process.argv.includes('--retry-backups')});
    if(command==='verify')return verifyMigratedVolumes({root});
    if(command==='status')return migrationStatus({root});
    throw Error('Usage: volume-migrate.mjs plan|migrate --legacy=/old/kit --legacy-project=old_name [--installed=/new/kit]; migrate requires --confirm --offline-confirmed; recover requires --confirm --recreate-targets [--retry-backups]; verify (offline after completion); status');
  })().then(result=>console.log(JSON.stringify(result,null,2))).catch(e=>{console.error('OSMANX VOLUMES: '+e.message);process.exitCode=1});
}
