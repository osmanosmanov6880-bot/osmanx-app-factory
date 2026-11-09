import test from 'node:test';
import assert from 'node:assert/strict';
import {examineR62S3Lineage} from '../src/migration/r62-s3-lineage.mjs';
const TENANT='a'.repeat(24),OLD='b'.repeat(64),
  NEW='c'.repeat(64),FORK='d'.repeat(64);
function version(versionId,sha256,isLatest){
  return {versionId,sha256,isLatest,retentionMode:'COMPLIANCE',
    retainedUntil:'2090-01-01T00:00:00.000Z',
    lastModified:'2026-11-09T00:00:00.000Z'};
}
function fixture(overrides={}){
  const before=version('prior-v1',OLD,false),
    current=version('pending-v2',NEW,true);
  const versions=overrides.versions||[current,before];
  return {
    tenantId:TENANT,pending:{epoch:9,sha256:NEW,beforeVersion:'prior-v1'},
    committed:{versionId:'prior-v1',sha256:OLD},
    forensics:{
      format:'osmanx-r60-version-forensic-v1',
      tenantId:TENANT,canUnquarantine:false,
      requiresManualWitnessReview:true,
      reviewedVersions:versions,
      matchingPendingVersions:versions.filter(v=>
        v.sha256===NEW&&v.versionId!=='prior-v1').map(v=>v.versionId)
    },
    witness:{entries:5,catalogSha256:NEW},
    witnessVerified:true,...overrides
  };
}
test('R6.2 exact predecessor, unique latest COMPLIANCE version and witness require manual review',
  ()=>{
    const result=examineR62S3Lineage(fixture());
    assert.equal(result.classification,'coherent-manual-review');
    assert.equal(result.observedWormVersions,2);
    assert.equal(result.previousVersionConfirmed,true);
    assert.equal(result.ambiguous,false);
    assert.equal(result.independentWitnessVerified,true);
    assert.equal(result.mayClearPendingIntent,false);
    assert.equal(result.mayWriteS3,false);
    assert.equal(result.productionCutoverAllowed,false);
  });
test('R6.2 multiple S3 versions with identical pending bytes are ambiguous',
  ()=>{
    const versions=[
      version('pending-v3',NEW,true),version('pending-v2',NEW,false),
      version('prior-v1',OLD,false)
    ];
    const result=examineR62S3Lineage(fixture({versions}));
    assert.equal(result.classification,'multiple-retained-candidates');
    assert.equal(result.selectedPendingVersionId,null);
    assert.equal(result.ambiguous,true);
  });
test('R6.2 S3 pointer overwrite hides pending, no automatic recovery',
  ()=>{
    const versions=[
      version('unrelated-v3',FORK,true),
      version('pending-v2',NEW,false),
      version('prior-v1',OLD,false)
    ];
    const result=examineR62S3Lineage(fixture({versions}));
    assert.equal(result.classification,'superseded-or-forked-pointer');
    assert.equal(result.mayAdvanceCheckpoint,false);
  });
test('R6.2 previous version missing or different from PG committed lineage',
  ()=>{
    const missing=examineR62S3Lineage(fixture({
      versions:[version('pending-v2',NEW,true)]
    }));
    assert.equal(missing.classification,'missing-previous-version');
    const wrong=examineR62S3Lineage(fixture({
      committed:{versionId:'prior-v1',sha256:FORK}
    }));
    assert.equal(wrong.classification,'previous-commit-mismatch');
  });
test('R6.2 missing pending version or witness signature flags independent ambiguity',
  ()=>{
    const empty=examineR62S3Lineage(fixture({
      versions:[version('unrelated-v3',FORK,true),version('prior-v1',OLD,false)]
    }));
    assert.equal(empty.classification,'pending-version-unobserved');
    const witness=examineR62S3Lineage(fixture({witnessVerified:false}));
    assert.equal(witness.classification,'independent-witness-not-aligned');
    const forged=examineR62S3Lineage(fixture({
      witness:{entries:5,catalogSha256:FORK}
    }));
    assert.equal(forged.classification,'independent-witness-not-aligned');
  });
test('R6.2 tampered forensic candidate set, expired WORM and duplicate IDs reject proof',
  ()=>{
    const bad=fixture();
    bad.forensics.matchingPendingVersions=['untrusted-v9'];
    assert.throws(()=>examineR62S3Lineage(bad),/candidate set/);
    const expired=fixture({
      versions:[{...version('pending-v2',NEW,true),
        retainedUntil:'2000-01-01T00:00:00.000Z'},
      version('prior-v1',OLD,false)]
    });
    assert.throws(()=>examineR62S3Lineage(expired),/unretained/);
    assert.throws(()=>examineR62S3Lineage(fixture({
      versions:[version('pending-v2',NEW,true),
        version('pending-v2',OLD,false)]
    })),/duplicate version ID/);
  });
test('R6.2 foreign tenant and two latest markers cannot pass',()=>{
  const foreign=fixture();
  foreign.forensics.tenantId='f'.repeat(24);
  assert.throws(()=>examineR62S3Lineage(foreign),/tenant-pinned/);
  assert.throws(()=>examineR62S3Lineage(fixture({
    versions:[version('pending-v2',NEW,true),
      version('prior-v1',OLD,true)]
  })),/conflicting latest/);
});
