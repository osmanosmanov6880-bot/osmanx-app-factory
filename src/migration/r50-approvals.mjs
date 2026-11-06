// R5.0 separated-review proof for a controlled external DR rehearsal.
// Signatures bind the exact code commit, signed catalog and evidence ledger.
// A signature proves key possession, NOT human identity or deployment safety.
import {createHash,createPublicKey,verify} from 'node:crypto';
const FORMAT='osmanx-r50-staging-review-v1',HEX=/^[a-f0-9]{64}$/,TOKEN=/^[a-f0-9]{24}$/;
const ROLES=['security','operations','dataOwner'];
function deny(ok,msg){if(!ok)throw Error('R5.0 independent review refused: '+msg);}
function validated(x){
  deny(x&&x.format===FORMAT&&TOKEN.test(x.tenantToken||'')&&
    HEX.test(x.catalogSha256||'')&&HEX.test(x.evidenceHeadSha256||'')&&
    HEX.test(x.testedCodeSha256||'')&&Number.isSafeInteger(x.expiresAt)&&
    Number.isSafeInteger(x.issuedAt)&&x.issuedAt>0&&x.expiresAt>x.issuedAt&&
    x.expiresAt-x.issuedAt<=7*86400000&&
    typeof x.purpose==='string'&&x.purpose==='EXTERNAL_SYNTHETIC_DR_REHEARSAL',
    'invalid review challenge');
  return {format:FORMAT,tenantToken:x.tenantToken,
    catalogSha256:x.catalogSha256,evidenceHeadSha256:x.evidenceHeadSha256,
    testedCodeSha256:x.testedCodeSha256,issuedAt:x.issuedAt,
    expiresAt:x.expiresAt,purpose:x.purpose};
}
export function canonicalR50ApprovalMessage(challenge){
  const c=validated(challenge);
  return Buffer.from('OSMANX-R50-STAGING-REVIEW-v1\0'+JSON.stringify(c),'utf8');
}
export function verifyR50IndependentReviews({challenge,approvals,trustedPublicKeys,now=Date.now()}={}){
  const c=validated(challenge);
  deny(Number.isFinite(now)&&now>=c.issuedAt-60000&&now<c.expiresAt,
    'review challenge expired or not yet valid');
  deny(Array.isArray(approvals)&&approvals.length===3&&trustedPublicKeys&&
    typeof trustedPublicKeys==='object','three external reviewer signatures required');
  const message=canonicalR50ApprovalMessage(c),seen=new Set(),fingerprints=new Set();
  for(const item of approvals){
    deny(item&&ROLES.includes(item.role)&&!seen.has(item.role),
      'review roles must be distinct');
    seen.add(item.role);
    let pub;try{pub=createPublicKey(trustedPublicKeys[item.role]);}
    catch{throw Error('R5.0 independent review refused: trusted review public key missing');}
    deny(pub.asymmetricKeyType==='ed25519','review key must be Ed25519');
    const fp=createHash('sha256').update(pub.export({format:'der',type:'spki'})).digest('hex');
    deny(!fingerprints.has(fp),'one signing key cannot satisfy two review roles');
    fingerprints.add(fp);
    deny(typeof item.signature==='string'&&
      /^[A-Za-z0-9+/]{86}==$/.test(item.signature),
      'invalid detached reviewer signature');
    deny(verify(null,message,pub,Buffer.from(item.signature,'base64')),
      'reviewer signature does not match signed code and DR evidence');
  }
  deny(seen.size===3&&ROLES.every(x=>seen.has(x)),'security, operations and data owner required');
  return {
    format:FORMAT,rolesVerified:[...ROLES],
    trustedUniqueKeyFingerprints:[...fingerprints],
    boundCatalogSha256:c.catalogSha256,
    boundEvidenceSha256:c.evidenceHeadSha256,
    reviewedCodeSha256:c.testedCodeSha256,
    expiresAt:c.expiresAt,
    approvedForSyntheticExternalDrill:true,
    independentlyVerifiedHumanIdentities:false,
    externalInfrastructureVerified:false,
    productionCutoverAllowed:false
  };
}
