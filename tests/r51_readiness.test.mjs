import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {r47TenantToken} from '../src/migration/r47-offsite.mjs';
import {inspectR51Separation,runR51OperationalReadiness}
  from '../src/migration/r51-readiness.mjs';
const e={
  storageEndpoint:'https://storage.example.com/',
  witnessEndpoint:'https://witness.example.net/',
  anchorEndpoint:'https://audit.example.org/',
  alertEndpoint:'https://alerts.example.edu/'
};
const ip={'storage.example.com':'8.8.8.8','witness.example.net':'1.1.1.1',
  'audit.example.org':'9.9.9.9','alerts.example.edu':'4.2.2.2'};
const resolver=async host=>[{address:ip[host],family:4}];
test('R5.1 four distinct HTTPS origins do not self-certify cloud independence',async()=>{
  const r=await inspectR51Separation({...e,resolver});
  assert.equal(r.endpointsChecked,4);
  assert.equal(r.distinctOrigins,true);
  assert.equal(r.distinctResolvedAddresses,true);
  assert.equal(r.physicalFailureDomainsVerified,false);
  assert.equal(r.externalProviderOwnershipVerified,false);
  assert.equal(r.productionCutoverAllowed,false);
});
test('R5.1 audit anchor sharing a witness IP fails before any receipt publication',async()=>{
  const f=async host=>[{address:host==='audit.example.org'?'1.1.1.1':ip[host],family:4}];
  await assert.rejects(inspectR51Separation({...e,resolver:f}),/share DNS addresses/);
});
test('R5.1 synthetic four-port loopback is labelled same-host, not external',async()=>{
  const r=await inspectR51Separation({
    storageEndpoint:'http://127.0.0.1:9000/',
    witnessEndpoint:'http://127.0.0.1:9100/',
    anchorEndpoint:'http://127.0.0.1:9200/',
    alertEndpoint:'http://127.0.0.1:9300/',
    resolver:async()=>[{address:'127.0.0.1',family:4}],
    allowSyntheticLoopback:true});
  assert.equal(r.syntheticOnly,true);
  assert.equal(r.distinctResolvedAddresses,false);
  assert.equal(r.productionCutoverAllowed,false);
});
test('R5.1 trust domains must never reuse the same encryption/evidence/alert key',async()=>{
  const key=randomBytes(32),tenantToken=r47TenantToken(key,'11111111-1111-4111-8111-111111111111');
  const vault={projectId:'11111111-1111-4111-8111-111111111111',catalogKey:key};
  const result=runR51OperationalReadiness({vault,
    evidence:{key,tenantToken},remote:{},witness:{},
    anchor:{verify:async()=>({})},alert:{probe:async()=>({})},
    witnessKey:randomBytes(32),anchorKey:randomBytes(32),alertKey:randomBytes(32),
    ...e,resolver});
  await assert.rejects(result,/independent secrets|different trust domains/);
});
test('R5.1 external signing service cannot be inferred from a DNS hostname',async()=>{
  const r=await inspectR51Separation({...e,resolver});
  assert.equal(r.externalProviderOwnershipVerified,false);
  assert.equal(r.externalAnchorWormVerified,undefined);
});
