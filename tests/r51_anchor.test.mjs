import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createR46VaultBackup} from '../src/migration/r46-vault.mjs';
import {synchronizeR47Offsite,readR47SignedRemoteHead,r47TenantToken} from '../src/migration/r47-offsite.mjs';
import {createR48WitnessReceiver} from '../src/migration/r48-witness.mjs';
import {appendR50Evidence,readR50Evidence} from '../src/migration/r50-evidence.mjs';
import {createR51EvidenceAnchorClient,anchorR51Evidence,verifyR51EvidenceAnchor} from '../src/migration/r51-anchor.mjs';

const projectId='11111111-1111-4111-8111-111111111111';
async function setup(){
  const root=await mkdtemp(join(tmpdir(),'ox-r51-anchor-'));
  const vault={directory:join(root,'vault'),projectId,
    manifestSha256:'e'.repeat(64),catalogKey:randomBytes(32),
    keyRing:{activeId:'key_one',keys:{key_one:randomBytes(32)}}};
  await createR46VaultBackup(vault,{plaintext:Buffer.concat([
    Buffer.from('SQLite format 3\0'),randomBytes(6000)])});
  const objects=new Map();
  const remote={put:async(key,data)=>{objects.set(key,Buffer.from(data));return true;},
    get:async key=>{if(!objects.has(key))throw Error('missing remote');return Buffer.from(objects.get(key));}};
  await synchronizeR47Offsite({vault,remote});
  const original=await readR47SignedRemoteHead({vault,remote});
  const witness={verify:async head=>{
    if(head.catalogSha256!==original.catalogSha256)throw Error('signed remote head mismatch');
    return {anchorVerified:true};
  }};
  const tenantToken=r47TenantToken(vault.catalogKey,projectId);
  const evidence={directory:join(root,'evidence'),key:randomBytes(32),tenantToken};
  const token=randomBytes(32).toString('hex'),secret=randomBytes(32),anchorRoot=join(root,'anchor');
  const makeServer=()=>createServer(createR48WitnessReceiver({root:anchorRoot,token,secret}));
  let server=makeServer();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const makeClient=()=>createR51EvidenceAnchorClient({endpoint:'http://127.0.0.1:'+
    server.address().port+'/',token,secret,tenantToken,allowSyntheticLoopback:true});
  const close=async()=>{await new Promise(ok=>server.close(ok));await rm(root,{recursive:true,force:true});};
  return {root,vault,remote,witness,evidence,token,secret,tenantToken,
    anchor:makeClient(),close,restart:async()=>{
      await new Promise(ok=>server.close(ok));server=makeServer();
      await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
      return makeClient();
    }};
}
const pass={verdict:'PASS',reasonCode:'VERIFIED',catalogSha256:'c'.repeat(64),
  witnessConfirmed:true,signedRestoreVerified:true,elapsedMs:110,confirmedAgeMs:1000};
test('R5.1 external anchor confirms signed evidence and persists across receiver restart',async()=>{
  const x=await setup();
  try{
    await appendR50Evidence(x.evidence,pass);
    const ack=await anchorR51Evidence(x);
    assert.equal(ack.anchorVerified,true);
    assert.equal(ack.externalHostOwnershipVerified,false);
    const status=await verifyR51EvidenceAnchor(x);
    assert.equal(status.remoteAnchorVerified,true);
    assert.equal(status.productionCutoverAllowed,false);
    x.anchor=await x.restart();
    assert.equal((await verifyR51EvidenceAnchor(x)).remoteAnchorVerified,true);
  }finally{await x.close();}
});
test('R5.1 rejects previous valid anchor after newer signed ledger publication',async()=>{
  const x=await setup();
  try{
    await appendR50Evidence(x.evidence,pass);
    await anchorR51Evidence(x);
    const before=await readR50Evidence(x.evidence);
    await appendR50Evidence(x.evidence,{...pass,elapsedMs:124});
    await assert.rejects(verifyR51EvidenceAnchor(x),
      /older than or different from independent witness/);
    await anchorR51Evidence(x);
    assert.equal((await verifyR51EvidenceAnchor(x)).remoteAnchorVerified,true);
    await assert.rejects(x.anchor.verify({
      evidenceHeadSha256:before.headSha256,manifestSha256:x.vault.manifestSha256,
      records:before.recordCount}),/older than or different/);
  }finally{await x.close();}
});
test('R5.1 fails on stale evidence or latest FAIL before remote attestation',async()=>{
  const x=await setup();
  try{
    await appendR50Evidence(x.evidence,pass);
    await anchorR51Evidence(x);
    await assert.rejects(verifyR51EvidenceAnchor({...x,now:Date.now()+3600000,
      maxEvidenceAgeMs:60000}),/stale or future-dated/);
    await appendR50Evidence(x.evidence,{...pass,verdict:'FAIL',reasonCode:'RESTORE_REJECTED',
      signedRestoreVerified:false});
    await assert.rejects(anchorR51Evidence(x),/latest signed recovery evidence is not PASS/);
  }finally{await x.close();}
});
test('R5.1 independently keyed anchor refuses forged token or changed ledger key',async()=>{
  const x=await setup();
  try{
    await appendR50Evidence(x.evidence,pass);
    const attacker=createR51EvidenceAnchorClient({endpoint:x.anchor.endpoint,
      token:randomBytes(32).toString('hex'),secret:x.secret,
      tenantToken:x.tenantToken,allowSyntheticLoopback:true});
    await assert.rejects(attacker.current(),/read witness status 401/);
    await assert.rejects(anchorR51Evidence({...x,evidence:{...x.evidence,
      key:randomBytes(32)}}),/ledger HMAC changed/);
  }finally{await x.close();}
});
