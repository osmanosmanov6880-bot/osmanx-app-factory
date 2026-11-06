// R4.3 authenticated, append-only, HMAC-chained checkpoint receipts.
// Contains no CRM row payloads. External anchoring is required to detect
// complete deletion/truncation of the journal by a privileged local attacker.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,open,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const FORMAT='osmanx-r43-shadow-checkpoint-chain-v1';
const ZERO='0'.repeat(64);
const HEX=/^[0-9a-f]{64}$/;
function requireThat(value,message){if(!value)throw Error('R4.3 checkpoint denied: '+message);}
function digest(text){return createHash('sha256').update(text).digest('hex');}
function hmac(text,secret){return createHmac('sha256',secret).update('OSMANX-R43-CHECKPOINT\0').update(text).digest('hex');}
function validSecret(secret){requireThat(Buffer.isBuffer(secret)&&secret.length>=32,'external HMAC secret required');return secret;}
function validReceipt(receipt){
  requireThat(receipt?.format==='osmanx-r43-shadow-replay-v1'&&receipt.syntheticOnly===true
    &&receipt.readOnlySource===true&&receipt.primarySqliteModified===false
    &&receipt.productionCutoverAllowed===false&&receipt.shadowAligned===true
    &&HEX.test(receipt.checkpointHmac)&&HEX.test(receipt.manifestSha256),
    'invalid replay checkpoint or unsafe cutover status');
}
async function safeDirectory(folder){
  requireThat(typeof folder==='string'&&folder.length>0,'directory required');
  const root=resolve(folder);
  await mkdir(root,{recursive:true,mode:0o700});
  const stat=await lstat(root);
  requireThat(stat.isDirectory()&&!stat.isSymbolicLink(),'journal folder not regular');
  if(process.platform!=='win32')requireThat((stat.mode&0o077)===0,'folder must be private 0700');
  return root;
}
function decode(raw,secret){
  requireThat(Buffer.byteLength(raw,'utf8')<=8*1024*1024,'journal too large');
  if(!raw)return [];
  requireThat(raw.endsWith('\n'),'journal was interrupted');
  const lines=raw.slice(0,-1).split('\n'),records=[];
  requireThat(lines.length<=1000,'journal receipt limit exceeded');
  let previous=ZERO;
  for(let i=0;i<lines.length;i++){
    let record;try{record=JSON.parse(lines[i]);}catch{throw Error('R4.3 checkpoint denied: invalid JSON line');}
    requireThat(record?.format===FORMAT&&record.sequence===i+1&&record.previous===previous,'broken checkpoint chain');
    validReceipt(record.receipt);
    const canonical=JSON.stringify({format:FORMAT,sequence:i+1,previous,receipt:record.receipt});
    requireThat(record.sha256===digest(canonical),'checkpoint digest changed');
    const expected=hmac(canonical,secret);
    requireThat(typeof record.hmac==='string'&&HEX.test(record.hmac)
      &&timingSafeEqual(Buffer.from(record.hmac,'hex'),Buffer.from(expected,'hex')),'checkpoint HMAC mismatch');
    records.push(record);previous=digest(JSON.stringify(record));
  }
  return records;
}
async function load(path,secret){
  let handle;
  try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch(error){if(error.code==='ENOENT')return [];throw error;}
  try{
    const stat=await handle.stat();
    requireThat(stat.isFile()&&stat.nlink===1&&stat.size<=8*1024*1024,'unsafe checkpoint file');
    if(process.platform!=='win32')requireThat((stat.mode&0o077)===0,'checkpoint file must be 0600');
    return decode(await handle.readFile({encoding:'utf8'}),secret);
  }finally{await handle.close();}
}
function history(records){
  return records.slice(-10).map(x=>({sequence:x.sequence,finishedAt:x.receipt.finishedAt,
    appliedToShadow:x.receipt.firstPass?.inserted+x.receipt.firstPass?.updated,
    idempotentRetryVerified:x.receipt.idempotentRetryVerified,
    checkpointHmac:x.receipt.checkpointHmac}));
}
export async function verifyR43Checkpoints({directory,secret}={}){
  const root=await safeDirectory(directory),key=validSecret(secret);
  const rows=await load(join(root,'replay.jsonl'),key);
  return {ok:true,entries:rows.length,headSha256:rows.length?digest(JSON.stringify(rows.at(-1))):ZERO,
    history:history(rows)};
}
export async function appendR43Checkpoint({directory,secret,receipt}={}){
  const key=validSecret(secret);
  validReceipt(receipt);
  const root=await safeDirectory(directory),lockPath=join(root,'.replay.lock');
  const lock=await open(lockPath,'wx',0o600);
  try{
    const path=join(root,'replay.jsonl'),records=await load(path,key);
    if(records.length){
      const last=records.at(-1);
      if(last.receipt.manifestSha256===receipt.manifestSha256 &&
        last.receipt.tenantToken===receipt.tenantToken &&
        last.receipt.checkpointHmac===receipt.checkpointHmac){
        return {sequence:last.sequence,headSha256:digest(JSON.stringify(last)),deduplicated:true};
      }
    }
    requireThat(records.length<1000,'journal full');
    const prev=records.length?digest(JSON.stringify(records.at(-1))):ZERO;
    const body={format:FORMAT,sequence:records.length+1,previous:prev,receipt};
    const canonical=JSON.stringify(body);
    const entry={...body,sha256:digest(canonical),hmac:hmac(canonical,key)};
    const line=JSON.stringify(entry)+'\n';
    requireThat(Buffer.byteLength(line,'utf8')<=1024*1024,'receipt too large');
    let writer;
    try{
      writer=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
      const stat=await writer.stat();
      requireThat(stat.isFile()&&stat.nlink===1,'unsafe journal destination');
      if(process.platform!=='win32')requireThat((stat.mode&0o077)===0,'unsafe journal mode');
      await writer.writeFile(line);await writer.sync();
    }finally{await writer?.close();}
    return {sequence:entry.sequence,headSha256:digest(JSON.stringify(entry)),deduplicated:false};
  }finally{await lock.close();await unlink(lockPath);}
}
