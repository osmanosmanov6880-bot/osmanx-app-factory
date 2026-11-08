import test from 'node:test';
import assert from 'node:assert/strict';
import {createR57ScopedS3Capabilities,createR57S3IamPolicies}
  from '../src/migration/r57-s3-scope.mjs';

const TENANT='e'.repeat(24),HEAD='r53/head.json',
  SEG='r53/segments/'+'f'.repeat(64)+'.oxd';
function fixture(){
  const writes=[];
  const raw={
    tenantPrefix:TENANT+'/',
    async put(key,body,opts){writes.push({key,body,opts});return true;},
    async get(){return Buffer.from('ciphertext');},
    async getWithMetadata(){return {body:Buffer.from('signed'),etag:'"abc"',versionId:'1'};},
    async inspectR49Worm(){return {objectLockVerified:true,retentionMode:'COMPLIANCE',versionId:'1'};},
    async assertBucketControls(){return {objectLockEnabled:true,versioningEnabled:true};}
  };
  return {writes,...createR57ScopedS3Capabilities({transport:raw,tenantId:TENANT})};
}
test('R5.7 publisher capability cannot PUT mutable checkpoint',async()=>{
  const {publisher,writes}=fixture();
  await assert.rejects(publisher.put(HEAD,Buffer.from('forged'),{ifNoneMatch:true}),
    /cannot PUT the mutable/);
  await publisher.put(SEG,Buffer.from('immutable encrypted segment'));
  assert.equal(writes.length,1);assert.equal(writes[0].key,SEG);
  await assert.rejects(publisher.put('head.json',Buffer.from('forged')),/cannot PUT/);
});
test('R5.7 coordinator capability cannot write a segment or an unconditional HEAD',async()=>{
  const {coordinator,writes}=fixture();
  await assert.rejects(coordinator.put(SEG,Buffer.from('bad'),{ifNoneMatch:true}),
    /conditional HEAD/);
  await assert.rejects(coordinator.put(HEAD,Buffer.from('bad')),/conditional HEAD/);
  await coordinator.put(HEAD,Buffer.from('signed'),{ifNoneMatch:true});
  assert.equal(writes.length,1);assert.equal(writes[0].key,HEAD);
});
test('R5.7 denies transport from another tenant prefix',()=>{
  assert.throws(()=>createR57ScopedS3Capabilities({
    transport:{tenantPrefix:'c'.repeat(24)+'/'},tenantId:TENANT
  }),/verified tenant-prefixed/);
});
test('R5.7 IAM policy grants segment PUT to worker and HEAD PUT only to coordinator',()=>{
  const policies=createR57S3IamPolicies({bucket:'synthetic-worm-tenant',tenantId:TENANT});
  const worker=policies.publisher.Statement.filter(s=>s.Action.includes('s3:PutObject'));
  const control=policies.coordinator.Statement.filter(s=>s.Action.includes('s3:PutObject'));
  assert.equal(worker.length,1);assert.equal(control.length,1);
  assert.equal(worker[0].Resource,
    'arn:aws:s3:::synthetic-worm-tenant/'+TENANT+'/r53/segments/*');
  assert.equal(control[0].Resource,
    'arn:aws:s3:::synthetic-worm-tenant/'+TENANT+'/'+HEAD);
  assert.equal(policies.privilegesApplied,false);
  assert.equal(policies.requiresDistinctCredentials,true);
});
test('R5.7 IAM rejects wildcards, wrong tenant and wildcard bucket',()=>{
  for(const bucket of ['*','any*','bad..name','A-BUCKET']){
    assert.throws(()=>createR57S3IamPolicies({bucket,tenantId:TENANT}));
  }
  assert.throws(()=>createR57S3IamPolicies({
    bucket:'synthetic-valid-bucket',tenantId:'../other'
  }));
});
