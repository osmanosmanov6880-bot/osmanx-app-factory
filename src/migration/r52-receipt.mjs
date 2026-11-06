// R5.2 tamper-evident private rehearsal receipt. Strictly sanitized:
// no CRM rows, credentials, domain names, recovery paths or cloud accounts.
import {createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,readFile,lstat,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const ID=/^[a-f0-9]{24}$/,HEX=/^[a-f0-9]{64}$/;
const FORMAT='osmanx-r52-failure-acceptance-v1';
const NAMES=['storage','backupWitness','auditAnchor','alerts'];
function deny(ok,msg){if(!ok)throw Error('R5.2 receipt refused: '+msg);}
function auth(key,body){return createHmac('sha256',key)
  .update('OSMANX-R52-FAILURE-RECEIPT-v1\0').update(JSON.stringify(body)).digest('hex');}
function eq(a,b){return typeof a==='string'&&typeof b==='string'&&HEX.test(a)&&HEX.test(b)&&
  timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function trusted({directory,key,tenantToken}={}){
  deny(typeof directory==='string'&&directory.startsWith('/')&&
    Buffer.isBuffer(key)&&key.length===32&&ID.test(tenantToken||''),
    'private absolute path, unique key and tenant token required');
  return {directory:resolve(directory),key,tenantToken};
}
async function prepare(dir){
  await mkdir(dir,{recursive:true,mode:0o700});
  const stat=await lstat(dir);
  deny(stat.isDirectory()&&!stat.isSymbolicLink()&&
    (process.platform==='win32'||(stat.mode&0o077)===0),
    'private report directory must be 0700');
}
function sanitize(matrix,rpo){
  deny(matrix?.format==='osmanx-r52-failure-matrix-v1'&&
    matrix.syntheticOnly===true&&matrix.failedServicesExercised===4&&
    matrix.everyFaultDeniedReadiness===true&&
    matrix.everyRecoveryRevalidated===true&&
    matrix.sourceFingerprintUnchanged===true&&
    matrix.productionCutoverAllowed===false,'incomplete four-service fault drill');
  deny(Array.isArray(matrix.serviceResults)&&matrix.serviceResults.length===4&&
    matrix.serviceResults.map(x=>x.service).join(',')===NAMES.join(',')&&
    matrix.serviceResults.every(x=>x.failClosed===true&&x.restored===true&&
      x.postRestoreRevalidated===true&&Number.isSafeInteger(x.recoveryMs)&&x.recoveryMs>=0),
    'invalid per-service failure evidence');
  deny(rpo?.format==='osmanx-r52-transaction-loss-v1'&&rpo.syntheticOnly===true&&
    Number.isSafeInteger(rpo.committedAfterBackup)&&
    Number.isSafeInteger(rpo.recoveredAfterBackup)&&
    Number.isSafeInteger(rpo.lostSinceBackup)&&
    rpo.committedAfterBackup===rpo.recoveredAfterBackup+rpo.lostSinceBackup&&
    rpo.sourceOpenedReadOnly===true&&rpo.recoveryOpenedReadOnly===true&&
    rpo.productionCutoverAllowed===false,
    'independent transaction-loss measurement required');
  return {
    format:FORMAT,syntheticOnly:true,
    services:NAMES.map((service,i)=>({
      service,failClosed:true,restarted:true,
      recoveryMs:matrix.serviceResults[i].recoveryMs
    })),
    sourceFingerprintUnchanged:true,
    committedAfterBackup:rpo.committedAfterBackup,
    recoveredAfterBackup:rpo.recoveredAfterBackup,
    lostSinceBackup:rpo.lostSinceBackup,
    testLossBudgetMet:rpo.withinTestLossBudget===true,
    productionRpoMeasured:false,
    operationalChaosGatePassed:rpo.withinTestLossBudget===true,
    geographicallyIndependentInfrastructureVerified:false,
    productionCutoverAllowed:false
  };
}
export async function writeR52RehearsalReceipt(config,{matrix,rpo}={}){
  const {directory,key,tenantToken}=trusted(config);
  await prepare(directory);
  const body={...sanitize(matrix,rpo),
    tenantToken,createdAt:new Date().toISOString(),runId:randomBytes(12).toString('hex')};
  const signed={...body,hmac:auth(key,body)};
  const bytes=Buffer.from(JSON.stringify(signed)+'\n');
  deny(bytes.length<=8192,'excess private receipt content');
  const path=join(directory,body.runId+'.json');
  let fd;
  try{
    fd=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    await fd.writeFile(bytes);await fd.sync();
  }catch(e){
    await unlink(path).catch(()=>{});throw e;
  }finally{await fd?.close();}
  return {path,receiptId:body.runId,
    testLossBudgetMet:body.testLossBudgetMet,
    productionCutoverAllowed:false};
}
export async function verifyR52RehearsalReceipt(config,receiptId){
  const {directory,key,tenantToken}=trusted(config);
  deny(ID.test(receiptId||''),'invalid private receipt ID');
  await prepare(directory);
  const path=join(directory,receiptId+'.json');
  const stat=await lstat(path);
  deny(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=8192&&
    (process.platform==='win32'||(stat.mode&0o077)===0),'unsafe private receipt');
  const bytes=await readFile(path);
  deny(bytes.length>0&&bytes[bytes.length-1]===10,'partial receipt write detected');
  let value;try{value=JSON.parse(bytes.toString('utf8'));}
  catch{throw Error('R5.2 receipt refused: invalid JSON');}
  const {hmac,...body}=value;
  deny(body.format===FORMAT&&body.tenantToken===tenantToken&&body.runId===receiptId&&
    body.syntheticOnly===true&&body.productionCutoverAllowed===false&&
    body.productionRpoMeasured===false&&
    Array.isArray(body.services)&&body.services.map(x=>x.service).join(',')===NAMES.join(',')&&
    body.services.every(x=>x.failClosed===true&&x.restarted===true&&
      Number.isSafeInteger(x.recoveryMs)&&x.recoveryMs>=0)&&
    Number.isSafeInteger(body.lostSinceBackup)&&body.lostSinceBackup>=0&&
    body.operationalChaosGatePassed===body.testLossBudgetMet,
    'receipt contents do not match schema');
  deny(eq(hmac,auth(key,body)),'rehearsal HMAC changed');
  return {format:FORMAT,receiptId,
    fourServiceFaultsVerified:true,
    syntheticLossBudgetMet:body.testLossBudgetMet,
    reportedLostTransactions:body.lostSinceBackup,
    signedReceiptVerified:true,
    productionCutoverAllowed:false};
}
