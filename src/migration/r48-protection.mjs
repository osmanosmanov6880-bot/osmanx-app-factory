// R4.8: offsite proof must be observed by an independent monotonic witness.
// RTO is measured from start of this drill until signed SQLite recovery;
// "RPO" here is confirmed-backup age, not live transaction-loss measurement.
import {performance} from 'node:perf_hooks';
import {readR47SignedRemoteHead,synchronizeR47Offsite,
  verifyR47OffsiteDrill} from './r47-offsite.mjs';
function guard(ok,msg){if(!ok)throw Error('R4.8 recovery gate refused: '+msg);}
async function alert(outbox,code){
  if(!outbox)return;
  try{await outbox.emit(code);}catch{/* preserve original protection error */}
}
function requireContext({vault,remote,witness,bundleDir,trustedPublicKey,actorId}={}){
  guard(vault&&remote&&typeof remote.get==='function'&&
    witness&&typeof witness.current==='function'&&typeof witness.commit==='function'&&
    typeof witness.verify==='function'&&typeof bundleDir==='string'&&
    typeof trustedPublicKey==='string'&&typeof actorId==='string'&&actorId.length>0,
    'signed owner, archive and independent witness required');
}
async function remoteWitnessHead(context){
  const head=await readR47SignedRemoteHead(context);
  await context.witness.verify(head);
  return head;
}
export async function runR48WitnessedSync(input,{requireS3Controls=false}={}){
  requireContext(input);
  try{
    if(requireS3Controls){
      guard(typeof input.remote.assertBucketControls==='function',
        'production-like S3 bucket controls not verified');
      const check=await input.remote.assertBucketControls();
      guard(check.versioningEnabled&&check.objectLockEnabled,
        'remote versioning/Object Lock not enabled');
    }
    const sync=await synchronizeR47Offsite(input);
    guard(sync.remoteReadbackVerified&&sync.encryptedOnly,'remote encrypted readback required');
    const head=await readR47SignedRemoteHead(input);
    await input.witness.commit(head);
    await input.witness.verify(head);
    return {format:'osmanx-r48-witnessed-sync-v1',syntheticOnly:true,
      witnessConfirmed:true,encryptedOnly:true,remoteReadbackVerified:true,
      catalogEntries:head.entries,remoteCatalogSha256:head.catalogSha256,
      sourcePrimaryModified:false,productionCutoverAllowed:false};
  }catch(error){
    await alert(input.outbox,/witness|rollback|older|fork/i.test(error.message)?
      'ROLLBACK_DETECTED':'REMOTE_UNAVAILABLE');
    throw error;
  }
}
export async function runR48RecoveryDrill(input,{
  maxRtoMs=120000,maxConfirmedBackupAgeMs=10800000,now=Date.now()
}={}){
  requireContext(input);
  guard(Number.isFinite(now)&&Number.isSafeInteger(maxRtoMs)&&maxRtoMs>=1000&&
    maxRtoMs<=3600000&&Number.isSafeInteger(maxConfirmedBackupAgeMs)&&
    maxConfirmedBackupAgeMs>=60000&&maxConfirmedBackupAgeMs<=7*86400000,
    'invalid RTO or confirmed-backup-age target');
  const start=performance.now();
  try{
    const head=await remoteWitnessHead(input);
    const anchor=await input.witness.current();
    guard(anchor&&anchor.catalogSha256===head.catalogSha256,
      'remote catalog is older than external anchor');
    const ageMs=now-Date.parse(anchor.committedAt);
    guard(Number.isFinite(ageMs)&&ageMs>=-60000,'invalid witness recovery time');
    const restored=await verifyR47OffsiteDrill(input);
    guard(restored.restoredIntegrityVerified&&restored.catalogVerified&&
      restored.remoteArchiveVerified&&restored.productionCutoverAllowed===false,
      'signed remote archive verification incomplete');
    const rtoMs=Math.max(0,Math.round(performance.now()-start));
    const meetsRto=rtoMs<=maxRtoMs,meetsBackupAge=ageMs<=maxConfirmedBackupAgeMs;
    if(!meetsRto)await alert(input.outbox,'RESTORE_SLOW');
    if(!meetsBackupAge)await alert(input.outbox,'BACKUP_STALE');
    return {format:'osmanx-r48-measured-restore-v1',syntheticOnly:true,
      witnessConfirmed:true,signedRestoreVerified:true,
      rtoMs,confirmedBackupAgeMs:ageMs,
      maxRtoMs,maxConfirmedBackupAgeMs,meetsRto,meetsBackupAge,
      meetsTargets:meetsRto&&meetsBackupAge,
      signedTablesVerified:restored.signedTablesVerified,
      financialRecords:restored.financialRecords,
      financialTotalsHmac:restored.financialTotalsHmac,
      remoteCatalogSha256:head.catalogSha256,
      sourcePrimaryModified:false,productionCutoverAllowed:false};
  }catch(error){
    await alert(input.outbox,/witness|older|rollback|head/i.test(error.message)?
      'ROLLBACK_DETECTED':'RESTORE_FAILED');
    throw error;
  }
}
export async function inspectR48Protection(input,{
  maxConfirmedBackupAgeMs=10800000,now=Date.now()
}={}){
  requireContext(input);
  try{
    const head=await remoteWitnessHead(input);
    const anchor=await input.witness.current();
    const ageMs=now-Date.parse(anchor.committedAt);
    const recent=Number.isFinite(ageMs)&&ageMs>=-60000&&ageMs<=maxConfirmedBackupAgeMs;
    if(!recent)await alert(input.outbox,'BACKUP_STALE');
    return {format:'osmanx-r48-protection-status-v1',syntheticOnly:true,
      remoteCatalogAuthenticated:true,independentWitnessMatches:true,
      confirmedBackupAgeMs:ageMs,healthy:recent,
      productionCutoverAllowed:false};
  }catch(error){
    await alert(input.outbox,/witness|older|rollback/i.test(error.message)?
      'ROLLBACK_DETECTED':'REMOTE_UNAVAILABLE');
    return {format:'osmanx-r48-protection-status-v1',syntheticOnly:true,
      remoteCatalogAuthenticated:false,independentWitnessMatches:false,
      healthy:false,productionCutoverAllowed:false};
  }
}
