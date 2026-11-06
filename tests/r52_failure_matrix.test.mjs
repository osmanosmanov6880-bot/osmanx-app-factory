import test from 'node:test';
import assert from 'node:assert/strict';
import {runR52FailureMatrix} from '../src/migration/r52-failure-matrix.mjs';

const services=['storage','backupWitness','auditAnchor','alerts'];
const fingerprint='c'.repeat(64);
const green=Object.freeze({
  format:'osmanx-r51-operational-readiness-v1',
  engineeringEvidenceVerified:true,
  witnessedBackupVerified:true,
  externallyAnchoredEvidenceVerified:true,
  signedMachineAlertAcknowledged:true,productionCutoverAllowed:false
});
function scenario(){
  const online=new Map(services.map(name=>[name,true]));
  const probe=async()=>{
    if([...online.values()].some(v=>!v))throw Error('service unreachable');
    return green;
  };
  const faults=services.map(name=>({
    name,isolate:async()=>online.set(name,false),
    restore:async()=>online.set(name,true)
  }));
  return {probe,faults,online};
}
test('R5.2 each isolated service blocks readiness until recovered',async()=>{
  const f=scenario();
  const result=await runR52FailureMatrix({probe:f.probe,scenarios:f.faults,
    syntheticOnly:true,readOnlyFingerprint:async()=>fingerprint,expectedFingerprint:fingerprint});
  assert.equal(result.failedServicesExercised,4);
  assert.equal(result.everyFaultDeniedReadiness,true);
  assert.equal(result.everyRecoveryRevalidated,true);
  assert.equal(result.productionCutoverAllowed,false);
  assert.deepEqual(result.serviceResults.map(x=>x.service),services);
});
test('R5.2 a no-op isolation cannot pass the negative test',async()=>{
  const f=scenario();f.faults[2].isolate=async()=>{};
  await assert.rejects(runR52FailureMatrix({probe:f.probe,scenarios:f.faults,
    syntheticOnly:true,readOnlyFingerprint:async()=>fingerprint,
    expectedFingerprint:fingerprint}),/auditAnchor outage did not disable readiness/);
});
test('R5.2 failure to recover the endpoint is never a green result',async()=>{
  const f=scenario();f.faults[1].restore=async()=>{throw Error('service down');};
  await assert.rejects(runR52FailureMatrix({probe:f.probe,scenarios:f.faults,
    syntheticOnly:true,readOnlyFingerprint:async()=>fingerprint,
    expectedFingerprint:fingerprint}),/backupWitness service restore failed/);
});
test('R5.2 changing primary fingerprint during synthetic failover is denied',async()=>{
  const f=scenario();let current=fingerprint;
  f.faults[0].isolate=async()=>{f.online.set('storage',false);current='d'.repeat(64);};
  await assert.rejects(runR52FailureMatrix({probe:f.probe,scenarios:f.faults,
    syntheticOnly:true,readOnlyFingerprint:async()=>current,
    expectedFingerprint:fingerprint}),/primary source changed/);
});
test('R5.2 refuses missing outage scenario and any unapproved real execution',async()=>{
  const f=scenario();
  await assert.rejects(runR52FailureMatrix({probe:f.probe,
    scenarios:f.faults.slice(1),syntheticOnly:true,
    readOnlyFingerprint:async()=>fingerprint,expectedFingerprint:fingerprint}),
    /exactly four ordered/);
  await assert.rejects(runR52FailureMatrix({probe:f.probe,
    scenarios:f.faults,syntheticOnly:false,
    readOnlyFingerprint:async()=>fingerprint,expectedFingerprint:fingerprint}),
    /isolated synthetic-only/);
});
test('R5.2 initial false success cannot start a disaster rehearsal',async()=>{
  const f=scenario();
  await assert.rejects(runR52FailureMatrix({probe:async()=>({
    ...green,productionCutoverAllowed:true}),scenarios:f.faults,
    syntheticOnly:true,readOnlyFingerprint:async()=>fingerprint,
    expectedFingerprint:fingerprint}),/initial operational probe not signed/);
});
