// R5.3 synthetic encrypted incremental SQLite CDC -> S3 COMPLIANCE WORM.
// Each segment contains ONLY newly committed rows since the last witness
// cursor. The mutable S3 head is protected against rollback by an independent
// monotonic R4.8 witness with its own tenant/secret. NEVER production cutover.
import {createHash,createHmac,createCipheriv,createDecipheriv,randomBytes,timingSafeEqual} from 'node:crypto';
import {readR53Committed} from './r53-commit-journal.mjs';
import {r47TenantToken} from './r47-offsite.mjs';
const HEX=/^[a-f0-9]{64}$/,ID=/^[a-f0-9]{32}$/,ZERO='0'.repeat(64);
const FORMAT='osmanx-r53-delta-head-v1';
const SEG='osmanx-r53-encrypted-segment-v1';
const HEAD_KEY='r53/head.json',MAX_SEG=2*1024*1024;
function deny(ok,why){if(!ok)throw Error('R5.3 incremental refused: '+why);}
function sha(bytes){return createHash('sha256').update(bytes).digest('hex');}
function hmac(key,body){return createHmac('sha256',key)
  .update('OSMANX-R53-STREAM-HEAD-v1\0').update(body).digest('hex');}
function equal(a,b){return HEX.test(a||'')&&HEX.test(b||'')&&
  timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function config({vault,remote,witness,deltaKey,baselineArchiveId}={}){
  deny(vault?.projectId&&HEX.test(vault.manifestSha256||'')&&
    Buffer.isBuffer(vault.catalogKey)&&vault.catalogKey.length===32&&
    Buffer.isBuffer(deltaKey)&&deltaKey.length===32&&
    !deltaKey.equals(vault.catalogKey)&&ID.test(baselineArchiveId||'')&&
    remote&&typeof remote.get==='function'&&typeof remote.put==='function'&&
    typeof remote.inspectR49Worm==='function'&&typeof remote.assertBucketControls==='function'&&
    witness&&typeof witness.verify==='function'&&typeof witness.commit==='function'&&
    typeof witness.current==='function',
    'separate delta key, sealed backup archive and offsite witness required');
  return {vault,remote,witness,deltaKey,baselineArchiveId,
    tenantToken:r47TenantToken(vault.catalogKey,vault.projectId)};
}
function headFields(info,extra){
  return {format:FORMAT,tenantToken:info.tenantToken,
    manifestSha256:info.vault.manifestSha256,
    baselineArchiveId:info.baselineArchiveId,
    ...extra};
}
function encodeHead(info,fields){
  const body=headFields(info,fields);
  return Buffer.from(JSON.stringify({...body,mac:hmac(info.deltaKey,JSON.stringify(body))}));
}
function decodeHead(info,bytes){
  deny(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=4096,
    'remote incremental head exceeds size bound');
  let value;try{value=JSON.parse(bytes.toString('utf8'));}
  catch{throw Error('R5.3 incremental refused: invalid signed head JSON');}
  const {mac:signature,...fields}=value||{};
  const expected=headFields(info,{
    schemaDigest:fields.schemaDigest,segments:fields.segments,
    lastSequence:fields.lastSequence,lastSegmentSha256:fields.lastSegmentSha256
  });
  deny(fields.format===expected.format&&
    fields.tenantToken===expected.tenantToken&&
    fields.manifestSha256===expected.manifestSha256&&
    fields.baselineArchiveId===expected.baselineArchiveId&&
    HEX.test(fields.schemaDigest||'')&&HEX.test(fields.lastSegmentSha256||'')&&
    Number.isSafeInteger(fields.segments)&&fields.segments>=1&&fields.segments<=128&&
    Number.isSafeInteger(fields.lastSequence)&&fields.lastSequence>=fields.segments&&
    fields.lastSequence<=30000&&
    Object.keys(fields).length===Object.keys(expected).length&&
    equal(signature,hmac(info.deltaKey,JSON.stringify(expected))),
    'remote head changed, wrong baseline or invalid HMAC');
  return fields;
}
async function remoteHead(info){
  let bytes;
  try{bytes=await info.remote.get(HEAD_KEY);}
  catch(e){
    if(String(e.message)==='R4.8 S3 denied: GET status 404')return null;
    throw e;
  }
  const value=decodeHead(info,bytes);
  return {bytes,value,sha256:sha(bytes)};
}
async function checkHead(info){
  const head=await remoteHead(info),anchor=await info.witness.current();
  if(!head){
    deny(!anchor,'signed incremental head missing while witness exists');
    return null;
  }
  deny(anchor,'incremental head exists without independent witness');
  await info.witness.verify({
    catalogSha256:head.sha256,manifestSha256:info.vault.manifestSha256,
    entries:head.value.lastSequence});
  const locked=await info.remote.inspectR49Worm(HEAD_KEY);
  deny(locked.objectLockVerified&&locked.retentionMode==='COMPLIANCE'&&locked.versionId,
    'signed incremental head object version not WORM protected');
  return head;
}
function authHeader(info,fields){
  return {format:SEG,tenantToken:info.tenantToken,
    manifestSha256:info.vault.manifestSha256,
    baselineArchiveId:info.baselineArchiveId,...fields};
}
function encrypt(info,events,fields){
  const iv=randomBytes(12);
  const header=authHeader(info,{...fields,iv:iv.toString('hex')});
  const plaintext=Buffer.from(JSON.stringify(events),'utf8');
  deny(plaintext.length>0&&plaintext.length<=1024*1024,
    'encrypted journal payload outside safe limits');
  const cipher=createCipheriv('aes-256-gcm',info.deltaKey,iv);
  cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const value={...header,tag:cipher.getAuthTag().toString('hex'),
    ciphertext:encrypted.toString('base64')};
  plaintext.fill(0);encrypted.fill(0);
  const bytes=Buffer.from(JSON.stringify(value));
  deny(bytes.length<MAX_SEG,'encrypted segment exceeds size limit');
  return {bytes,digest:sha(bytes)};
}
function decrypt(info,bytes,segmentSha){
  deny(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=MAX_SEG&&
    sha(bytes)===segmentSha,'encrypted segment digest mismatch');
  let value;try{value=JSON.parse(bytes.toString('utf8'));}
  catch{throw Error('R5.3 incremental refused: invalid segment JSON');}
  const {tag,ciphertext,...head}=value||{};
  deny(head.format===SEG&&head.tenantToken===info.tenantToken&&
    head.manifestSha256===info.vault.manifestSha256&&
    head.baselineArchiveId===info.baselineArchiveId&&
    HEX.test(head.schemaDigest||'')&&HEX.test(head.previousSha256||'')&&
    Number.isSafeInteger(head.fromSequence)&&head.fromSequence>=1&&
    Number.isSafeInteger(head.throughSequence)&&head.throughSequence>=head.fromSequence&&
    head.throughSequence-head.fromSequence<250&&
    typeof head.iv==='string'&&/^[a-f0-9]{24}$/.test(head.iv)&&
    typeof tag==='string'&&/^[a-f0-9]{32}$/.test(tag)&&
    typeof ciphertext==='string'&&ciphertext.length<=MAX_SEG*2,
    'segment identity, sequence or crypto format invalid');
  const decipher=createDecipheriv('aes-256-gcm',info.deltaKey,Buffer.from(head.iv,'hex'));
  decipher.setAAD(Buffer.from(JSON.stringify(head)));
  decipher.setAuthTag(Buffer.from(tag,'hex'));
  let plaintext;
  try{plaintext=Buffer.concat([
    decipher.update(Buffer.from(ciphertext,'base64')),decipher.final()
  ]);}catch{throw Error('R5.3 incremental refused: AES-GCM authenticated journal invalid');}
  let events;try{events=JSON.parse(plaintext.toString('utf8'));}
  catch{throw Error('R5.3 incremental refused: decrypted event format invalid');}
  finally{plaintext.fill(0);}
  deny(Array.isArray(events)&&
    events.length===head.throughSequence-head.fromSequence+1&&
    events.every((e,i)=>e?.seq===head.fromSequence+i&&
      typeof e.table==='string'&&['upsert','delete'].includes(e.operation)&&
      typeof e.recordKey==='string'&&e.recordKey.length<=256),
    'noncontiguous or corrupt committed events');
  return {...head,events};
}
export function r53WitnessTenant(catalogKey,projectId){
  deny(Buffer.isBuffer(catalogKey)&&catalogKey.length===32&&
    typeof projectId==='string','invalid source tenant');
  return createHmac('sha256',catalogKey).update('OSMANX-R53-DELTA-WITNESS-v1\0')
    .update(projectId).digest('hex').slice(0,24);
}
export async function publishR53Incremental({sourceDb,...arg}={}){
  const info=config(arg);
  deny(sourceDb&&typeof sourceDb.prepare==='function','synthetic SQLite source required');
  const bucket=await info.remote.assertBucketControls();
  deny(bucket.objectLockEnabled&&bucket.versioningEnabled,
    'real versioned WORM bucket required');
  const prior=await checkHead(info);
  const cursor=prior?.value.lastSequence||0;
  const captured=readR53Committed(sourceDb,{
    afterSequence:cursor,limit:250,syntheticOnly:true});
  deny(!prior||prior.value.schemaDigest===captured.schemaDigest,
    'signed baseline schema changed during incremental stream');
  if(captured.events.length===0)
    return {format:FORMAT,syntheticOnly:true,publishedEvents:0,
      totalCommittedEvents:cursor,witnessVerified:!!prior,
      pendingUnreplicatedEvents:false,productionCutoverAllowed:false};
  deny(captured.from===cursor+1&&captured.through===cursor+captured.events.length,
    'missing journal sequence before encrypted upload');
  const fields={
    schemaDigest:captured.schemaDigest,fromSequence:captured.from,
    throughSequence:captured.through,
    previousSha256:prior?.value.lastSegmentSha256||ZERO
  };
  const sealed=encrypt(info,captured.events,fields);
  const segmentKey='r53/segments/'+sealed.digest+'.oxd';
  await info.remote.put(segmentKey,sealed.bytes);
  const returned=await info.remote.get(segmentKey);
  deny(returned.equals(sealed.bytes),'offsite ciphertext differs after upload');
  returned.fill(0);
  const lock=await info.remote.inspectR49Worm(segmentKey);
  deny(lock.objectLockVerified&&lock.retentionMode==='COMPLIANCE'&&lock.versionId,
    'incremental segment is not protected by immutable S3 version');
  const pointer=encodeHead(info,{schemaDigest:captured.schemaDigest,
    segments:(prior?.value.segments||0)+1,lastSequence:captured.through,
    lastSegmentSha256:sealed.digest});
  await info.remote.put(HEAD_KEY,pointer);
  const posted=await remoteHead(info);
  deny(posted?.bytes.equals(pointer),'incremental pointer changed after publication');
  const headLock=await info.remote.inspectR49Worm(HEAD_KEY);
  deny(headLock.objectLockVerified&&headLock.versionId,
    'incremental head object version lacks S3 COMPLIANCE proof');
  await info.witness.commit({catalogSha256:posted.sha256,
    manifestSha256:info.vault.manifestSha256,entries:captured.through});
  await info.witness.verify({catalogSha256:posted.sha256,
    manifestSha256:info.vault.manifestSha256,entries:captured.through});
  const latest=readR53Committed(sourceDb,{
    afterSequence:captured.through,limit:250,syntheticOnly:true});
  return {format:FORMAT,syntheticOnly:true,
    publishedEvents:captured.events.length,totalCommittedEvents:captured.through,
    encryptedReadbackVerified:true,
    everyUploadedVersionWormProtected:true,witnessVerified:true,
    pendingUnreplicatedEvents:latest.events.length>0,
    signedHeadSha256:posted.sha256,schemaDigest:captured.schemaDigest,
    baselineArchiveId:info.baselineArchiveId,
    committedBeforeJournalInstallationMayBeMissing:true,
    productionCutoverAllowed:false};
}
export async function readR53AuthenticatedStream(arg){
  const info=config(arg);
  const latest=await checkHead(info);
  deny(latest,'no independently witnessed incremental checkpoint');
  let digest=latest.value.lastSegmentSha256,expected=latest.value.lastSequence;
  const chunks=[],seen=new Set();
  for(let i=0;i<latest.value.segments;i++){
    deny(HEX.test(digest)&&digest!==ZERO&&!seen.has(digest),
      'segment chain cycles or ended before authenticated head');
    seen.add(digest);
    const key='r53/segments/'+digest+'.oxd';
    const locked=await info.remote.inspectR49Worm(key);
    deny(locked.objectLockVerified&&locked.versionId,
      'historical segment version not locked under COMPLIANCE');
    const bytes=await info.remote.get(key);
    const chunk=decrypt(info,bytes,digest);
    deny(chunk.throughSequence===expected&&
      chunk.schemaDigest===latest.value.schemaDigest,
      'replayed segment chain is not contiguous or its schema changed');
    expected=chunk.fromSequence-1;
    chunks.push(chunk);
    digest=chunk.previousSha256;
    bytes.fill(0);
  }
  deny(expected===0&&digest===ZERO,
    'encrypted segment chain missing a committed transaction');
  const events=chunks.reverse().flatMap(x=>x.events);
  deny(events.length===latest.value.lastSequence,
    'decrypted transaction stream has sequence gaps');
  return {format:'osmanx-r53-authenticated-stream-v1',
    events,throughSequence:latest.value.lastSequence,
    schemaDigest:latest.value.schemaDigest,
    baselineArchiveId:latest.value.baselineArchiveId,
    signedHeadSha256:latest.sha256,authenticated:true,
    allVersionsWormVerified:true,independentWitnessVerified:true,
    productionCutoverAllowed:false};
}
