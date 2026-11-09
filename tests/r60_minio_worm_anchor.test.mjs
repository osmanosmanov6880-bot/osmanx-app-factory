// R6.0 isolated real MinIO WORM audit anchor check. No production data.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {createR48S3Transport} from '../src/migration/r48-s3.mjs';
import {createR60AuditS3Capability,createR60WormAuditAnchor}
  from '../src/migration/r60-worm-audit-anchor.mjs';
const enabled=process.env.OX_R60_MINIO_E2E==='YES'&&
  process.env.OX_R40_EPHEMERAL==='YES';
test('R6.0 real versioned COMPLIANCE MinIO retains independent audit anchor bytes',
  {skip:!enabled,timeout:30000},async()=>{
    const tenantId=randomBytes(12).toString('hex');
    const transport=createR48S3Transport({
      endpoint:process.env.OX_R60_MINIO_ENDPOINT,
      bucket:process.env.OX_R60_MINIO_BUCKET,
      region:'us-east-1',
      accessKey:process.env.OX_R60_MINIO_ACCESS_KEY,
      secretKey:process.env.OX_R60_MINIO_SECRET_KEY,
      projectPrefix:tenantId+'/',allowSyntheticLoopback:true
    });
    const remote=createR60AuditS3Capability({transport,tenantId});
    const {publicKey,privateKey}=generateKeyPairSync('ed25519');
    const ledger={tenantId,async verify(){
      return {verified:true,count:14,tipMac:'a'.repeat(64)};
    }};
    const anchor=createR60WormAuditAnchor({
      tenantId,ledger,remote,reviewerPrivateKey:privateKey,
      reviewerPublicKey:publicKey,reviewerId:'isolated_auditor',
      syntheticOnly:true
    });
    const first=await anchor.anchor();
    assert.equal(first.providerWormVerified,true);
    assert.match(first.versionId,/^[a-zA-Z0-9_.-]+$/);
    assert.equal(first.sequence,14);
    const second=await anchor.verifyAgainstLedger(first.objectKey);
    assert.equal(second.versionId,first.versionId);
    assert.equal(second.digest,first.digest);
    assert.equal(second.productionCutoverAllowed,false);
    await assert.rejects(remote.put('r53/head.json',
      Buffer.from('must-not-write-head')),/audit role may only/);
  });
