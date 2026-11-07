// R5.4 private chained checkpoint receipts. A LOCAL HMAC file is NOT an
// independent witness and cannot establish a real production RPO.
// No CRM rows, payment amounts, raw IDs, credential paths or private keys.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,open,readFile,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const TOKEN=/^[a-f0-9]{24}$/,HEX=/^[a-f0-9]{64}$/,ZERO='0'.repeat(64);
const FORMAT='osmanx-r54-checkpoint-evidence-v1',MAX_BYTES=1024*1024,MAX_RECORDS=2000;
function deny(ok,msg){if(!ok)throw Error('R5.4 signed checkpoint evidence refused: '+msg);}
function hmac(key,body){return createHmac('sha256',key).update('OSMANX-R54-CHECKPOINT-v1\0')
  .update(body).digest('hex');}
function sha(body){return createHash('sha256').update(body).digest('hex');}
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&
  HEX.test(a)&&HEX.test(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function cfg({directory,tenantToken,key}={}){
  deny(typeof directory==='string'&&directory.startsWith('/')&&
    TOKEN.test(tenantToken||'')&&Buffer.isBuffer(key)&&key.length===32,
    'absolute private folder, opaque tenant and independent signing key required');
  return {directory:resolve(directory),tenantToken,key};
}
async function init(directory){
  await mkdir(directory,{recursive:true,mode:0o700});
  const st=await lstat(directory);
  deny(st.isDirectory()&&!st.isSymbolicLink()&&
    (process.platform==='win32'||(st.mode&0o077)===0),
    'private audit directory must be 0700');
}
async function history(config){
  const path=join(config.directory,config.tenantToken+'.jsonl');
  let fd;
  try{fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch(e){if(e.code==='ENOENT')return {path,records:[],next:1,previous:ZERO};throw e;}
  try{
    const st=await fd.stat();
    deny(st.isFile()&&st.nlink===1&&st.size<=MAX_BYTES&&
      (process.platform==='win32'||(st.mode&0o077)===0),
      'unsafe signed checkpoint history file');
    const body=await fd.readFile({encoding:'utf8'});
    deny(!body||body.endsWith('\n'),'torn checkpoint append');
    const lines=body?body.slice(0,-1).split('\n'):[];
    deny(lines.length<=MAX_RECORDS,'checkpoint record limit reached');
    const records=[];let previous=ZERO;
    for(let i=0;i<lines.length;i++){
      let row;try{row=JSON.parse(lines[i]);}
      catch{throw Error('R5.4 signed checkpoint evidence refused: invalid event JSON');}
      const {mac,...record}=row||{};
      deny(record.format===FORMAT&&record.tenantToken===config.tenantToken&&
        record.sequence===i+1&&record.previousSha256===previous&&
        Number.isSafeInteger(record.sourceSequence)&&record.sourceSequence>=0&&
        Number.isSafeInteger(record.witnessedSequence)&&record.witnessedSequence>=0&&
        record.witnessedSequence<=record.sourceSequence&&
        record.outstanding===record.sourceSequence-record.witnessedSequence&&
        record.productionCutoverAllowed===false&&
        record.realTransactionRpoSecondsMeasured===false&&
        record.maximumRpoSecondsCertified===null&&
        typeof record.caughtUp==='boolean'&&
        record.caughtUp===(record.outstanding===0)&&
        typeof record.alertRequired==='boolean'&&
        typeof record.recordedAt==='string'&&Number.isFinite(Date.parse(record.recordedAt))&&
        equal(mac,hmac(config.key,JSON.stringify(record))),
        'checkpoint record chain or HMAC failed');
      if(records.length)deny(record.sourceSequence>=records.at(-1).sourceSequence&&
        record.witnessedSequence>=records.at(-1).witnessedSequence,
        'checkpoint cursor regressed');
      previous=sha(JSON.stringify(row));
      records.push(row);
    }
    return {path,records,next:records.length+1,previous};
  }finally{await fd.close();}
}
export async function appendR54CheckpointEvidence(input,cycle){
  const info=cfg(input);
  deny(cycle?.format==='osmanx-r54-delivery-window-v1'&&
    cycle.syntheticOnly===true&&cycle.productionCutoverAllowed===false&&
    cycle.realTransactionRpoSecondsMeasured===false&&
    cycle.maximumRpoSecondsCertified===null&&
    Number.isSafeInteger(cycle.observedCommittedSequence)&&
    Number.isSafeInteger(cycle.witnessedSequence)&&
    Number.isSafeInteger(cycle.outstandingCommittedEvents)&&
    cycle.outstandingCommittedEvents===
      cycle.observedCommittedSequence-cycle.witnessedSequence&&
    cycle.caughtUp===(cycle.outstandingCommittedEvents===0)&&
    typeof cycle.alertRequired==='boolean',
    'validated synthetic delivery receipt required');
  await init(info.directory);
  const lock=join(info.directory,info.tenantToken+'.lock');
  let guard;
  try{guard=await open(lock,constants.O_EXCL|constants.O_CREAT|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);}
  catch(e){if(e.code==='EEXIST')throw Error('R5.4 signed checkpoint evidence refused: concurrent evidence writer');throw e;}
  try{
    const state=await history(info);
    deny(state.next<=MAX_RECORDS,'checkpoint history full');
    const row={format:FORMAT,tenantToken:info.tenantToken,
      sequence:state.next,previousSha256:state.previous,
      sourceSequence:cycle.observedCommittedSequence,
      witnessedSequence:cycle.witnessedSequence,
      outstanding:cycle.outstandingCommittedEvents,
      caughtUp:cycle.caughtUp,alertRequired:cycle.alertRequired,
      oldestPendingWriteHintAgeMs:cycle.oldestPendingWriteHintAgeMs,
      recordedAt:new Date().toISOString(),
      realTransactionRpoSecondsMeasured:false,
      maximumRpoSecondsCertified:null,productionCutoverAllowed:false};
    const event={...row,mac:hmac(info.key,JSON.stringify(row))};
    const bytes=Buffer.from(JSON.stringify(event)+'\n');
    deny(bytes.length<=4096,'checkpoint event exceeds bounded size');
    const fd=await open(state.path,
      constants.O_CREAT|constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try{
      const stat=await fd.stat();
      deny(stat.isFile()&&stat.nlink===1&&stat.size+bytes.length<=MAX_BYTES&&
        (process.platform==='win32'||(stat.mode&0o077)===0),
        'unsafe checkpoint append target');
      await fd.writeFile(bytes);await fd.sync();
    }finally{await fd.close();}
    return {format:FORMAT,recorded:true,recordSequence:state.next,
      witnessedSequence:row.witnessedSequence,alertRequired:row.alertRequired,
      externallyAnchored:false,productionCutoverAllowed:false};
  }finally{
    await guard.close();
    await unlink(lock).catch(()=>{});
  }
}
export async function readR54CheckpointEvidence(input){
  const info=cfg(input);await init(info.directory);
  const state=await history(info),last=state.records.at(-1);
  return {format:FORMAT,hmacVerified:true,recordCount:state.records.length,
    lastWitnessedSequence:last?.witnessedSequence??null,
    lastObservedCommittedSequence:last?.sourceSequence??null,
    lastOutstanding:last?.outstanding??null,lastAlertRequired:last?.alertRequired??null,
    lastHeadDigest:state.previous,
    externallyAnchored:false,
    soleAuthorityForRemoteCheckpoint:false,productionCutoverAllowed:false};
}
