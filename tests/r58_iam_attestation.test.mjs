import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {attestR58ProviderRoleIsolation}
  from '../src/migration/r58-iam-attestation.mjs';
const TENANT='c'.repeat(24);
const sha=b=>createHash('sha256').update(b).digest('hex');
function fixture({permitWorkerHead=false,denyWorkerHeadWithCas=false,
  permitCoordinatorSegment=false}={}){
  let head=null,segment=null,version=0;
  const base={
    tenantPrefix:TENANT+'/',
    async assertBucketControls(){
      return {objectLockEnabled:true,versioningEnabled:true};
    },
    async getWithMetadata(){
      if(!head)throw Error('R4.8 S3 denied: GET status 404');
      return {body:Buffer.from(head),etag:'"'+sha(head)+'"',versionId:'v'+version};
    },
    async inspectR49Worm(){
      return {objectLockVerified:true,retentionMode:'COMPLIANCE',
        versionId:'v'+version};
    }
  };
  const worker={...base,async put(key,data){
    if(key==='r53/head.json'&&!permitWorkerHead){
      if(denyWorkerHeadWithCas)
        throw Error('R4.8 S3 denied: conditional CDC pointer compare-and-swap conflict');
      throw Error('R4.8 S3 denied: PUT status 403');
    }
    if(key==='r53/head.json')head=Buffer.from(data);
    else segment=Buffer.from(data);
    version++;return true;
  }};
  const coordinator={...base,async put(key,data){
    if(key.startsWith('r53/segments/')&&!permitCoordinatorSegment)
      throw Error('R4.8 S3 denied: PUT status 403');
    if(key==='r53/head.json')head=Buffer.from(data);
    else segment=Buffer.from(data);
    version++;return true;
  }};
  return {worker,coordinator,get head(){return head;},get segment(){return segment;}};
}
const attest=(f)=>attestR58ProviderRoleIsolation({
  tenantId:TENANT,workerTransport:f.worker,
  coordinatorTransport:f.coordinator,
  syntheticOnly:true,disposableBucketConfirmed:true
});
test('R5.8 provider challenge requires two observed 403 denials and successful allowed WORM writes',
  async()=>{
    const f=fixture();
    const result=await attest(f);
    assert.equal(result.workerDeniedHeadPut403,true);
    assert.equal(result.coordinatorDeniedSegmentPut403,true);
    assert.equal(result.workerWormSegmentPut,true);
    assert.equal(result.coordinatorConditionalHeadPut,true);
    assert(f.head&&f.segment);
    assert.equal(result.productionCutoverAllowed,false);
  });
test('R5.8 a worker allowed to write HEAD fails real-permission challenge',async()=>{
  const f=fixture({permitWorkerHead:true});
  await assert.rejects(attest(f),/not denied by S3 provider with status 403/);
});
test('R5.8 S3 CAS 409/412 cannot masquerade as IAM 403',async()=>{
  const f=fixture({denyWorkerHeadWithCas:true});
  await assert.rejects(attest(f),/compare-and-swap conflict/);
});
test('R5.8 coordinator allowed to create segments fails separation challenge',async()=>{
  const f=fixture({permitCoordinatorSegment:true});
  await assert.rejects(attest(f),/not denied by S3 provider with status 403/);
});
test('R5.8 aborts if tenant head exists or disposable assertion is missing',async()=>{
  const f=fixture();
  await f.coordinator.put('r53/head.json',Buffer.from('existing'),{ifNoneMatch:true});
  await assert.rejects(attest(f),/existing HEAD/);
  const other=fixture();
  await assert.rejects(attestR58ProviderRoleIsolation({
    tenantId:TENANT,workerTransport:other.worker,
    coordinatorTransport:other.coordinator,syntheticOnly:true
  }),/explicit test authorization/);
});
test('R5.8 refuses a single S3 credential reused as both roles',async()=>{
  const f=fixture();
  await assert.rejects(attestR58ProviderRoleIsolation({
    tenantId:TENANT,workerTransport:f.worker,
    coordinatorTransport:f.worker,syntheticOnly:true,
    disposableBucketConfirmed:true
  }),/separate real S3 clients/);
});
