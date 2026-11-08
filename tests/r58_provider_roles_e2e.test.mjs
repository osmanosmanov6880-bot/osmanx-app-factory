// Opt-in provider-level IAM proof against a freshly allocated disposable
// bucket/prefix with genuinely separate remote S3 access keys.
// Deliberately skipped when independent credentials were not provisioned.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createR48S3Transport} from '../src/migration/r48-s3.mjs';
import {attestR58ProviderRoleIsolation}
  from '../src/migration/r58-iam-attestation.mjs';
const enabled=process.env.OX_R58_PROVIDER_ROLE_E2E==='YES';
test('R5.8 remote S3 independently denies worker HEAD and coordinator segment PUT',
  {skip:!enabled,timeout:45000},async()=>{
    assert.equal(process.env.OX_R58_DISPOSABLE_BUCKET_CONFIRMED,'YES');
    const tenantId=process.env.OX_R58_PROVIDER_TENANT;
    assert.match(tenantId,/^[a-f0-9]{24}$/);
    assert.match(process.env.OX_R58_PROVIDER_BUCKET,
      /^(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/);
    assert.notEqual(process.env.OX_R58_WORKER_ACCESS_KEY,
      process.env.OX_R58_COORDINATOR_ACCESS_KEY);
    const options={
      endpoint:process.env.OX_R58_PROVIDER_ENDPOINT,
      bucket:process.env.OX_R58_PROVIDER_BUCKET,
      region:process.env.OX_R58_PROVIDER_REGION||'us-east-1',
      projectPrefix:tenantId+'/',
      allowSyntheticLoopback:process.env.OX_R58_LOOPBACK_TEST==='YES'
    };
    const worker=createR48S3Transport({
      ...options,accessKey:process.env.OX_R58_WORKER_ACCESS_KEY,
      secretKey:process.env.OX_R58_WORKER_SECRET_KEY
    });
    const coordinator=createR48S3Transport({
      ...options,accessKey:process.env.OX_R58_COORDINATOR_ACCESS_KEY,
      secretKey:process.env.OX_R58_COORDINATOR_SECRET_KEY
    });
    const report=await attestR58ProviderRoleIsolation({
      tenantId,workerTransport:worker,coordinatorTransport:coordinator,
      syntheticOnly:true,disposableBucketConfirmed:true
    });
    assert.equal(report.workerDeniedHeadPut403,true);
    assert.equal(report.coordinatorDeniedSegmentPut403,true);
    assert.equal(report.workerWormSegmentPut,true);
    assert.equal(report.coordinatorConditionalHeadPut,true);
  });
