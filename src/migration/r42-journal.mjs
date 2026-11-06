// R4.2 private append-only HMAC journal of sanitized reconciliation results.
// HMAC chaining detects edits or removed middle records; external anchoring
// is still required to detect deletion or truncation of an entire history.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,mkdir,open,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const FORMAT='osmanx-r42-audit-journal-v1';
const ZERO='0'.repeat(64);
function guard(ok,msg){if(!ok)throw Error('R4.2 journal refused: '+msg);}
function privateSecret(key){guard(Buffer.isBuffer(key)&&key.length>=32,'private 32-byte+ HMAC key required');return key;}
function sha(s){return createHash('sha256').update(s).digest('hex');}
function mac(s,key){return createHmac('sha256',key).update('OSMANX-R42-JOURNAL\0').update(s).digest('hex');}
async function safeDirectory(path){
  guard(typeof path==='string'&&path.length>0,'directory missing');
  const root=resolve(path);
  await mkdir(root,{recursive:true,mode:0o700});
  const dir=await lstat(root);
  guard(dir.isDirectory()&&!dir.isSymbolicLink(),'journal directory is not regular');
  if(process.platform!=='win32')guard((dir.mode&0o077)===0,'journal directory must be 0700');
  return root;
}
function parse(raw,key){
  guard(Buffer.byteLength(raw,'utf8')<=8*1024*1024,'journal too large');
  if(!raw)return [];
  guard(raw.endsWith('\n'),'unfinished journal entry');
  const lines=raw.slice(0,-1).split('\n');
  guard(lines.length<=1000,'journal entry count exceeded');
  const records=[];let prev=ZERO;
  for(let i=0;i<lines.length;i++){
    let r;try{r=JSON.parse(lines[i]);}catch{throw Error('R4.2 journal refused: invalid JSON');}
    guard(r?.format===FORMAT&&r.sequence===i+1&&r.previous===prev,'broken sequence or history');
    guard(r.receipt?.format==='osmanx-r42-reconciliation-v1'&&r.receipt.readOnly===true
      &&r.receipt.productionCutoverAllowed===false,'unsafe audit receipt');
    const canonical=JSON.stringify({format:FORMAT,sequence:i+1,previous:prev,receipt:r.receipt});
    guard(r.sha256===sha(canonical),'audit checksum mismatch');
    const expected=mac(canonical,key);
    guard(typeof r.hmac==='string'&&/^[a-f0-9]{64}$/.test(r.hmac)&&
      timingSafeEqual(Buffer.from(r.hmac,'hex'),Buffer.from(expected,'hex')),'audit signature mismatch');
    prev=sha(JSON.stringify(r));records.push(r);
  }
  return records;
}
async function readRecords(path,key){
  let f;
  try{f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch(e){if(e.code==='ENOENT')return [];throw e;}
  try{
    const s=await f.stat();
    guard(s.isFile()&&s.nlink===1,'journal is not a single regular file');
    if(process.platform!=='win32')guard((s.mode&0o077)===0,'journal must be mode 0600');
    guard(s.size<=8*1024*1024,'journal too large');
    return parse(await f.readFile({encoding:'utf8'}),key);
  }finally{await f.close();}
}
export async function verifyR42Journal({directory,secret}={}){
  const root=await safeDirectory(directory);
  const rows=await readRecords(join(root,'checks.jsonl'),privateSecret(secret));
  return {ok:true,entries:rows.length,headSha256:rows.length?sha(JSON.stringify(rows.at(-1))):ZERO,
    history:rows.slice(-10).map(r=>({sequence:r.sequence,finishedAt:r.receipt.finishedAt,
      ok:r.receipt.ok,totalDifferences:r.receipt.totalDifferences,
      sourceBaselineMismatchCount:r.receipt.sourceBaselineMismatchTables?.length??0}))};
}
export async function appendR42Journal({directory,secret,receipt}={}){
  const key=privateSecret(secret);
  guard(receipt?.format==='osmanx-r42-reconciliation-v1'&&receipt.readOnly===true
    &&receipt.productionCutoverAllowed===false,'invalid receipt');
  const root=await safeDirectory(directory),lockPath=join(root,'.append.lock');
  const lock=await open(lockPath,'wx',0o600); // fail closed on overlapping/stale writer
  try{
    const filePath=join(root,'checks.jsonl');
    const existing=await readRecords(filePath,key);
    guard(existing.length<1000,'journal full');
    const prev=existing.length?sha(JSON.stringify(existing.at(-1))):ZERO;
    const body={format:FORMAT,sequence:existing.length+1,previous:prev,receipt};
    const canonical=JSON.stringify(body);
    const record={...body,sha256:sha(canonical),hmac:mac(canonical,key)};
    const line=JSON.stringify(record)+'\n';
    guard(Buffer.byteLength(line,'utf8')<1024*1024,'receipt exceeds bounds');
    let writer;
    try{
      writer=await open(filePath,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
      const s=await writer.stat();
      guard(s.isFile()&&s.nlink===1,'unsafe journal destination');
      if(process.platform!=='win32')guard((s.mode&0o077)===0,'unsafe journal permissions');
      await writer.writeFile(line);await writer.sync();
    }finally{await writer?.close();}
    return {sequence:record.sequence,headSha256:sha(JSON.stringify(record)),tamperEvident:true};
  }finally{await lock.close();await unlink(lockPath);}
}
