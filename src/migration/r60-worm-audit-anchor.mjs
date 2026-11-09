// R6.0: Ed25519-signed audit-tip anchoring into a content addressed
// COMPLIANCE WORM object. This is off-host evidence, NOT proof against
// provider admins or a replacement for a separate audit witness.
import {createHash,randomBytes,sign,verify} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,SHA=/^[a-f0-9]{64}$/,
  OBJ=/^r60\/audit\/([a-f0-9]{64})\.json$/,
  ISSUER=/^[a-z0-9._-]{6,64}$/,
  FORMAT='osmanx-r60-audit-anchor-v1';
function deny(ok,why){if(!ok)throw Error('R6.0 audit anchor refused: '+why);}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function anchorFields({tenantId,sequence,tipMac,issuedAt,nonce,issuer}){
  deny(TENANT.test(tenantId||'')&&Number.isSafeInteger(sequence)&&
    sequence>=0&&sequence<=1000000&&SHA.test(tipMac||'')&&
    Number.isSafeInteger(issuedAt)&&issuedAt>0&&
    /^[a-f0-9]{32}$/.test(nonce||'')&&ISSUER.test(issuer||''),
    'strict tenant, HMAC tip and independent reviewer required');
  return {format:FORMAT,tenantId,sequence,tipMac,issuedAt,nonce,issuer};
}
export function createR60AuditS3Capability({transport,tenantId}={}){
  deny(TENANT.test(tenantId||'')&&
    transport?.tenantPrefix===tenantId+'/'&&
    ['function','function','function','function'].every((x,i)=>
      typeof [transport.put,transport.getWithMetadata,
        transport.inspectR49Worm,transport.assertBucketControls][i]===x),
    'tenant-pinned independent SigV4 transport required');
  function allowed(key){
    deny(OBJ.test(key||''),'audit role may only address immutable audit hashes');
  }
  return Object.freeze({
    tenantPrefix:tenantId+'/',role:'audit-anchor-only',
    put(key,bytes){allowed(key);return transport.put(key,bytes);},
    getWithMetadata(key){allowed(key);return transport.getWithMetadata(key);},
    inspectR49Worm(key){allowed(key);return transport.inspectR49Worm(key);},
    assertBucketControls(){return transport.assertBucketControls();},
    productionCutoverAllowed:false
  });
}
export function createR60AuditIamPolicy({tenantId,bucket}={}){
  deny(TENANT.test(tenantId||'')&&
    /^(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket||'')&&
    !bucket.includes('..'),'literal audit-only resource required');
  return {Version:'2012-10-17',Statement:[
    {Effect:'Allow',
      Action:['s3:GetBucketVersioning','s3:GetBucketObjectLockConfiguration'],
      Resource:'arn:aws:s3:::'+bucket},
    {Effect:'Allow',
      Action:['s3:PutObject','s3:GetObject','s3:GetObjectRetention'],
      Resource:'arn:aws:s3:::'+bucket+'/'+tenantId+'/r60/audit/*'}
  ]};
}
export function createR60WormAuditAnchor({
  tenantId,ledger,remote,reviewerPrivateKey,reviewerPublicKey,
  reviewerId,now=()=>Date.now(),syntheticOnly=false
}={}){
  deny(syntheticOnly===true&&TENANT.test(tenantId||'')&&
    ledger?.tenantId===tenantId&&typeof ledger.verify==='function'&&
    remote?.tenantPrefix===tenantId+'/'&&
    remote?.role==='audit-anchor-only'&&
    typeof remote.put==='function'&&
    typeof remote.getWithMetadata==='function'&&
    typeof remote.inspectR49Worm==='function'&&
    reviewerPrivateKey&&reviewerPublicKey&&ISSUER.test(reviewerId||''),
    'separate audit reviewer signer, tenant, ledger and WORM sink required');
  function parseAndVerify(bytes){
    deny(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=4096,
      'bounded audit anchor bytes required');
    let packet;
    try{packet=JSON.parse(bytes.toString('utf8'));}
    catch{throw Error('R6.0 audit anchor refused: invalid signed JSON');}
    const {signature,...rest}=packet||{};
    const field=anchorFields(rest);
    deny(rest.format===FORMAT&&
      Object.keys(rest).length===Object.keys(field).length&&
      typeof signature==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(signature)&&
      Buffer.from(signature,'base64').toString('base64')===signature&&
      Buffer.from(signature,'base64').length===64,
      'noncanonical signed anchor');
    let valid=false;
    try{valid=verify(null,Buffer.from(JSON.stringify(field)),
      reviewerPublicKey,Buffer.from(signature,'base64'));}
    catch{valid=false;}
    deny(valid,'reviewer signature is invalid');
    deny(field.tenantId===tenantId&&field.issuer===reviewerId,
      'cross-tenant or forged reviewer');
    return field;
  }
  async function check(key,expected){
    deny(OBJ.test(key||''),'audit hash key required');
    const obj=await remote.getWithMetadata(key);
    deny(Buffer.isBuffer(obj.body)&&sha(obj.body)===OBJ.exec(key)[1]&&
      typeof obj.versionId==='string'&&obj.versionId.length>0,
      'audit object bytes/hash/version mismatch');
    const fields=parseAndVerify(obj.body);
    deny(fields.sequence===expected.sequence&&fields.tipMac===expected.tipMac,
      'remote audit tip differs from verified PostgreSQL chain');
    const retained=await remote.inspectR49Worm(key);
    deny(retained.objectLockVerified===true&&
      retained.retentionMode==='COMPLIANCE'&&
      retained.versionId===obj.versionId,
      'independent audit anchor is not a retained WORM version');
    return {anchored:true,objectKey:key,versionId:obj.versionId,
      digest:sha(obj.body),sequence:fields.sequence,tipMac:fields.tipMac,
      retainedUntil:retained.retentionUntil||null,
      providerWormVerified:true,independentExternalWitnessVerified:false,
      productionCutoverAllowed:false};
  }
  async function anchor(){
    const status=await ledger.verify();
    deny(status.verified===true&&Number.isSafeInteger(status.count)&&
      SHA.test(status.tipMac||''),'PG HMAC chain must verify first');
    const fields=anchorFields({tenantId,sequence:status.count,
      tipMac:status.tipMac,issuedAt:now(),
      nonce:randomBytes(16).toString('hex'),issuer:reviewerId});
    const signature=sign(null,Buffer.from(JSON.stringify(fields)),
      reviewerPrivateKey).toString('base64');
    const bytes=Buffer.from(JSON.stringify({...fields,signature}));
    deny(bytes.length<=4096,'signed evidence too large');
    const key='r60/audit/'+sha(bytes)+'.json';
    const controls=await remote.assertBucketControls();
    deny(controls.objectLockEnabled===true&&controls.versioningEnabled===true,
      'S3 bucket lacks versioning or object locking');
    await remote.put(key,bytes);
    return check(key,{sequence:status.count,tipMac:status.tipMac});
  }
  async function verifyAgainstLedger(key){
    const state=await ledger.verify();
    deny(state.verified===true,'invalid PG HMAC chain');
    return check(key,{sequence:state.count,tipMac:state.tipMac});
  }
  return Object.freeze({anchor,verifyAgainstLedger,tenantId,
    syntheticOnly:true,productionCutoverAllowed:false});
}
