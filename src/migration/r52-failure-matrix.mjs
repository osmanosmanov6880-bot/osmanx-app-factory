// R5.2 synthetic failure injection: demonstrate that operational readiness
// fails during actual unavailable services, and re-verifies only after
// restoration. No mutation of customer data and no production promotion.
import {performance} from 'node:perf_hooks';

const REQUIRED=['storage','backupWitness','auditAnchor','alerts'];
function deny(ok,reason){if(!ok)throw Error('R5.2 failure drill refused: '+reason);}
function accepted(r){
  return Boolean(r&&r.format==='osmanx-r51-operational-readiness-v1'&&
    r.engineeringEvidenceVerified===true&&
    r.witnessedBackupVerified===true&&
    r.externallyAnchoredEvidenceVerified===true&&
    r.signedMachineAlertAcknowledged===true&&
    r.productionCutoverAllowed===false);
}
function cap(ms){return Math.max(0,Math.round(ms));}
export async function runR52FailureMatrix({
  probe,scenarios,readOnlyFingerprint,expectedFingerprint,
  syntheticOnly=false,maxRecoveryMs=30000
}={}){
  deny(syntheticOnly===true,'explicit isolated synthetic-only execution required');
  deny(typeof probe==='function'&&typeof readOnlyFingerprint==='function'&&
    typeof expectedFingerprint==='string'&&/^[a-f0-9]{64}$/.test(expectedFingerprint),
    'verified read-only primary fingerprint required');
  deny(Number.isSafeInteger(maxRecoveryMs)&&maxRecoveryMs>=1000&&maxRecoveryMs<=120000,
    'invalid recovery time limit');
  deny(Array.isArray(scenarios)&&scenarios.length===REQUIRED.length&&
    scenarios.map(x=>x?.name).join(',')===REQUIRED.join(',')&&
    scenarios.every(x=>typeof x.isolate==='function'&&typeof x.restore==='function'),
    'exactly four ordered infrastructure faults are required');
  const fingerprint=async()=>deny((await readOnlyFingerprint())===expectedFingerprint,
    'primary source changed during isolated outage test');
  await fingerprint();
  deny(accepted(await probe()),'initial operational probe not signed and healthy');
  const results=[];
  for(const scenario of scenarios){
    let isolated=false,negative=false,restored=false;
    let recoveryMs=0,restoreError=null,recoveryStarted=0;
    try{
      // If isolate() fails, cleanup still calls restore() to avoid
      // leaving any test service in an unknown state.
      isolated=true;
      await scenario.isolate();
      try{
        const result=await probe();
        negative=!accepted(result);
      }catch{negative=true;}
    }finally{
      recoveryStarted=performance.now();
      if(isolated){
        try{await scenario.restore();restored=true;}
        catch(e){restoreError=e;}
      }
      // Full readiness is timed below, not just the service restart.
    }
    // Never mask restoration failures with successful negative tests.
    if(restoreError)throw Error('R5.2 failure drill refused: '+
      scenario.name+' service restore failed', {cause:restoreError});
    await fingerprint();
    deny(negative,scenario.name+' outage did not disable readiness');
    deny(restored,scenario.name+' was not restored');
    const check=await probe();
    recoveryMs=cap(performance.now()-recoveryStarted);
    deny(accepted(check),scenario.name+' failed health/readiness after restart');
    deny(recoveryMs<=maxRecoveryMs,scenario.name+' restart and signed revalidation exceeded synthetic deadline');
    results.push(Object.freeze({service:scenario.name,failClosed:true,
      restored:true,recoveryMs,postRestoreRevalidated:true}));
  }
  await fingerprint();
  return Object.freeze({
    format:'osmanx-r52-failure-matrix-v1',syntheticOnly:true,
    failedServicesExercised:results.length,
    serviceResults:results,sourceFingerprintUnchanged:true,
    everyFaultDeniedReadiness:true,everyRecoveryRevalidated:true,
    physicallyIndependentServersVerified:false,
    realCustomerWorkloadTested:false,productionCutoverAllowed:false
  });
}
