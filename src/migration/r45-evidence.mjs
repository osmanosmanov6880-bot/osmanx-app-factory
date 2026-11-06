// R4.5 private, tamper-evident journal of synthetic restoration receipts.
// An external anchor is necessary to detect deleting the entire history.
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,open,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const FORMAT='osmanx-r45-restore-evidence-v1',ZERO='0'.repeat(64);
const HEX=/^[a-f0-9]{64}$/;
function guard(ok,msg){if(!ok)throw Error('R4.5 evidence refused: '+msg);}
function sha(s){return createHash('sha256').update(s).digest('hex');}
function sign(s,key){return createHmac('sha256',key).update('OSMANX-R45-EVIDENCE-v1\0').update(s).digest('hex');}
function validate(key,receipt){
  guard(Buffer.isBuffer(key)&&key.length===32,'external HMAC key required');
  if(receipt)guard(receipt.format==='osmanx-r45-backup-restore-drill-v1'&&receipt.syntheticOnly===true
    &&receipt.verified===true&&receipt.sourcePrimaryModified===false&&receipt.productionCutoverAllowed===false
    &&receipt.encryptedArchiveVerified===true&&receipt.decryptedBytesVerified===true
    &&HEX.test(receipt.manifestSha256)&&HEX.test(receipt.encryptedSha256)
    &&HEX.test(receipt.financialTotalsHmac),'unsafe restore evidence');
}
async function privateDir(path){
  guard(typeof path==='string'&&path.length>0,'private directory required');
  const root=resolve(path);await mkdir(root,{recursive:true,mode:0o700});
  const s=await lstat(root);
  guard(s.isDirectory()&&!s.isSymbolicLink(),'journal directory not regular');
  if(process.platform!=='win32')guard((s.mode&0o077)===0,'journal directory must be mode 0700');
  return root;
}
function decode(text,key){
  guard(Buffer.byteLength(text,'utf8')<=8*1024*1024,'journal file too large');
  if(!text)return [];
  guard(text.endsWith('\n'),'partial journal write');
  const lines=text.slice(0,-1).split('\n');guard(lines.length<=1000,'journal too long');
  let previous=ZERO;const items=[];
  for(let i=0;i<lines.length;i++){
    let r;try{r=JSON.parse(lines[i]);}catch{throw Error('R4.5 evidence refused: invalid JSON');}
    validate(key,r?.receipt);
    guard(r?.format===FORMAT&&r.sequence===i+1&&r.previous===previous,'broken evidence history');
    const body=JSON.stringify({format:FORMAT,sequence:i+1,previous,receipt:r.receipt});
    guard(r.sha256===sha(body),'evidence hash changed');
    const expected=sign(body,key);
    guard(typeof r.hmac==='string'&&HEX.test(r.hmac)&&
      timingSafeEqual(Buffer.from(r.hmac,'hex'),Buffer.from(expected,'hex')),'evidence HMAC mismatch');
    previous=sha(JSON.stringify(r));items.push(r);
  }
  return items;
}
async function load(file,key){
  let f;try{f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch(e){if(e.code==='ENOENT')return [];throw e;}
  try{
    const s=await f.stat();guard(s.isFile()&&s.nlink===1&&s.size<=8*1024*1024,'unsafe evidence file');
    if(process.platform!=='win32')guard((s.mode&0o077)===0,'evidence must be mode 0600');
    return decode(await f.readFile({encoding:'utf8'}),key);
  }finally{await f.close();}
}
export async function verifyR45Evidence({directory,secret}={}){
  validate(secret);const root=await privateDir(directory);
  const rows=await load(join(root,'restore.jsonl'),secret);
  return {ok:true,entries:rows.length,headSha256:rows.length?sha(JSON.stringify(rows.at(-1))):ZERO,
    history:rows.slice(-10).map(x=>({sequence:x.sequence,finishedAt:x.receipt.finishedAt,
      snapshotSizeBytes:x.receipt.snapshotSizeBytes,
      signedTablesVerified:x.receipt.signedTablesVerified,
      financialRecords:x.receipt.financialRecords,verified:x.receipt.verified}))};
}
export async function appendR45Evidence({directory,secret,receipt}={}){
  validate(secret,receipt);
  const root=await privateDir(directory),lockPath=join(root,'.restore.lock');
  const lock=await open(lockPath,'wx',0o600);
  try{
    const file=join(root,'restore.jsonl'),list=await load(file,secret);
    guard(list.length<1000,'evidence history full');
    const previous=list.length?sha(JSON.stringify(list.at(-1))):ZERO;
    const body={format:FORMAT,sequence:list.length+1,previous,receipt};
    const canonical=JSON.stringify(body),record={...body,sha256:sha(canonical),hmac:sign(canonical,secret)};
    const serialized=JSON.stringify(record)+'\n';
    guard(Buffer.byteLength(serialized,'utf8')<1024*1024,'restore evidence too large');
    let f;try{
      f=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
      const s=await f.stat();guard(s.isFile()&&s.nlink===1,'unsafe evidence destination');
      if(process.platform!=='win32')guard((s.mode&0o077)===0,'unsafe evidence permissions');
      await f.writeFile(serialized);await f.sync();
    }finally{await f?.close();}
    return {sequence:record.sequence,headSha256:sha(JSON.stringify(record)),tamperEvident:true};
  }finally{await lock.close();await unlink(lockPath);}
}
