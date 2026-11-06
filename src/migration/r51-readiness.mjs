// R5.1 operational *engineering* acceptance. HTTPS/DNS and machine-signed
// receipts cannot prove geographically independent providers, actual human
// on-call delivery, or authorize changing a production database.
import {inspectR50Topology} from './r50-topology.mjs';
import {verifyR51EvidenceAnchor} from './r51-anchor.mjs';
import {r47TenantToken} from './r47-offsite.mjs';
function deny(ok,reason){if(!ok)throw Error('R5.1 readiness denied: '+reason);}
export async function inspectR51Separation({storageEndpoint,witnessEndpoint,
  anchorEndpoint,alertEndpoint,resolver,allowSyntheticLoopback=false}={}){
  const pairs=[
    {storageEndpoint,witnessEndpoint,alertEndpoint},
    {storageEndpoint,witnessEndpoint:anchorEndpoint,alertEndpoint},
    {storageEndpoint:witnessEndpoint,witnessEndpoint:anchorEndpoint,alertEndpoint}
  ];
  const checks=[];
  for(const e of pairs)checks.push(await inspectR50Topology({
    ...e,resolver,allowSyntheticLoopback
  }));
  const synthetic=checks.some(x=>x.syntheticOnly);
  return {
    format:'osmanx-r51-separation-v1',
    endpointsChecked:4,
    httpsRequired:!synthetic,
    distinctOrigins:checks.every(x=>x.originSeparated),
    distinctResolvedAddresses:checks.every(x=>x.dnsAddressSeparated),
    syntheticOnly:synthetic,
    externalProviderOwnershipVerified:false,
    physicalFailureDomainsVerified:false,
    immutableExternalAuditVerified:false,
    dnsRebindingProtected:false,
    productionCutoverAllowed:false
  };
}
export async function runR51OperationalReadiness({
  vault,evidence,remote,witness,anchor,alert,
  storageEndpoint,witnessEndpoint,anchorEndpoint,alertEndpoint,
  witnessKey,anchorKey,alertKey,
  allowSyntheticLoopback=false,resolver,
  maxEvidenceAgeMs=3600000,now=Date.now()
}={}){
  deny(vault?.projectId&&Buffer.isBuffer(vault.catalogKey)&&
    Buffer.isBuffer(evidence?.key)&&
    evidence.tenantToken===r47TenantToken(vault.catalogKey,vault.projectId)&&
    typeof alert?.probe==='function'&&
    typeof anchor?.verify==='function','signed project, evidence and two verifiers required');
  const keys=[vault.catalogKey,evidence.key,witnessKey,anchorKey,alertKey];
  deny(keys.every(k=>Buffer.isBuffer(k)&&k.length===32),
    'all five independent 32-byte keys required');
  for(let i=0;i<keys.length;i++)for(let j=i+1;j<keys.length;j++)
    deny(!keys[i].equals(keys[j]),'different trust domains must use distinct secrets');
  const network=await inspectR51Separation({
    storageEndpoint,witnessEndpoint,anchorEndpoint,alertEndpoint,
    allowSyntheticLoopback,resolver
  });
  const signed=await verifyR51EvidenceAnchor({
    vault,evidence,remote,witness,anchor,maxEvidenceAgeMs,now
  });
  const alertProof=await alert.probe({now});
  deny(signed.remoteAnchorVerified===true&&signed.witnessedBackupVerified===true&&
    alertProof.signedAckVerified===true&&alertProof.nonceMatched===true,
    'backup/anchor or signed machine notification not verified');
  return {
    format:'osmanx-r51-operational-readiness-v1',
    engineeringEvidenceVerified:true,
    witnessedBackupVerified:true,
    externallyAnchoredEvidenceVerified:true,
    signedMachineAlertAcknowledged:true,
    fourEndpointsChecked:network.endpointsChecked,
    syntheticOnly:network.syntheticOnly,
    externalProviderOwnershipVerified:false,
    geographicalFailureDomainsVerified:false,
    humanOnCallVerified:false,
    externalAnchorWormVerified:false,
    // This gate never permits promoting synthetic DR to real production.
    productionCutoverAllowed:false
  };
}
