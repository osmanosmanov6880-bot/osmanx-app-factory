import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectR50Topology} from '../src/migration/r50-topology.mjs';

const hosts={storage:'s3.example.com',witness:'witness.example.net',alerts:'alerts.example.org'};
const opts={storageEndpoint:'https://'+hosts.storage+'/',
  witnessEndpoint:'https://'+hosts.witness+'/',
  alertEndpoint:'https://'+hosts.alerts+'/'};
const addresses={[hosts.storage]:'8.8.8.8',[hosts.witness]:'1.1.1.1',[hosts.alerts]:'9.9.9.9'};
const resolve=async hostname=>[{address:addresses[hostname],family:4}];
test('R5.0 HTTPS DNS-separated endpoints still cannot self-attest physical independence',async()=>{
  const proof=await inspectR50Topology({...opts,resolver:resolve});
  assert.equal(proof.tlsRequired,true);
  assert.equal(proof.dnsAddressSeparated,true);
  assert.equal(proof.sameHostSimulation,false);
  assert.equal(proof.physicallyIndependentInfrastructureVerified,false);
  assert.equal(proof.providerOwnershipIndependentlyVerified,false);
  assert.equal(proof.productionCutoverAllowed,false);
});
test('R5.0 refuses endpoints sharing the same resolved IP',async()=>{
  const resolver=async host=>[{address:host===hosts.witness?'8.8.8.8':addresses[host],family:4}];
  await assert.rejects(inspectR50Topology({...opts,resolver}),/share DNS addresses/);
});
test('R5.0 rejects loopback, private, CGNAT and documentation networks in external mode',async()=>{
  for(const address of ['127.0.0.1','10.0.0.3','172.18.0.2','192.168.1.2',
    '169.254.1.1','100.64.0.1','192.0.2.5','203.0.113.9','fc00::1','::1']){
    await assert.rejects(inspectR50Topology({...opts,resolver:async host=>[{
      address:host===hosts.storage?address:addresses[host],family:address.includes(':')?6:4}]}),
    /nonpublic or invalid addresses/,address);
  }
});
test('R5.0 rejects alternate ports, credentials, query strings and plain HTTP',async()=>{
  for(const storageEndpoint of [
    'http://s3.example.com/','https://foo:bar@s3.example.com/',
    'https://s3.example.com:8443/','https://s3.example.com/?token=x',
    'https://s3.example.com/folder/','https://127.0.0.1/'
  ]){
    await assert.rejects(inspectR50Topology({...opts,storageEndpoint,resolver:resolve}),
      /R5.0 topology refused/,storageEndpoint);
  }
});
test('R5.0 permits explicitly isolated loopback simulation without claiming independence',async()=>{
  const simulation=await inspectR50Topology({
    storageEndpoint:'http://127.0.0.1:9000/',
    witnessEndpoint:'http://127.0.0.1:9080/',
    alertEndpoint:'http://127.0.0.1:9100/',
    resolver:async()=>[{address:'127.0.0.1',family:4}],
    allowSyntheticLoopback:true});
  assert.equal(simulation.syntheticOnly,true);
  assert.equal(simulation.dnsAddressSeparated,false);
  assert.equal(simulation.physicallyIndependentInfrastructureVerified,false);
});
test('R5.0 fails closed when DNS lookup is unavailable or invalid',async()=>{
  await assert.rejects(inspectR50Topology({...opts,resolver:async()=>{throw Error('timeout');}}),
    /DNS lookup failed/);
  await assert.rejects(inspectR50Topology({...opts,resolver:async()=>[]}),
    /lookup missing/);
});
