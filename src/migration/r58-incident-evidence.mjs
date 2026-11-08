// R5.8: signed, read-only incident evidence for checkpoint quarantine.
// This packet is NOT an independent WORM archive, unquarantine token or
// production zero-RPO proof. Never causes remote writes or state resets.
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,HEX=/^[a-f0-9]{64}$/,
  FORMAT='osmanx-r58-incident-evidence-v1';
const sha=b=>createHash('sha256').update(b).digest('hex');
function deny(ok,reason){if(!ok)throw Error('R5.8 incident evidence refused: '+reason);}
function mac(key,body){return createHmac('sha256',key)
  .update('OSMANX-R58-QUARANTINE-EVIDENCE-v1\0').update(JSON.stringify(body))
  .digest('hex');}
function equal(a,b){return HEX.test(a||'')&&HEX.test(b||'')&&
  timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
export async function createR58IncidentEvidence({
  tenantId,coordinator,witness,remote,signingKey,now=()=>Date.now(),
  syntheticOnly=false
}={}){
  deny(syntheticOnly===true&&TENANT.test(tenantId||'')&&
    coordinator?.inspect&&witness?.current&&remote?.getWithMetadata&&
    remote?.inspectR49Worm&&Buffer.isBuffer(signingKey)&&
    signingKey.length===32&&typeof now==='function',
    'isolated controller, independent witness, S3 read-only probe and separate signing key required');
  const status=await coordinator.inspect(tenantId);
  deny(Number.isSafeInteger(status.epoch)&&status.epoch>=0&&
    typeof status.pending==='boolean','invalid persisted authority status');
  const anchor=await witness.current();
  let head=null,lock=null;
  try{
    const value=await remote.getWithMetadata('r53/head.json');
    deny(Buffer.isBuffer(value.body)&&typeof value.versionId==='string'&&
      value.versionId.length>0,'S3 pointer metadata missing');
    head={sha256:sha(value.body),versionId:value.versionId};
    lock=await remote.inspectR49Worm('r53/head.json');
    deny(lock?.objectLockVerified===true&&
      lock.retentionMode==='COMPLIANCE'&&lock.versionId===head.versionId,
      'S3 pointer not verified WORM');
  }catch(e){
    if(String(e.message)!=='R4.8 S3 denied: GET status 404')throw e;
  }
  if(anchor){
    deny(Number.isSafeInteger(anchor.entries)&&anchor.entries>=0&&
      HEX.test(anchor.catalogSha256||''),
      'independent witness current state invalid');
  }
  const body={
    format:FORMAT,tenantId,issuedAt:now(),
    nonce:randomBytes(16).toString('hex'),
    checkpoint:{epoch:status.epoch,active:status.active,
      pending:status.pending,pendingEpoch:status.pendingEpoch??null,
      committed:status.committed??null},
    s3:head,wormChecked:!!head,
    witness:anchor?{
      sequence:anchor.entries,catalogSha256:anchor.catalogSha256,
      manifestSha256:anchor.manifestSha256
    }:null,
    ambiguousStateRequiresOperatorReview:status.pending===true,
    automaticUnquarantineForbidden:true,syntheticOnly:true,
    productionCutoverAllowed:false
  };
  deny(Number.isSafeInteger(body.issuedAt)&&body.issuedAt>0,
    'invalid evidence clock');
  return {...body,mac:mac(signingKey,body)};
}
export function verifyR58IncidentEvidence({
  packet,signingKey,tenantId,now=()=>Date.now(),maxAgeMs=300000
}={}){
  deny(TENANT.test(tenantId||'')&&Buffer.isBuffer(signingKey)&&
    signingKey.length===32&&packet&&typeof packet==='object'&&
    Number.isSafeInteger(maxAgeMs)&&maxAgeMs>=1000&&maxAgeMs<=3600000,
    'signature verifier configuration invalid');
  const {mac:signature,...body}=packet;
  deny(body.format===FORMAT&&body.tenantId===tenantId&&
    Number.isSafeInteger(body.issuedAt)&&body.issuedAt<=now()+10000&&
    now()-body.issuedAt<=maxAgeMs&&
    body.automaticUnquarantineForbidden===true&&
    body.productionCutoverAllowed===false&&
    body.syntheticOnly===true&&
    equal(signature,mac(signingKey,body)), 'tampered, expired or cross-tenant evidence');
  return {signatureVerified:true,tenantId,
    ambiguousStateRequiresOperatorReview:body.ambiguousStateRequiresOperatorReview,
    nonAuthoritativeDiagnosticOnly:true,productionCutoverAllowed:false};
}
