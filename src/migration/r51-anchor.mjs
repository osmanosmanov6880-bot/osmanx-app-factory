// R5.1: independent audit anchor for the R5.0 HMAC evidence ledger.
// Reuses the separately keyed R4.8 monotonic witness protocol on a DIFFERENT
// host/credential set. The anchor is not a production approval or an
// externally audited immutable log unless the hosting operator proves it.
import {createR48WitnessClient} from './r48-witness.mjs';
import {readR50Evidence} from './r50-evidence.mjs';
import {r47TenantToken,readR47SignedRemoteHead} from './r47-offsite.mjs';

const HEX=/^[a-f0-9]{64}$/;
function deny(ok,msg){if(!ok)throw Error('R5.1 audit anchor refused: '+msg);}
export function createR51EvidenceAnchorClient({
  endpoint,token,secret,tenantToken,allowSyntheticLoopback=false
}={}){
  deny(Buffer.isBuffer(secret)&&secret.length===32&&
    /^[a-f0-9]{24}$/.test(tenantToken||''),
    'independent audit key and tenant token required');
  const client=createR48WitnessClient({
    endpoint,token,secret,tenant:tenantToken,allowSyntheticLoopback
  });
  return Object.freeze({
    endpoint,transport:'r51-external-monotonic-evidence-anchor-v1',
    async current(){return client.current();},
    async verify({evidenceHeadSha256,manifestSha256,records}={}){
      deny(HEX.test(evidenceHeadSha256)&&HEX.test(manifestSha256)&&
        Number.isSafeInteger(records)&&records>=1,'signed evidence fields required');
      const r=await client.verify({
        catalogSha256:evidenceHeadSha256,manifestSha256,entries:records});
      deny(r.anchorVerified,'external evidence anchor rejected');
      return {...r,evidenceAnchored:true,productionCutoverAllowed:false};
    },
    async commit({evidenceHeadSha256,manifestSha256,records}={}){
      deny(HEX.test(evidenceHeadSha256)&&HEX.test(manifestSha256)&&
        Number.isSafeInteger(records)&&records>=1,'signed evidence fields required');
      return client.commit({catalogSha256:evidenceHeadSha256,
        manifestSha256,entries:records});
    }
  });
}
export async function anchorR51Evidence({vault,evidence,remote,witness,anchor}={}){
  deny(vault?.projectId&&Buffer.isBuffer(vault.catalogKey)&&
    evidence?.tenantToken===r47TenantToken(vault.catalogKey,vault.projectId)&&
    Buffer.isBuffer(evidence.key)&&evidence.key.length===32&&
    typeof anchor?.commit==='function'&&typeof anchor?.verify==='function'&&
    typeof witness?.verify==='function'&&remote,
    'signed CRM vault, evidence, remote and independently keyed anchor required');
  const prior=await readR50Evidence(evidence);
  deny(prior.hmacVerified&&prior.recordCount>=1&&prior.lastVerdict==='PASS'&&
    HEX.test(prior.headSha256),'latest signed recovery evidence is not PASS');
  const head=await readR47SignedRemoteHead({vault,remote});
  await witness.verify(head);
  deny(head.manifestSha256===vault.manifestSha256,
    'current signed manifest differs from vault');
  await anchor.commit({
    evidenceHeadSha256:prior.headSha256,manifestSha256:vault.manifestSha256,
    records:prior.recordCount
  });
  const proof=await anchor.verify({
    evidenceHeadSha256:prior.headSha256,manifestSha256:vault.manifestSha256,
    records:prior.recordCount
  });
  const after=await readR50Evidence(evidence);
  deny(after.headSha256===prior.headSha256&&
    after.recordCount===prior.recordCount&&after.lastVerdict==='PASS',
    'recovery evidence changed during external anchoring');
  return {
    format:'osmanx-r51-remote-evidence-anchor-v1',
    auditHmacVerified:true,
    anchorVerified:proof.evidenceAnchored===true,
    anchorRecords:after.recordCount,
    evidenceHeadSha256:after.headSha256,
    signedCrmCatalogSha256:head.catalogSha256,
    externalHostOwnershipVerified:false,
    externalImmutableProviderVerified:false,
    productionCutoverAllowed:false
  };
}
export async function verifyR51EvidenceAnchor({vault,evidence,remote,witness,anchor,
  maxEvidenceAgeMs=3600000,now=Date.now()}={}){
  deny(Number.isSafeInteger(maxEvidenceAgeMs)&&maxEvidenceAgeMs>=60000&&
    maxEvidenceAgeMs<=30*86400000&&Number.isFinite(now),
    'bounded evidence-age threshold required');
  const proof=await readR50Evidence(evidence);
  deny(proof.hmacVerified&&proof.recordCount>=1&&proof.lastVerdict==='PASS',
    'latest signed recovery must have passed');
  const age=now-Date.parse(proof.lastRecordedAt);
  deny(Number.isFinite(age)&&age>=-60000&&age<=maxEvidenceAgeMs,
    'signed recovery acceptance is stale or future-dated');
  const head=await readR47SignedRemoteHead({vault,remote});
  await witness.verify(head);
  const witnessProof=await anchor.verify({
    evidenceHeadSha256:proof.headSha256,
    manifestSha256:vault.manifestSha256,records:proof.recordCount
  });
  const final=await readR50Evidence(evidence);
  deny(final.headSha256===proof.headSha256&&
    final.recordCount===proof.recordCount,'evidence updated while verifying anchor');
  return {
    format:'osmanx-r51-audit-verification-v1',
    signedLedgerVerified:true,
    remoteAnchorVerified:witnessProof.evidenceAnchored===true,
    witnessedBackupVerified:true,
    evidenceAgeMs:Math.max(0,age),
    evidenceHeadSha256:proof.headSha256,
    catalogSha256:head.catalogSha256,
    externalProviderIndependenceVerified:false,
    productionCutoverAllowed:false
  };
}
