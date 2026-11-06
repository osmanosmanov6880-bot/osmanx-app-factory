// R4.6: isolated encrypted-at-rest local vault with authenticated event catalog.
// No production write path, remote backups, delete-on-rotation or automatic cutover.
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,open,readdir,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {openR45Snapshot,sealR45Snapshot} from './r45-sealed-backup.mjs';

const FORMAT='osmanx-r46-vault-catalog-v1',ZERO='0'.repeat(64);
const ID=/^[0-9a-f]{32}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEYID=/^[a-z][a-z0-9_-]{2,31}$/,HEX=/^[0-9a-f]{64}$/;
const MAX_ARCHIVE=128*1024*1024+64,MAX_JOURNAL=8*1024*1024,MAX_ENTRIES=2000;
function guard(ok,msg){if(!ok)throw Error('R4.6 vault refused: '+msg);}
function sha(buf){return createHash('sha256').update(buf).digest('hex');}
function hmac(key,domain,val){return createHmac('sha256',key).update(domain+'\0').update(val).digest('hex');}
function safeEq(a,b){return typeof a==='string'&&typeof b==='string'&&HEX.test(a)&&HEX.test(b)&&
  timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function params({directory,projectId,manifestSha256,catalogKey,keyRing}={}){
  guard(typeof directory==='string'&&directory.length>0,'isolated vault directory required');
  guard(typeof projectId==='string'&&UUID.test(projectId),'project UUID required');
  guard(typeof manifestSha256==='string'&&HEX.test(manifestSha256),'signed manifest hash required');
  guard(Buffer.isBuffer(catalogKey)&&catalogKey.length===32,'independent catalog HMAC key required');
  guard(keyRing&&KEYID.test(keyRing.activeId)&&keyRing.keys&&typeof keyRing.keys==='object',
    'external key ring required');
  for(const [key,value] of Object.entries(keyRing.keys)){
    guard(KEYID.test(key)&&Buffer.isBuffer(value)&&value.length===32,'invalid external ring entry');
  }
  guard(Buffer.isBuffer(keyRing.keys[keyRing.activeId])&&keyRing.keys[keyRing.activeId].length===32,
    'active encryption key is missing');
  guard(![...Object.values(keyRing.keys)].some(value=>value.equals(catalogKey)),
    'catalog and backup keys must be independent');
  return {directory,projectId,manifestSha256,catalogKey,keyRing};
}
async function vaultDir(directory){
  const location=resolve(directory);
  await mkdir(location,{recursive:true,mode:0o700});
  const s=await lstat(location);
  guard(s.isDirectory()&&!s.isSymbolicLink(),'vault directory must be real');
  if(process.platform!=='win32')guard((s.mode&0o077)===0,'vault directory must be mode 0700');
  return location;
}
function checkRecord(r){
  guard(r&&ID.test(r.id)&&KEYID.test(r.keyId)&&HEX.test(r.manifestSha256)&&
    HEX.test(r.blobSha256)&&HEX.test(r.snapshotHmac)&&
    Number.isSafeInteger(r.bytes)&&r.bytes>=80&&r.bytes<=MAX_ARCHIVE,
    'malformed encrypted archive catalog entry');
  guard(typeof r.createdAt==='string'&&!Number.isNaN(Date.parse(r.createdAt)),
    'invalid archive timestamp');
  if(r.sourceId!==null)guard(ID.test(r.sourceId),'invalid source archive ID');
}
function loadRecords(text,info){
  guard(Buffer.byteLength(text,'utf8')<=MAX_JOURNAL,'catalog exceeds size ceiling');
  if(!text)return {events:[],active:new Map(),known:new Set(),retired:new Set(),previous:ZERO};
  guard(text.endsWith('\n'),'incomplete catalog event');
  const rows=text.slice(0,-1).split('\n');guard(rows.length<=MAX_ENTRIES,'catalog event limit reached');
  const events=[],active=new Map(),known=new Set(),retired=new Set();
  let previous=ZERO;
  for(let i=0;i<rows.length;i++){
    let event;try{event=JSON.parse(rows[i]);}catch{throw Error('R4.6 vault refused: invalid catalog JSON');}
    guard(event?.format===FORMAT&&event.sequence===i+1&&event.previous===previous&&
      event.projectId===info.projectId&&event.manifestSha256===info.manifestSha256,
      'catalog sequence or tenant binding changed');
    guard(['create','rotate','retire'].includes(event.op),'invalid catalog operation');
    if(event.op==='retire'){
      guard(ID.test(event.record?.id)&&Object.keys(event.record).length===1,'invalid tombstone record');
      guard(active.has(event.record.id),'tombstone references missing archive');
      active.delete(event.record.id);retired.add(event.record.id);
    } else {
      checkRecord(event.record);
      guard(!known.has(event.record.id),'duplicate archive identifier');
      guard(event.record.manifestSha256===info.manifestSha256,'archive manifest binding changed');
      if(event.op==='create')guard(event.record.sourceId===null,'create source must be null');
      else guard(event.record.sourceId&&active.has(event.record.sourceId),'rotation source is not active');
      known.add(event.record.id);
      active.set(event.record.id,{...event.record,sequence:event.sequence});
    }
    const canonical=JSON.stringify({format:FORMAT,sequence:event.sequence,previous,
      projectId:info.projectId,manifestSha256:info.manifestSha256,op:event.op,record:event.record});
    guard(event.sha256===sha(canonical),'catalog digest mismatch');
    const expected=hmac(info.catalogKey,'OSMANX-R46-CHAIN-v1',canonical);
    guard(safeEq(event.hmac,expected),'catalog authentication mismatch');
    previous=sha(JSON.stringify(event));events.push(event);
  }
  return {events,active,known,retired,previous};
}
async function readCatalog(root,info){
  const path=join(root,'catalog.jsonl');
  let handle;try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch(e){if(e.code==='ENOENT')return loadRecords('',info);throw e;}
  try{
    const s=await handle.stat();guard(s.isFile()&&s.nlink===1&&s.size<=MAX_JOURNAL,
      'unsafe catalog file');
    if(process.platform!=='win32')guard((s.mode&0o077)===0,'catalog file permissions must be 0600');
    return loadRecords(await handle.readFile({encoding:'utf8'}),info);
  }finally{await handle.close();}
}
async function inventory(root,state){
  const entries=await readdir(root,{withFileTypes:true});
  for(const entry of entries){
    guard(entry.isFile()||entry.name==='.vault.lock',
      'unexpected vault filesystem node');
    if(entry.name==='catalog.jsonl'||entry.name==='.vault.lock')continue;
    guard(ID.test(entry.name.slice(0,-4))&&entry.name.endsWith('.oxb')&&
      state.known.has(entry.name.slice(0,-4)),
      'orphan or unexpected encrypted archive (manual recovery required)');
  }
  for(const record of state.active.values()){
    const path=join(root,record.id+'.oxb');
    let st;try{st=await lstat(path);}catch{throw Error('R4.6 vault refused: indexed archive is missing');}
    guard(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size===record.bytes,
      'indexed encrypted archive is unsafe');
    if(process.platform!=='win32')guard((st.mode&0o077)===0,'archive file must be 0600');
  }
}
async function readArchive(root,record,info){
  let handle;
  try{handle=await open(join(root,record.id+'.oxb'),constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch{throw Error('R4.6 vault refused: archive is missing or unreadable');}
  try{
    const st=await handle.stat();
    guard(st.isFile()&&st.nlink===1&&st.size===record.bytes&&st.size<=MAX_ARCHIVE,
      'archive metadata or length changed');
    if(process.platform!=='win32')guard((st.mode&0o077)===0,'archive file not private');
    const buf=await handle.readFile();
    guard(safeEq(sha(buf),record.blobSha256),'encrypted archive SHA-256 mismatch');
    const key=info.keyRing.keys[record.keyId];
    guard(key,'archive key unavailable: restore previous key material');
    const plaintext=openR45Snapshot(buf,{secret:key,projectId:info.projectId,
      manifestSha256:info.manifestSha256});
    buf.fill(0);
    guard(safeEq(hmac(info.catalogKey,'OSMANX-R46-SNAPSHOT-v1',plaintext),record.snapshotHmac),
      'decrypted backup content does not match catalog');
    return plaintext;
  }finally{await handle.close();}
}
async function writeNew(root,id,blob){
  const file=join(root,id+'.oxb');let f;
  try{f=await open(file,'wx',0o600);await f.writeFile(blob);await f.sync();}
  finally{await f?.close();}
  return file;
}
async function appendEvent(root,state,info,op,record){
  guard(state.events.length<MAX_ENTRIES,'catalog full');
  const body={format:FORMAT,sequence:state.events.length+1,previous:state.previous,
    projectId:info.projectId,manifestSha256:info.manifestSha256,op,record};
  const canonical=JSON.stringify(body);
  const event={...body,sha256:sha(canonical),hmac:hmac(info.catalogKey,'OSMANX-R46-CHAIN-v1',canonical)};
  const line=JSON.stringify(event)+'\n';guard(Buffer.byteLength(line)<=1024*1024,'event is too large');
  let f;
  try{
    f=await open(join(root,'catalog.jsonl'),
      constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
    const s=await f.stat();guard(s.isFile()&&s.nlink===1,'unsafe catalog destination');
    if(process.platform!=='win32')guard((s.mode&0o077)===0,'unsafe catalog permissions');
    await f.writeFile(line);await f.sync();
  }finally{await f?.close();}
  return event;
}
async function locked(input,fn){
  const info=params(input),root=await vaultDir(info.directory),lockFile=join(root,'.vault.lock');
  const lock=await open(lockFile,'wx',0o600); // overlapping/stale writer => fail closed
  try{
    const state=await readCatalog(root,info);
    await inventory(root,state);
    return await fn({root,info,state});
  }finally{await lock.close();await unlink(lockFile);}
}
function publicRecord(record){return {id:record.id,keyId:record.keyId,createdAt:record.createdAt,
  bytes:record.bytes,sequence:record.sequence??null};}
export async function listR46Vault(input){
  return locked(input,async({state})=>({format:FORMAT,catalogVerified:true,
    archives:[...state.active.values()].sort((a,b)=>b.sequence-a.sequence).map(publicRecord),
    activeCount:state.active.size,retiredCount:state.retired.size,
    catalogHeadSha256:state.previous,productionCutoverAllowed:false}));
}
export async function createR46VaultBackup(input,{plaintext}={}){
  return locked(input,async({root,info,state})=>{
    guard(Buffer.isBuffer(plaintext)&&plaintext.length>=4096&&plaintext.length<=128*1024*1024,
      'bounded signed SQLite snapshot required');
    const id=randomBytes(16).toString('hex');
    const {envelope,envelopeSha256}=sealR45Snapshot(plaintext,{
      secret:info.keyRing.keys[info.keyRing.activeId],
      projectId:info.projectId,manifestSha256:info.manifestSha256});
    const record={id,keyId:info.keyRing.activeId,manifestSha256:info.manifestSha256,
      blobSha256:envelopeSha256,snapshotHmac:hmac(info.catalogKey,'OSMANX-R46-SNAPSHOT-v1',plaintext),
      bytes:envelope.length,createdAt:new Date().toISOString(),sourceId:null};
    let stored=false,committed=false;
    try{
      await writeNew(root,id,envelope);stored=true;envelope.fill(0);
      const opened=await readArchive(root,record,info);
      try{guard(opened.equals(plaintext),'new encrypted backup did not roundtrip');}
      finally{opened.fill(0);}
      const event=await appendEvent(root,state,info,'create',record);committed=true;
      return {format:FORMAT,record:publicRecord({...record,sequence:event.sequence}),
        catalogHeadSha256:sha(JSON.stringify(event)),encryptedAndVerified:true,
        sourcePrimaryModified:false,productionCutoverAllowed:false};
    }finally{
      if(stored&&!committed)await unlink(join(root,id+'.oxb'));
      envelope.fill(0);
    }
  });
}
export async function readR46VaultBackup(input,{id}={}){
  return locked(input,async({root,info,state})=>{
    guard(typeof id==='string'&&ID.test(id),'invalid archive ID');
    const record=state.active.get(id);guard(record,'archive not active or no longer retained');
    const plaintext=await readArchive(root,record,info);
    return {plaintext,record:publicRecord(record),catalogVerified:true};
  });
}
export async function rotateR46VaultBackup(input,{id}={}){
  return locked(input,async({root,info,state})=>{
    guard(typeof id==='string'&&ID.test(id),'invalid rotation archive ID');
    const previous=state.active.get(id);guard(previous,'old archive not active');
    guard(previous.keyId!==info.keyRing.activeId,'rotation requires a different active key');
    const plaintext=await readArchive(root,previous,info);
    const nextId=randomBytes(16).toString('hex');
    let committed=false,stored=false,envelope;
    try{
      const sealed=sealR45Snapshot(plaintext,{secret:info.keyRing.keys[info.keyRing.activeId],
        projectId:info.projectId,manifestSha256:info.manifestSha256});
      envelope=sealed.envelope;
      const record={id:nextId,keyId:info.keyRing.activeId,manifestSha256:info.manifestSha256,
        blobSha256:sealed.envelopeSha256,
        snapshotHmac:hmac(info.catalogKey,'OSMANX-R46-SNAPSHOT-v1',plaintext),
        bytes:envelope.length,createdAt:new Date().toISOString(),sourceId:id};
      await writeNew(root,nextId,envelope);stored=true;
      const checked=await readArchive(root,record,info);
      try{guard(checked.equals(plaintext),'rotated backup cannot be restored');}
      finally{checked.fill(0);}
      const event=await appendEvent(root,state,info,'rotate',record);committed=true;
      return {originalRetained:true,rotationVerified:true,archive:publicRecord({...record,sequence:event.sequence}),
        catalogHeadSha256:sha(JSON.stringify(event)),productionCutoverAllowed:false};
    }finally{
      plaintext.fill(0);envelope?.fill(0);
      if(stored&&!committed)await unlink(join(root,nextId+'.oxb'));
    }
  });
}
// Destructive retention is isolated and refuses to discard a backup before
// EVERY active archive is independently decryptable. Tombstone BEFORE unlink.
export async function pruneR46Vault(input,{keep=3}={}){
  return locked(input,async({root,info,state})=>{
    guard(Number.isSafeInteger(keep)&&keep>=2&&keep<=20,'retain at least two verified backups');
    const records=[...state.active.values()].sort((a,b)=>b.sequence-a.sequence);
    for(const record of records){
      const bytes=await readArchive(root,record,info);
      bytes.fill(0);
    }
    const removed=[];
    for(const record of records.slice(keep)){
      const event=await appendEvent(root,state,info,'retire',{id:record.id});
      state.events.push(event);state.previous=sha(JSON.stringify(event));
      await unlink(join(root,record.id+'.oxb'));
      removed.push({id:record.id,keyId:record.keyId});
    }
    return {retained:Math.min(keep,records.length),removed,allActiveVerifiedBeforeRetirement:true,
      productionCutoverAllowed:false};
  });
}


// R4.7 read-only catalog parser: shared by the local vault and independent
// remote restore. Never trusts the remote manifest without this HMAC check.
export function verifyR46CatalogBytes(bytes,input){
  const info=params(input);
  guard(Buffer.isBuffer(bytes)&&bytes.length<=MAX_JOURNAL,'bounded catalog bytes required');
  const state=loadRecords(bytes.toString('utf8'),info);
  return {
    format:FORMAT,entries:state.events.length,
    catalogHeadSha256:state.previous,
    active:[...state.active.values()].sort((a,b)=>a.sequence-b.sequence),
    retiredCount:state.retired.size,
    authenticated:true
  };
}
