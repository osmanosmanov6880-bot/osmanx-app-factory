import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createR48S3Transport} from '../src/migration/r48-s3.mjs';
import {createR60S3VersionForensics}
  from '../src/migration/r60-s3-version-forensics.mjs';
import {examineR62S3Lineage}
  from '../src/migration/r62-s3-lineage.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const enabled=process.env.OX_R62_MINIO_E2E==='YES'&&
  process.env.OX_R40_EPHEMERAL==='YES'&&
  process.env.OX_R62_LAB_ACK==='YES';
test('R6.2 real versioned COMPLIANCE MinIO detects new pointer forks without authorizing recovery',
  {skip:!enabled,timeout:40000},async()=>{
    const tenantId=randomBytes(12).toString('hex');
    const config={
      endpoint:process.env.OX_R62_MINIO_ENDPOINT,
      bucket:process.env.OX_R62_MINIO_BUCKET,
      region:'us-east-1',
      accessKey:process.env.OX_R62_MINIO_ACCESS_KEY,
      secretKey:process.env.OX_R62_MINIO_SECRET_KEY
    };
    const transport=createR48S3Transport({
      ...config,projectPrefix:tenantId+'/',allowSyntheticLoopback:true
    });
    const viewer=createR60S3VersionForensics({
      ...config,tenantId,allowSyntheticLoopback:true
    });
    const old=Buffer.from('R6.2 signed synthetic pointer prior'),
      pending=Buffer.from('R6.2 signed synthetic pointer after'),
      unknown=Buffer.from('R6.2 synthetic foreign writer version');
    await transport.assertBucketControls();
    await transport.put('r53/head.json',old,{ifNoneMatch:true});
    const first=await transport.getWithMetadata('r53/head.json');
    assert(first.versionId);
    await transport.put('r53/head.json',pending,{ifMatch:first.etag});
    const second=await transport.getWithMetadata('r53/head.json');
    assert.notEqual(second.versionId,first.versionId);
    const report=await viewer.investigate({
      pendingSha256:sha(pending),previousVersionId:first.versionId
    });
    const values={tenantId,pending:{
      epoch:12,sha256:sha(pending),beforeVersion:first.versionId
    },committed:{versionId:first.versionId,sha256:sha(old)},
      forensics:report,witness:{entries:7,catalogSha256:sha(pending)},
      witnessVerified:true};
    const firstReview=examineR62S3Lineage(values);
    assert.equal(firstReview.classification,'coherent-manual-review');
    assert.equal(firstReview.selectedPendingVersionId,second.versionId);
    assert.equal(firstReview.mayClearPendingIntent,false);
    await transport.put('r53/head.json',unknown,{ifMatch:second.etag});
    const later=await viewer.investigate({
      pendingSha256:sha(pending),previousVersionId:first.versionId
    });
    const fork=examineR62S3Lineage({...values,forensics:later});
    assert.equal(fork.classification,'superseded-or-forked-pointer');
    assert.equal(fork.ambiguous,true);
    assert.equal(fork.mayClearPendingIntent,false);
    assert.equal(fork.productionCutoverAllowed,false);
  });
