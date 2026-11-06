// R5.0 signed local operations ledger. No CRM row data or credential values.
// Provides tamper evidence, not protection against complete directory deletion.
// Operator must anchor ledger head to an external immutable audit store.
import {createHash,createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,lstat,open,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const FORMAT='osmanx-r50-dr-evidence-v1',ZERO='0'.repeat(64),HEX=/^[a-f0-9]{64}$/;
const TOKEN=/^[a-f0-9]{24}$/,MAX_ROWS=1000,MAX_BYTES=1024*1024;
function deny(ok,msg){if(!ok)throw Error('R5.0 evidence refused: '+msg);}
function sha(x){return createHash('sha256').update(x).digest('hex');}
function mac(k,x){return createHmac('sha256',k).update('OSMANX-R50-DR-EVIDENCE-v1\0').update(x).digest('hex');}
function eq(a,b){return typeof a==='string'&&HEX.test(a)&&HEX.test(b)&&
  timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function requireOptions({directory,key,tenantToken}={}){
  deny(typeof directory==='string'&&directory.startsWith('/')&&
    Buffer.isBuffer(key)&&key.length===32&&TOKEN.test(tenantToken||''),
    'absolute private directory, independent key and opaque tenant token required');
  return {directory:resolve(directory),key,tenantToken};
}
function minimalResult(r){
  deny(r&&typeof r==='object'&&
    ['PASS','FAIL'].includes(r.verdict)&&HEX.test(r.catalogSha256)&&
    typeof r.witnessConfirmed==='boolean'&&typeof r.signedRestoreVerified==='boolean'&&
    Number.isSafeInteger(r.elapsedMs)&&r.elapsedMs>=0&&r.elapsedMs<=3600000&&
    Number.isSafeInteger(r.confirmedAgeMs)&&r.confirmedAgeMs>=0&&r.confirmedAgeMs<=365*86400000&&
    typeof r.reasonCode==='string'&&/^[A-Z_]{2,36}$/.test(r.reasonCode),
    'invalid sanitized acceptance receipt');
  deny(r.verdict!=='PASS'||(r.witnessConfirmed&&r.signedRestoreVerified&&
    r.reasonCode==='VERIFIED'),'PASS without both signed recovery proofs');
  return {verdict:r.verdict,reasonCode:r.reasonCode,catalogSha256:r.catalogSha256,
    witnessConfirmed:r.witnessConfirmed,signedRestoreVerified:r.signedRestoreVerified,
    elapsedMs:r.elapsedMs,confirmedAgeMs:r.confirmedAgeMs};
}
async function secureDir(dir){
  await mkdir(dir,{recursive:true,mode:0o700});
  const st=await lstat(dir);
  deny(st.isDirectory()&&!st.isSymbolicLink()&&
    (process.platform==='win32'||(st.mode&0o077)===0),'ledger directory must be 0700');
}
function parse(bytes,key,tenantToken){
  if(bytes.length===0)return {sequence:0,head:ZERO,events:[]};
  deny(bytes.length<=MAX_BYTES&&bytes[bytes.length-1]===10,
    'torn or oversized evidence ledger');
  const rows=bytes.toString('utf8').trimEnd().split('\n');
  deny(rows.length<=MAX_ROWS,'ledger event count exceeds bound');
  let previous=ZERO;
  const events=[];
  for(let i=0;i<rows.length;i++){
    let record;try{record=JSON.parse(rows[i]);}catch{throw Error('R5.0 evidence refused: ledger JSON changed');}
    const {signature,...body}=record;
    deny(body.format===FORMAT&&body.tenantToken===tenantToken&&
      body.sequence===i+1&&body.previous===previous&&
      /^[a-f0-9]{24}$/.test(body.id||'')&&
      typeof body.recordedAt==='string'&&Number.isFinite(Date.parse(body.recordedAt)),
      'ledger sequence, tenant or chain changed');
    minimalResult(body.result);
    deny(Object.keys(body).join('|')==='format|tenantToken|sequence|previous|id|recordedAt|result',
      'unexpected evidence fields');
    deny(eq(signature,mac(key,JSON.stringify(body))),'ledger HMAC changed');
    previous=sha(rows[i]);events.push(record);
  }
  return {sequence:events.length,head:previous,events};
}
async function load(dir,key,tenantToken){
  let f;try{f=await open(join(dir,'events.jsonl'),constants.O_RDONLY|constants.O_NOFOLLOW);}
  catch(e){if(e.code==='ENOENT')return parse(Buffer.alloc(0),key,tenantToken);throw e;}
  try{
    const st=await f.stat();
    deny(st.isFile()&&st.nlink===1&&st.size<=MAX_BYTES&&
      (process.platform==='win32'||(st.mode&0o077)===0),'unsafe ledger file');
    return parse(await f.readFile(),key,tenantToken);
  }finally{await f.close();}
}
export async function readR50Evidence(input){
  const {directory,key,tenantToken}=requireOptions(input);
  await secureDir(directory);
  const state=await load(directory,key,tenantToken);
  return {format:FORMAT,recordCount:state.sequence,headSha256:state.head,
    lastVerdict:state.events.at(-1)?.result?.verdict||null,
    lastRecordedAt:state.events.at(-1)?.recordedAt||null,
    hmacVerified:true,externallyAnchored:false,productionCutoverAllowed:false};
}
export async function appendR50Evidence(input,result,{now=new Date()}={}){
  const {directory,key,tenantToken}=requireOptions(input);
  deny(now instanceof Date&&Number.isFinite(now.getTime()),'invalid evidence timestamp');
  const sanitized=minimalResult(result);
  await secureDir(directory);
  const lockPath=join(directory,'.ledger.lock');
  const lock=await open(lockPath,'wx',0o600); // stale lock => operator intervention
  try{
    const current=await load(directory,key,tenantToken);
    deny(current.sequence<MAX_ROWS,'ledger full');
    const body={format:FORMAT,tenantToken,sequence:current.sequence+1,
      previous:current.head,id:randomBytes(12).toString('hex'),
      recordedAt:now.toISOString(),result:sanitized};
    const record={...body,signature:mac(key,JSON.stringify(body))};
    const line=JSON.stringify(record)+'\n';
    deny(Buffer.byteLength(line)<2048,'excess evidence fields');
    let f;try{
      f=await open(join(directory,'events.jsonl'),
        constants.O_CREAT|constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
      const st=await f.stat();
      deny(st.isFile()&&st.nlink===1&&
        (process.platform==='win32'||(st.mode&0o077)===0),'unsafe ledger append destination');
      await f.writeFile(line);await f.sync();
    }finally{await f?.close();}
    return {format:FORMAT,sequence:body.sequence,headSha256:sha(line.trimEnd()),
      verdict:sanitized.verdict,externallyAnchored:false,productionCutoverAllowed:false};
  }finally{await lock.close();await unlink(lockPath);}
}
