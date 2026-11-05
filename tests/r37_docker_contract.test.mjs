import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {assertNoPublishedPorts,dockerSyntheticTraffic} from '../scripts/r37_docker_e2e.mjs';
const src=process.cwd();
const p=type=>({id:randomUUID(),name:'R37 Test',type,industry:type==='site'?'business':'restaurant',
  modules:type==='site'?['auth','cms','leads']:['auth','clients','tasks'],
  settings:{accent:'#777777',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]});
test('R3.7: exporter packs and hashes the new edge and incident modules in CRM and site',async()=>{
 for(const type of ['crm','site']){
  const files=parseStoredZip(await exportDeploymentBundle(p(type),src,'osmanx.company.org'),{maxFiles:400,maxBytes:90e6});
  const meta=JSON.parse(files.get('deploy/manifest.json').toString());
  for(const path of ['deploy/edge-audit.mjs','deploy/incident-evidence.mjs','deploy/verify-live.mjs','deploy/upgrade.mjs']){
    assert.ok(files.has(path),type+':'+path);
    assert.equal(createHash('sha256').update(files.get(path)).digest('hex'),meta.files[path]);
  }
  assert.ok(!files.has('.env'));assert.ok(!files.has('.osmanx-fleet/agent-private.pem'));
 }
});
test('R3.7: Docker rejects any published host port and unknown app types without Docker installed',async()=>{
 assertNoPublishedPorts({'4180/tcp':null});assertNoPublishedPorts({'4180/tcp':[]});
 assert.throws(()=>assertNoPublishedPorts({'4180/tcp':[{HostPort:'4180'}]}),/host port/);
 assert.throws(()=>assertNoPublishedPorts(null),/inventory/);
 await assert.rejects(dockerSyntheticTraffic('production'),/Unknown synthetic/);
});
test('R3.7: simulated failing Docker startup performs cleanup and does not claim success',async()=>{
 const calls=[];const fake=(args)=>{
  calls.push(args.join(' '));
  if(args.join(' ').includes('compose up -d --build'))throw Error('synthetic startup failure');
  return '';
 };
 await assert.rejects(dockerSyntheticTraffic('crm',{exec:fake}),/synthetic startup failure/);
 assert.ok(calls.some(x=>x.includes('compose down --volumes --remove-orphans')));
});
