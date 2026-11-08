import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {createR58IncidentEvidence,verifyR58IncidentEvidence}
  from '../src/migration/r58-incident-evidence.mjs';
const TENANT='d'.repeat(24),KEY=randomBytes(32),
  SHA=b=>createHash('sha256').update(b).digest('hex');
function fixture(pending){
  const body=Buffer.from('signed remote checkpoint');
  const digest=SHA(body);
  let writes=0;
  return {
    get writes(){return writes;},
    coordinator:{
      async inspect(){return {
        epoch:7,active:pending,pending,pendingEpoch:pending?7:null,
        committed:{operation:'f'.repeat(32),sha256:digest,
          versionId:'v3',epoch:6}
      };},
      async publish(){writes++;throw Error('incident evidence may not publish');}
    },
    witness:{async current(){
      return {entries:3,catalogSha256:digest,manifestSha256:'a'.repeat(64)};
    }},
    remote:{
      async getWithMetadata(){return {body,etag:'"'+digest+'"',versionId:'v3'};},
      async inspectR49Worm(){
        return {objectLockVerified:true,retentionMode:'COMPLIANCE',versionId:'v3'};
      },
      async put(){writes++;throw Error('incident evidence may not write S3');}
    }
  };
}
test('R5.8 emits signed incident evidence without mutating S3 or PostgreSQL',async()=>{
  const f=fixture(true);
  const packet=await createR58IncidentEvidence({
    tenantId:TENANT,coordinator:f.coordinator,witness:f.witness,
    remote:f.remote,signingKey:KEY,syntheticOnly:true
  });
  assert.equal(packet.checkpoint.pending,true);
  assert.equal(packet.automaticUnquarantineForbidden,true);
  assert.equal(packet.witness.sequence,3);
  assert.equal(packet.s3.versionId,'v3');
  assert.equal(f.writes,0);
  const verified=verifyR58IncidentEvidence({
    packet,signingKey:KEY,tenantId:TENANT
  });
  assert.equal(verified.signatureVerified,true);
  assert.equal(verified.nonAuthoritativeDiagnosticOnly,true);
});
test('R5.8 detects falsified checkpoint, WORM or witness values',async()=>{
  const f=fixture(false),packet=await createR58IncidentEvidence({
    tenantId:TENANT,coordinator:f.coordinator,witness:f.witness,
    remote:f.remote,signingKey:KEY,syntheticOnly:true
  });
  for(const change of [
    {checkpoint:{...packet.checkpoint,pending:true}},
    {s3:{...packet.s3,versionId:'fake'}},
    {witness:{...packet.witness,sequence:500}},
    {automaticUnquarantineForbidden:false}
  ]){
    assert.throws(()=>verifyR58IncidentEvidence({
      packet:{...packet,...change},signingKey:KEY,tenantId:TENANT
    }),/tampered/);
  }
  assert.throws(()=>verifyR58IncidentEvidence({
    packet,signingKey:randomBytes(32),tenantId:TENANT
  }),/tampered/);
});
test('R5.8 rejects expired incident evidence and cross-tenant replay',async()=>{
  const f=fixture(false),now=Date.now();
  const packet=await createR58IncidentEvidence({
    tenantId:TENANT,coordinator:f.coordinator,witness:f.witness,
    remote:f.remote,signingKey:KEY,now:()=>now,syntheticOnly:true
  });
  assert.throws(()=>verifyR58IncidentEvidence({
    packet,signingKey:KEY,tenantId:TENANT,
    now:()=>now+600000,maxAgeMs:300000
  }),/expired/);
  assert.throws(()=>verifyR58IncidentEvidence({
    packet,signingKey:KEY,tenantId:'a'.repeat(24)
  }),/cross-tenant/);
});
test('R5.8 refuses false WORM compliance even if S3 pointer bytes match',async()=>{
  const f=fixture(true);
  f.remote.inspectR49Worm=async()=>({
    objectLockVerified:false,retentionMode:'GOVERNANCE',versionId:'v3'
  });
  await assert.rejects(createR58IncidentEvidence({
    tenantId:TENANT,coordinator:f.coordinator,witness:f.witness,
    remote:f.remote,signingKey:KEY,syntheticOnly:true
  }),/not verified WORM/);
});
