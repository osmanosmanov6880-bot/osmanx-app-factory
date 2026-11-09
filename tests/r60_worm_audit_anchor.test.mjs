import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {createR60AuditS3Capability,createR60WormAuditAnchor,
  createR60AuditIamPolicy} from '../src/migration/r60-worm-audit-anchor.mjs';
const TENANT='b'.repeat(24);
function fixture({worm=true,corrupt=false}={}){
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  let sequence=3,tipMac='d'.repeat(64),version=0;
  const objects=new Map(),writes=[];
  const raw={
    tenantPrefix:TENANT+'/',
    async assertBucketControls(){
      return {objectLockEnabled:true,versioningEnabled:true};
    },
    async put(key,body){
      assert.match(key,/^r60\/audit\/[a-f0-9]{64}\.json$/);
      if(objects.has(key))throw Error('immutable key collision');
      objects.set(key,Buffer.from(body));
      writes.push(key);version++;
      return true;
    },
    async getWithMetadata(key){
      if(!objects.has(key))throw Error('R4.8 S3 denied: GET status 404');
      const bytes=Buffer.from(objects.get(key));
      if(corrupt)bytes[3]^=1;
      return {body:bytes,versionId:'synthetic-v'+version};
    },
    async inspectR49Worm(){
      return {objectLockVerified:worm,retentionMode:worm?'COMPLIANCE':'GOVERNANCE',
        versionId:'synthetic-v'+version,retentionUntil:'2090-01-01T00:00:00.000Z'};
    }
  };
  const remote=createR60AuditS3Capability({transport:raw,tenantId:TENANT});
  const ledger={tenantId:TENANT,async verify(){
    return {verified:true,count:sequence,tipMac};
  }};
  const anchor=createR60WormAuditAnchor({
    tenantId:TENANT,ledger,remote,reviewerPrivateKey:privateKey,
    reviewerPublicKey:publicKey,reviewerId:'independent_audit',
    syntheticOnly:true
  });
  return {raw,remote,ledger,anchor,writes,
    append(){sequence++;tipMac='e'.repeat(64);},
    get stored(){return objects;}
  };
}
test('R6.0 immutable audited snapshot is signed, content-addressed and version WORM verified',
  async()=>{
    const f=fixture(),receipt=await f.anchor.anchor();
    assert.equal(receipt.anchored,true);
    assert.equal(receipt.providerWormVerified,true);
    assert.equal(receipt.independentExternalWitnessVerified,false);
    assert.equal(receipt.sequence,3);
    assert.equal(receipt.productionCutoverAllowed,false);
    const verified=await f.anchor.verifyAgainstLedger(receipt.objectKey);
    assert.equal(verified.digest,receipt.digest);
    assert.equal(f.writes.length,1);
  });
test('R6.0 audit credentials cannot modify mutable S3 checkpoint or worker encrypted segment',
  async()=>{
    const f=fixture(),key='r53/head.json';
    await assert.rejects(f.remote.put(key,Buffer.from('forged')),/audit role may only/);
    await assert.rejects(f.remote.getWithMetadata(key),/audit role may only/);
    await assert.rejects(f.remote.put('r53/segments/'+'a'.repeat(64)+'.oxd',
      Buffer.from('forged')),/audit role may only/);
    const policy=createR60AuditIamPolicy({
      tenantId:TENANT,bucket:'r60-disposable-worm'
    });
    const p=policy.Statement.find(x=>x.Action.includes('s3:PutObject'));
    assert.equal(p.Resource,
      'arn:aws:s3:::r60-disposable-worm/'+TENANT+'/r60/audit/*');
  });
test('R6.0 previously signed WORM snapshot cannot attest a newer journal tip',
  async()=>{
    const f=fixture(),receipt=await f.anchor.anchor();
    f.append();
    await assert.rejects(f.anchor.verifyAgainstLedger(receipt.objectKey),
      /remote audit tip differs/);
  });
test('R6.0 tampered object, revoked WORM and missing object version fail closed',
  async()=>{
    for(const options of [{worm:false},{corrupt:true}]){
      const f=fixture(options);
      await assert.rejects(f.anchor.anchor());
    }
  });
test('R6.0 audit sink rejects another tenant prefix and missing signer',()=>{
  assert.throws(()=>createR60AuditS3Capability({
    transport:{tenantPrefix:'c'.repeat(24)+'/'},tenantId:TENANT
  }),/tenant-pinned independent/);
  const f=fixture();
  assert.throws(()=>createR60WormAuditAnchor({
    tenantId:TENANT,ledger:f.ledger,remote:f.remote,
    reviewerId:'independent_audit',syntheticOnly:true
  }),/separate audit reviewer signer/);
});
