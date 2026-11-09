import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {signR62FenceObservation,inspectR62FenceObservations}
  from '../src/migration/r62-fence-evidence.mjs';
const TENANT='a'.repeat(24),CLUSTER='b'.repeat(24),INCIDENT='c'.repeat(32),
  SHA='d'.repeat(64),CHALLENGE='e'.repeat(64),LSN='0/1A21B0';
function fixture(){
  const now=Date.now(),old=generateKeyPairSync('ed25519'),
    backup=generateKeyPairSync('ed25519');
  const expected={tenantId:TENANT,clusterId:CLUSTER,incidentId:INCIDENT,
    epoch:11,intentSha256:SHA,challengeSha256:CHALLENGE,
    requiredLsn:LSN,primaryNode:'pg-r59-primary',standbyNode:'pg-r59-standby'};
  function payload(role,observerId){
    return {...expected,scope:'disposable-lab',primaryPowerState:'terminated',
      standbyInRecovery:true,standbyReplayVerified:true,role,observerId,
      nonce:randomBytes(16).toString('hex'),issuedAt:now-300,
      expiresAt:now+30000};
  }
  const observers={
    fence_observer:{role:'fence-observer',publicKey:old.publicKey},
    standby_observer:{role:'standby-observer',publicKey:backup.publicKey}
  };
  const observations=[
    signR62FenceObservation({
      payload:payload('fence-observer','fence_observer'),
      privateKey:old.privateKey}),
    signR62FenceObservation({
      payload:payload('standby-observer','standby_observer'),
      privateKey:backup.privateKey})
  ];
  function check(args={}){
    return inspectR62FenceObservations({
      observations,observers,expected,now:()=>now,...args
    });
  }
  return {now,old,backup,expected,observations,observers,payload,check};
}
test('R6.2 two signed old-primary termination observations remain diagnostic only',()=>{
  const f=fixture(),result=f.check();
  assert.equal(result.observerReportsVerified,true);
  assert.equal(result.independentObserverKeys,2);
  assert.equal(result.oldPrimaryReportedTerminated,true);
  assert.equal(result.physicalPowerIsolationIndependentlyCertified,false);
  assert.equal(result.oldPrimaryFencedByThisSoftware,false);
  assert.equal(result.automaticPromotionAllowed,false);
  assert.equal(result.productionCutoverAllowed,false);
});
test('R6.2 a partitioned but still live primary cannot produce valid fence proof',()=>{
  const f=fixture();
  assert.throws(()=>signR62FenceObservation({
    payload:{...f.payload('fence-observer','fence_observer'),
      primaryPowerState:'unreachable'},privateKey:f.old.privateKey
  }),/non-terminated primary/);
  assert.throws(()=>signR62FenceObservation({
    payload:{...f.payload('fence-observer','fence_observer'),
      primaryPowerState:'running'},privateKey:f.old.privateKey
  }),/non-terminated primary/);
});
test('R6.2 stale, mismatched WAL, altered epoch and forged cert are rejected',()=>{
  const f=fixture();
  for(const change of [{intentSha256:'f'.repeat(64)},
    {requiredLsn:'0/1A21B1'}, {epoch:12},
    {challengeSha256:'a'.repeat(64)}, {clusterId:'f'.repeat(24)}]){
    assert.throws(()=>f.check({expected:{...f.expected,...change}}),
      /checkpoint mismatch/);
  }
  assert.throws(()=>f.check({now:()=>f.now+61000}),/stale/);
  const tampered=f.observations.map(x=>({...x}));
  tampered[1].epoch=99;
  assert.throws(()=>f.check({observations:tampered}),/checkpoint mismatch/);
});
test('R6.2 one key cannot impersonate two observer roles',()=>{
  const f=fixture();
  const duplicated=[f.observations[0],f.observations[0]];
  assert.throws(()=>f.check({observations:duplicated}),
    /distinct observer roles/);
  const wrong={...f.observers,
    standby_observer:{
      role:'standby-observer',publicKey:f.old.publicKey
    }
  };
  assert.throws(()=>f.check({observers:wrong}),
    /untrusted or changed offline signature/);
});
test('R6.2 missing signature and revoked observer fail closed',()=>{
  const f=fixture(),bad=f.observations.map(x=>({...x}));
  delete bad[0].signature;
  assert.throws(()=>f.check({observations:bad}),/noncanonical/);
  const reviewers={...f.observers,
    fence_observer:{...f.observers.fence_observer,revoked:true}};
  assert.throws(()=>f.check({observers:reviewers}),/revoked/);
});
