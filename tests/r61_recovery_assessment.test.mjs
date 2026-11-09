import test from 'node:test';
import assert from 'node:assert/strict';
import {createR61RecoveryAssessment}
  from '../src/migration/r61-recovery-assessment.mjs';
const TENANT='a'.repeat(24),INCIDENT='b'.repeat(32),
  HASH='c'.repeat(64),MANIFEST='d'.repeat(64),OLD='version-1';
function fixture({changed=false,noPending=false,missingVersion=false,
  badWitness=false,auditUnavailable=false,forensicUnavailable=false}={}){
  let calls=0,writes=0;
  const pool={async query(sql,args){
    assert(sql.startsWith('SELECT '));
    assert.deepEqual(args,[TENANT]);
    calls++;
    return {rows:[{epoch:9,pending_op:noPending?null:'e'.repeat(32),
      pending_sha:noPending?null:changed&&calls>1?'f'.repeat(64):HASH,
      pending_epoch:noPending?null:9,pending_before_version:noPending?null:OLD}]};
  }};
  const forensics={tenantId:TENANT,readonly:true,
    async investigate({pendingSha256,previousVersionId}){
      assert.equal(pendingSha256,HASH);
      assert.equal(previousVersionId,OLD);
      if(forensicUnavailable)throw Error('synthetic S3 503');
      return {tenantId:TENANT,canUnquarantine:false,
        reviewedVersions:missingVersion?[]:[{
          versionId:'version-2',isLatest:true,sha256:HASH,
          retentionMode:'COMPLIANCE'
        }],
        matchingPendingVersions:missingVersion?[]:['version-2']};
    },
    async put(){writes++;throw Error('read only');}
  };
  const witness={
    async current(){return {entries:7,manifestSha256:MANIFEST,
      catalogSha256:badWitness?'f'.repeat(64):HASH};},
    async verify(args){
      assert.equal(args.catalogSha256,HASH);
      return {anchorVerified:true,catalogSha256:HASH};
    }
  };
  const auditAnchor={tenantId:TENANT,
    async verifyAgainstLedger(key){
      assert.match(key,/^r60\/audit\/[a-f0-9]{64}\.json$/);
      if(auditUnavailable)throw Error('WORM denied');
      return {anchored:true,providerWormVerified:true,
        productionCutoverAllowed:false};
    }
  };
  const service=createR61RecoveryAssessment({
    tenantId:TENANT,pool,forensics,witness,auditAnchor,
    auditObjectKey:'r60/audit/'+'1'.repeat(64)+'.json',
    manifestSha256:MANIFEST
  });
  return {service,get calls(){return calls;},get writes(){return writes;}};
}
test('R6.1 coherent PG/S3/WORM/witness only produces a manual-review assessment',
  async()=>{
    const f=fixture(),report=await f.service.assess({incidentId:INCIDENT});
    assert.equal(report.classification,'consistent-evidence-manual-review');
    assert.equal(report.s3VerifiedVersion,'version-2');
    assert.equal(report.witnessVerified,true);
    assert.equal(report.auditWormVerified,true);
    assert.equal(report.stateUnchangedDuringObservation,true);
    assert.equal(report.sourceObservationsNonAtomic,true);
    assert.equal(report.mayClearPendingIntent,false);
    assert.equal(report.mayWriteS3,false);
    assert.equal(report.mayPromotePg,false);
    assert.equal(report.productionCutoverAllowed,false);
    assert.match(report.reportSha256,/^[a-f0-9]{64}$/);
    assert.equal(f.calls,2);
    assert.equal(f.writes,0);
});
test('R6.1 fails closed on S3 missing version, witness conflict or WORM audit loss',
  async()=>{
    const cases=[
      [{missingVersion:true},'ambiguous-s3-version'],
      [{badWitness:true},'witness-not-aligned'],
      [{auditUnavailable:true},'audit-anchor-unavailable'],
      [{forensicUnavailable:true},'s3-forensics-unavailable']
    ];
    for(const [options,expected] of cases){
      const f=fixture(options);
      const report=await f.service.assess({incidentId:INCIDENT});
      assert.equal(report.classification,expected);
      assert.equal(report.mayClearPendingIntent,false);
      assert.equal(f.writes,0);
    }
});
test('R6.1 rejects evidence snapshots changed by a concurrent checkpoint writer',
  async()=>{
    const f=fixture({changed:true});
    await assert.rejects(f.service.assess({incidentId:INCIDENT}),
      /changed during non-atomic evidence collection/);
});
test('R6.1 without pending intent cannot create a new publisher lease',
  async()=>{
    const f=fixture({noPending:true});
    const report=await f.service.assess({incidentId:INCIDENT});
    assert.equal(report.classification,'no-pending-intent');
    assert.equal(report.mayClearPendingIntent,false);
    assert.equal(report.mayPromotePg,false);
    assert.equal(f.writes,0);
});
test('R6.1 constructor refuses tenant impersonation and unverified forensic adapters',
  ()=>{
    const f=fixture();
    assert.throws(()=>createR61RecoveryAssessment({
      tenantId:'../other',pool:{query(){}},forensics:{},
      witness:{},auditAnchor:{}
    }),/tenant-pinned/);
    assert.equal(f.service.productionCutoverAllowed,false);
});
