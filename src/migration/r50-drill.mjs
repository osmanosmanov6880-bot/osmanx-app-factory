// R5.0: independent operational recovery drill for synthetic signed CRM.
// Records an authenticated result; never moves the recovered SQLite into
// service, runs migrations, settles money or enables production cutover.
import {performance} from 'node:perf_hooks';
import {lstat,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {inspectR50Topology} from './r50-topology.mjs';
import {appendR50Evidence,readR50Evidence} from './r50-evidence.mjs';
import {restoreR49Offline} from './r49-operational-dr.mjs';
import {readR47SignedRemoteHead,r47TenantToken} from './r47-offsite.mjs';
const HEX=/^[a-f0-9]{64}$/;
function deny(ok,message){if(!ok)throw Error('R5.0 recovery gate refused: '+message);}
function metrics({maxRtoMs,maxBackupAgeMs}){
  deny(Number.isSafeInteger(maxRtoMs)&&maxRtoMs>=1000&&maxRtoMs<=3600000&&
    Number.isSafeInteger(maxBackupAgeMs)&&maxBackupAgeMs>=60000&&
    maxBackupAgeMs<=7*86400000,'invalid operational recovery thresholds');
}
export async function runR50RecoveryExercise({
  vault,remote,witness,bundleDir,trustedPublicKey,recoveryDirectory,
  storageEndpoint,witnessEndpoint,alertEndpoint,
  evidence,allowSyntheticLoopback=false,resolver,
  now=Date.now(),maxRtoMs=120000,maxBackupAgeMs=10800000,
  restore=restoreR49Offline
}={}){
  deny(vault?.projectId&&Buffer.isBuffer(vault.catalogKey)&&
    vault.catalogKey.length===32&&remote&&witness&&
    typeof witness.current==='function'&&typeof witness.verify==='function'&&
    typeof restore==='function'&&Number.isFinite(now),
    'signed vault, witness, recovery runner and clock required');
  metrics({maxRtoMs,maxBackupAgeMs});
  deny(Buffer.isBuffer(evidence?.key)&&evidence.key.length===32&&
    !evidence.key.equals(vault.catalogKey)&&
    evidence.tenantToken===r47TenantToken(vault.catalogKey,vault.projectId),
    'independent evidence key and bound tenant token required');
  const topo=await inspectR50Topology({
    storageEndpoint,witnessEndpoint,alertEndpoint,allowSyntheticLoopback,resolver
  });
  const start=performance.now();
  const anchor=await witness.current();
  deny(anchor&&HEX.test(anchor.catalogSha256)&&
    Number.isSafeInteger(anchor.entries)&&anchor.entries>0,
    'independently witnessed backup is missing');
  const before=await readR47SignedRemoteHead({vault,remote});
  await witness.verify(before);
  deny(before.catalogSha256===anchor.catalogSha256&&before.entries===anchor.entries,
    'witness is not bound to the current signed catalog');
  const confirmedAgeMs=now-Date.parse(anchor.committedAt);
  deny(Number.isFinite(confirmedAgeMs)&&confirmedAgeMs>=-60000,
    'witness clock is ahead of recovery clock');
  const age=Math.max(0,confirmedAgeMs);
  let outcome=null,elapsedMs=0,ok=false,reasonCode='RESTORE_REJECTED';
  try{
    outcome=await restore({vault,remote,witness,bundleDir,trustedPublicKey,recoveryDirectory});
    elapsedMs=Math.round(performance.now()-start);
    deny(outcome.catalogWitnessVerified===true&&outcome.objectLockVerified===true&&
      outcome.readOnlySource===true&&outcome.productionCutoverAllowed===false&&
      Number.isSafeInteger(outcome.signedTablesVerified)&&outcome.signedTablesVerified>0&&
      typeof outcome.outputFile==='string',
      'signed restore proof is incomplete');
    const final=await readR47SignedRemoteHead({vault,remote});
    await witness.verify(final);
    deny(final.catalogSha256===before.catalogSha256,
      'remote head advanced during disaster recovery');
    const expected=resolve(recoveryDirectory);
    const actual=resolve(outcome.outputFile);
    deny(actual.startsWith(expected+'/')&&actual.endsWith('.sqlite'),
      'restored SQLite path escaped the isolated recovery directory');
    const st=await lstat(actual);
    deny(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&
      st.size>=4096&&st.size<=128*1024*1024&&
      (process.platform==='win32'||(st.mode&0o077)===0),
      'unsafe recovered SQLite file');
    ok=elapsedMs<=maxRtoMs&&age<=maxBackupAgeMs;
    reasonCode=ok?'VERIFIED':elapsedMs>maxRtoMs?'RTO_EXCEEDED':'BACKUP_STALE';
  }catch(error){
    elapsedMs=Math.round(performance.now()-start);
    reasonCode='RESTORE_REJECTED';
    // Never suppress a failed recovery as a green signed acceptance record.
    const record=await appendR50Evidence(evidence,{verdict:'FAIL',reasonCode,
      catalogSha256:before.catalogSha256,witnessConfirmed:true,
      signedRestoreVerified:false,elapsedMs,confirmedAgeMs:age});
    const e=Error('R5.0 recovery gate refused: signed recovery rejected; evidence #'+record.sequence);
    e.cause=error;throw e;
  }
  const record=await appendR50Evidence(evidence,{verdict:ok?'PASS':'FAIL',
    reasonCode,catalogSha256:before.catalogSha256,
    witnessConfirmed:true,signedRestoreVerified:true,elapsedMs,confirmedAgeMs:age});
  const integrity=await readR50Evidence(evidence);
  deny(integrity.headSha256===record.headSha256&&integrity.lastVerdict===(ok?'PASS':'FAIL'),
    'evidence ledger changed after checkpoint');
  return {
    format:'osmanx-r50-operational-drill-v1',
    syntheticOnly:topo.syntheticOnly,
    signedRecoveryVerified:true,witnessConfirmed:true,objectLockVerified:true,
    restoredFile:outcome.outputFile,archivedCatalogSha256:before.catalogSha256,
    elapsedRecoveryMs:elapsedMs,confirmedBackupAgeMs:age,
    meetsRto:elapsedMs<=maxRtoMs,meetsBackupAge:age<=maxBackupAgeMs,
    syntheticDrillAccepted:ok,networkSeparationProof:topo.dnsAddressSeparated,
    physicalFailureDomainsIndependentlyVerified:false,
    externalAuditAnchorVerified:false,
    evidenceRecord:record.sequence,evidenceHeadSha256:record.headSha256,
    productionCutoverAllowed:false
  };
}
