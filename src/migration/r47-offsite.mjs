// R4.7: encrypted local vault -> offsite object copies -> authenticated
// disaster recovery without relying on the original disk.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {open,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {listR46Vault,readR46VaultBackup,verifyR46CatalogBytes} from './r46-vault.mjs';
import {openR45Snapshot} from './r45-sealed-backup.mjs';
import {verifyR45SignedSnapshot} from './r45-restore-drill.mjs';
import {verifyTrustedMigration} from './pg-trust.mjs';

const HEX=/^[0-9a-f]{64}$/,ID=/^[a-f0-9]{32}$/;
const HEAD='osmanx-r47-offsite-head-v1',MAX=128*1024*1024+128;
function guard(ok,msg){if(!ok)throw Error('R4.7 offsite refused: '+msg);}
function sha(x){return createHash('sha256').update(x).digest('hex');}
function sign(key,s){return createHmac('sha256',key).update('OSMANX-R47-REMOTE-HEAD-v1\0').update(s).digest('hex');}
function safeEq(a,b){return typeof a==='string'&&typeof b==='string'&&HEX.test(a)&&HEX.test(b)&&
  timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
export function r47TenantToken(catalogKey,projectId){
  guard(Buffer.isBuffer(catalogKey)&&catalogKey.length===32&&
    /^[a-f0-9-]{36}$/.test(projectId),'invalid opaque tenant identity');
  return createHmac('sha256',catalogKey).update('OSMANX-R47-OBJECTS-v1\0').update(projectId)
    .digest('hex').slice(0,24);
}
function config({vault,remote}={}){
  guard(vault?.directory&&vault?.projectId&&HEX.test(vault?.manifestSha256||'')&&
    Buffer.isBuffer(vault.catalogKey)&&vault.catalogKey.length===32,'signed local vault configuration required');
  guard(remote&&typeof remote.put==='function'&&typeof remote.get==='function',
    'fixed authenticated remote object transport required');
  return {vault,remote};
}
async function privateRead(file,limit=MAX){
  const f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const st=await f.stat();
    guard(st.isFile()&&st.nlink===1&&st.size>0&&st.size<=limit,'local encrypted file unsafe');
    if(process.platform!=='win32')guard((st.mode&0o077)===0,'local file not private');
    return f.readFile();
  }finally{await f.close();}
}
async function signedLocalCatalog(vault){
  await listR46Vault(vault); // enforces protected catalog and filesystem inventory
  const bytes=await privateRead(join(vault.directory,'catalog.jsonl'),8*1024*1024);
  const verified=verifyR46CatalogBytes(bytes,vault);
  guard(verified.entries>0&&verified.active.length>=1,'no signed retained archives');
  return {bytes,verified};
}
function headFields(vault,catalogSha,now){
  return {format:HEAD,projectToken:r47TenantToken(vault.catalogKey,vault.projectId),
    manifestSha256:vault.manifestSha256,catalogSha256:catalogSha,committedAt:now};
}
function encodeHead(vault,catalogSha,now){
  const fields=headFields(vault,catalogSha,now);
  return Buffer.from(JSON.stringify({...fields,hmac:sign(vault.catalogKey,JSON.stringify(fields))}));
}
function decodeHead(blob,vault){
  guard(Buffer.isBuffer(blob)&&blob.length<=4096,'remote pointer size invalid');
  let raw;try{raw=JSON.parse(blob.toString('utf8'));}catch{throw Error('R4.7 offsite refused: invalid pointer JSON');}
  guard(raw?.format===HEAD&&raw.projectToken===r47TenantToken(vault.catalogKey,vault.projectId)&&
    raw.manifestSha256===vault.manifestSha256&&HEX.test(raw.catalogSha256)&&
    typeof raw.committedAt==='string'&&!Number.isNaN(Date.parse(raw.committedAt)),
    'remote pointer tenant or manifest mismatch');
  const canonical=JSON.stringify(headFields(vault,raw.catalogSha256,raw.committedAt));
  guard(safeEq(raw.hmac,sign(vault.catalogKey,canonical)),
    'remote pointer HMAC invalid');
  return raw;
}
async function readRemoteCatalog(vault,remote){
  const pointer=decodeHead(await remote.get('head.json'),vault);
  const blob=await remote.get('catalog/'+pointer.catalogSha256+'.jsonl');
  guard(Buffer.isBuffer(blob)&&blob.length<=8*1024*1024&&sha(blob)===pointer.catalogSha256,
    'remote catalog digest mismatch');
  const parsed=verifyR46CatalogBytes(blob,vault);
  guard(parsed.active.length>0&&parsed.authenticated,'remote signed catalog empty');
  return {pointer,parsed,blob};
}
function verifyEncrypted(blob,record,vault){
  guard(Buffer.isBuffer(blob)&&blob.length===record.bytes&&blob.length<=MAX&&
    safeEq(sha(blob),record.blobSha256),'remote encrypted blob digest mismatch');
  const secret=vault.keyRing.keys[record.keyId];
  guard(Buffer.isBuffer(secret)&&secret.length===32,'old restore encryption key unavailable');
  const plain=openR45Snapshot(blob,{secret,projectId:vault.projectId,
    manifestSha256:vault.manifestSha256});
  try{
    const expected=createHmac('sha256',vault.catalogKey)
      .update('OSMANX-R46-SNAPSHOT-v1\0').update(plain).digest('hex');
    guard(safeEq(expected,record.snapshotHmac),'remote decrypted content HMAC invalid');
    return Buffer.from(plain);
  }finally{plain.fill(0);}
}
export async function synchronizeR47Offsite(input){
  const {vault,remote}=config(input);
  const {bytes,verified}=await signedLocalCatalog(vault);
  const startHash=sha(bytes),ids=[];
  try{
    for(const record of verified.active){
      // Authenticate the locally retained archive with R4.6 first.
      const decrypted=await readR46VaultBackup(vault,{id:record.id});
      decrypted.plaintext.fill(0);
      const blob=await privateRead(join(vault.directory,record.id+'.oxb'));
      guard(safeEq(sha(blob),record.blobSha256),'local encrypted blob changed');
      try{
        const key='archives/'+record.id+'.oxb';
        await remote.put(key,blob);
        const remoteCopy=await remote.get(key);
        try{guard(remoteCopy.equals(blob),'remote encrypted archive differs after upload');}
        finally{remoteCopy.fill(0);}
        ids.push(record.id);
      }finally{blob.fill(0);}
    }
    const key='catalog/'+startHash+'.jsonl';
    await remote.put(key,bytes);
    const verifiedCopy=await remote.get(key);
    guard(verifiedCopy.equals(bytes),'remote catalog differs after upload');
    verifiedCopy.fill(0);
    const fresh=await signedLocalCatalog(vault);
    guard(sha(fresh.bytes)===startHash,'local catalog changed during offsite copy');
    const pointer=encodeHead(vault,startHash,new Date().toISOString());
    await remote.put('head.json',pointer);
    const remoteHead=decodeHead(await remote.get('head.json'),vault);
    guard(remoteHead.catalogSha256===startHash,'remote head did not acknowledge signed catalog');
    return {format:'osmanx-r47-offsite-sync-v1',syntheticOnly:true,
      uploadedArchives:ids.length,remoteCatalogSha256:startHash,
      manifestSha256:vault.manifestSha256,encryptedOnly:true,remoteReadbackVerified:true,
      sourcePrimaryModified:false,productionCutoverAllowed:false};
  }finally{bytes.fill(0);}
}
export async function recoverR47Offsite(input,{id}={}){
  const {vault,remote}=config(input);
  const {pointer,parsed}=await readRemoteCatalog(vault,remote);
  const record=id?parsed.active.find(r=>r.id===id):parsed.active.at(-1);
  guard(record&&ID.test(record.id),'signed remote archive missing or retired');
  const blob=await remote.get('archives/'+record.id+'.oxb');
  try{
    const plaintext=verifyEncrypted(blob,record,vault);
    return {plaintext,archiveId:record.id,remoteCatalogSha256:pointer.catalogSha256,
      catalogVerified:true,remoteArchiveVerified:true};
  }finally{blob.fill(0);}
}
export async function verifyR47OffsiteDrill({
  vault,remote,bundleDir,trustedPublicKey,actorId,id
}={}){
  guard(typeof actorId==='string'&&actorId.length>0,'authorized owner required');
  const {manifest,manifestSha256}=await verifyTrustedMigration(bundleDir,trustedPublicKey);
  guard(manifestSha256===vault?.manifestSha256,'trusted manifest does not match remote vault');
  const entry=manifest.databases.find(d=>d.projectId===vault.projectId);
  guard(entry?.role==='crm','signed CRM tenant missing');
  const output=await recoverR47Offsite({vault,remote},{id});
  const directory=await mkdtemp(join(tmpdir(),'ox-r47-remote-restore-'));
  let file;
  try{
    const destination=join(directory,'restored.sqlite');
    file=await open(destination,'wx',0o600);
    await file.writeFile(output.plaintext);await file.sync();await file.close();file=null;
    const db=new DatabaseSync(destination,{readOnly:true});
    let verified;
    try{verified=verifyR45SignedSnapshot(db,entry,{secret:vault.catalogKey});}
    finally{db.close();}
    return {format:'osmanx-r47-independent-recovery-v1',syntheticOnly:true,
      archiveId:output.archiveId,catalogVerified:true,remoteArchiveVerified:true,
      restoredIntegrityVerified:true,signedTablesVerified:verified.signedTablesVerified,
      financialRecords:verified.semantic.financial.records,
      financialTotalsHmac:verified.semantic.financial.financialTotalsHmac,
      remoteCatalogSha256:output.remoteCatalogSha256,sourcePrimaryModified:false,
      productionCutoverAllowed:false};
  }finally{
    output.plaintext.fill(0);await file?.close();
    await rm(directory,{recursive:true,force:true});
  }
}
export async function inspectR47OffsiteStatus(input){
  const {vault,remote}=config(input);
  const local=await signedLocalCatalog(vault);
  try{
    const {pointer,parsed}=await readRemoteCatalog(vault,remote);
    const current=pointer.catalogSha256===sha(local.bytes);
    // A catalog alone is not a restore. Require a full encrypted-object
    // readback and authenticated decryption of the newest signed archive
    // before reporting the offsite storage as healthy.
    const latest=parsed.active.at(-1);
    guard(latest,'no signed remote archive to verify');
    const ciphertext=await remote.get('archives/'+latest.id+'.oxb');
    try{
      const plaintext=verifyEncrypted(ciphertext,latest,vault);
      plaintext.fill(0);
    }finally{ciphertext.fill(0);}
    return {format:'osmanx-r47-offsite-status-v1',remoteReachable:true,
      remoteSignedCatalogValid:true,remoteMatchesLocal:current,
      newestArchiveVerified:true,
      remoteArchives:parsed.active.length,localArchives:local.verified.active.length,
      remoteCatalogSha256:pointer.catalogSha256,healthy:current,
      productionCutoverAllowed:false};
  }finally{local.bytes.fill(0);}
}


// R4.8 independent witness reads fully authenticated R4.7 remote head/catalog.
// This does not trust a bare remote pointer or any caller-provided checksum.
export async function readR47SignedRemoteHead({vault,remote}={}){
  const {pointer,parsed}=await readRemoteCatalog(vault,remote);
  guard(parsed.entries>=1,'remote witness requires signed catalog entries');
  return {catalogSha256:pointer.catalogSha256,manifestSha256:vault.manifestSha256,
    entries:parsed.entries,committedAt:pointer.committedAt,
    verified:true};
}
