// R6.1: dual offline Ed25519 operator approvals, evidence-bound, READ-ONLY.
// Two distinct humans/keys; no approval ever permits clearing R5.7 pending_op.
import {createHash,createPublicKey,sign,verify} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,ID=/^[a-f0-9]{32}$/,HEX=/^[a-f0-9]{64}$/,
  PERSON=/^[a-z0-9][a-z0-9._-]{5,63}$/,
  VERSION=/^[a-zA-Z0-9_.-]{1,256}$/,
  ACTION=new Set(['investigate','export-evidence','close-readonly']),
  FORMAT='osmanx-r61-two-person-approval-v1';
const SHA=b=>createHash('sha256').update(b).digest('hex');
const shape=(o,keys)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).length===keys.length&&keys.every(k=>Object.hasOwn(o,k));
function deny(ok,msg){if(!ok)throw Error('R6.1 dual-approval refused: '+msg);}
function fields(v){
  deny(v&&TENANT.test(v.tenantId||'')&&ID.test(v.incidentId||'')&&
    HEX.test(v.evidenceSha256||'')&&
    Number.isSafeInteger(v.epoch)&&v.epoch>=1&&v.epoch<=1000000&&
    (v.s3Version===null||VERSION.test(v.s3Version||''))&&
    ['security','reliability'].includes(v.role)&&
    PERSON.test(v.reviewerId||'')&&ACTION.has(v.action)&&
    ID.test(v.nonce||'')&&Number.isSafeInteger(v.issuedAt)&&
    Number.isSafeInteger(v.expiresAt)&&v.expiresAt>v.issuedAt&&
    v.expiresAt-v.issuedAt<=15*60*1000,
    'invalid tenant, incident, evidence, reviewer, action or expiry');
  return {format:FORMAT,tenantId:v.tenantId,incidentId:v.incidentId,
    evidenceSha256:v.evidenceSha256,epoch:v.epoch,s3Version:v.s3Version,
    role:v.role,reviewerId:v.reviewerId,action:v.action,
    nonce:v.nonce,issuedAt:v.issuedAt,expiresAt:v.expiresAt};
}
function fingerprint(publicKey){
  const key=publicKey?.type==='public'?publicKey:createPublicKey(publicKey);
  return SHA(key.export({format:'der',type:'spki'}));
}
export function signR61Approval({payload,privateKey}={}){
  deny(privateKey,'offline Ed25519 signer required');
  const body=fields(payload);
  return {...body,signature:sign(null,Buffer.from(JSON.stringify(body)),
    privateKey).toString('base64')};
}
export function verifyR61DualApprovals({
  tenantId,incidentId,evidenceSha256,epoch,s3Version=null,action,
  approvals,reviewers,now=()=>Date.now()
}={}){
  deny(TENANT.test(tenantId||'')&&ID.test(incidentId||'')&&
    HEX.test(evidenceSha256||'')&&Number.isSafeInteger(epoch)&&
    epoch>=1&&(s3Version===null||VERSION.test(s3Version||''))&&
    ACTION.has(action)&&Array.isArray(approvals)&&approvals.length===2&&
    reviewers&&typeof reviewers==='object'&&typeof now==='function',
    'two offline approvals with pinned incident and read-only action required');
  const when=now(),roles=new Set(),users=new Set(),keys=new Set(),
    fingerprints=[];
  for(const packet of approvals){
    deny(shape(packet,[...Object.keys(fields(packet)),'signature'])&&
      packet.format===FORMAT,'noncanonical signed approval');
    const body=fields(packet);
    deny(body.tenantId===tenantId&&body.incidentId===incidentId&&
      body.evidenceSha256===evidenceSha256&&body.epoch===epoch&&
      body.s3Version===s3Version&&body.action===action,
      'approval not bound to exact recovery evidence and action');
    deny(when>=body.issuedAt&&when<body.expiresAt,
      'expired or future approval');
    const reviewer=reviewers[body.reviewerId];
    deny(reviewer&&reviewer.role===body.role&&reviewer.publicKey&&
      reviewer.revoked!==true,'reviewer missing, revoked or role mismatch');
    const sig=packet.signature;
    deny(typeof sig==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(sig)&&
      Buffer.from(sig,'base64').toString('base64')===sig&&
      Buffer.from(sig,'base64').length===64,
      'noncanonical signature');
    let valid=false;
    try{valid=verify(null,Buffer.from(JSON.stringify(body)),
      reviewer.publicKey,Buffer.from(sig,'base64'));}
    catch{valid=false;}
    deny(valid,'invalid offline Ed25519 signature');
    const fp=fingerprint(reviewer.publicKey);
    deny(!roles.has(body.role)&&!users.has(body.reviewerId)&&!keys.has(fp),
      'two independent reviewers, public keys and roles required');
    roles.add(body.role);users.add(body.reviewerId);keys.add(fp);
    fingerprints.push(fp);
  }
  deny(roles.has('security')&&roles.has('reliability'),
    'security and reliability roles both required');
  const canonical=approvals.map(v=>({
    reviewerId:v.reviewerId,signature:v.signature
  })).sort((a,b)=>a.reviewerId.localeCompare(b.reviewerId));
  return Object.freeze({format:'osmanx-r61-dual-verified-v1',
    tenantId,incidentId,evidenceSha256,epoch,s3Version,action,
    reviewersVerified:2,distinctPublicKeys:2,
    approvalsSha256:SHA(Buffer.from(JSON.stringify(canonical))),
    readonlyAuthorizationVerified:true,
    mayClearPendingIntent:false,mayAlterS3:false,
    mayRestoreCustomerData:false,productionCutoverAllowed:false});
}
