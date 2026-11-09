import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {createR61RecoveryAssessment} from '../src/migration/r61-recovery-assessment.mjs';
import {createR61PgIncidentStore} from '../src/migration/r61-pg-incident-store.mjs';
import {signR61Approval} from '../src/migration/r61-dual-approval.mjs';
const enabled=process.env.OX_R61_PG_E2E==='YES';
function config(){return{
  host:process.env.PGHOST||'127.0.0.1',
  port:Number(process.env.PGPORT||5432),
  user:process.env.PGUSER||'postgres',
  password:process.env.PGPASSWORD||'',
  database:process.env.PGDATABASE||'ox_r61',
  max:5,connectionTimeoutMillis:5000,statement_timeout:10000
};}
test('R6.1 PG fenced intent remains quarantined after coherent assessment and dual signed review',
  {skip:!enabled,timeout:40000},async()=>{
    const tenantId=randomBytes(12).toString('hex'),
      incidentId=randomBytes(16).toString('hex'),
      pendingOp=randomBytes(16).toString('hex'),
      pendingSha=randomBytes(32).toString('hex'),epoch=9,
      manifestSha=randomBytes(32).toString('hex'),
      version='synthetic-version-2';
    const pool=new pg.Pool(config()),second=new pg.Pool(config());
    let s3Writes=0,readbacks=0;
    try{
      await pool.query(await readFile(
        new URL('../ops/r57/schema.sql',import.meta.url),'utf8'));
      await pool.query(await readFile(
        new URL('../ops/r61/incident-schema.sql',import.meta.url),'utf8'));
      await pool.query(
        'INSERT INTO ox_r57_checkpoint_control '+
        '(tenant,epoch,pending_op,pending_sha,pending_epoch,pending_create,pending_before_version) '+
        'VALUES($1,$2,$3,$4,$5,$6,$7)',
        [tenantId,epoch,pendingOp,pendingSha,epoch,true,'synthetic-version-1']);
      const forensics={tenantId,readonly:true,
        async investigate({pendingSha256,previousVersionId}){
          readbacks++;
          assert.equal(pendingSha256,pendingSha);
          assert.equal(previousVersionId,'synthetic-version-1');
          return {tenantId,canUnquarantine:false,
            reviewedVersions:[{versionId:version,isLatest:true,
              sha256:pendingSha,retentionMode:'COMPLIANCE'}],
            matchingPendingVersions:[version]};
        },
        async put(){s3Writes++;throw Error('forensics forbidden to PUT');}
      };
      const witness={
        async current(){return {entries:6,catalogSha256:pendingSha,
          manifestSha256:manifestSha};},
        async verify({catalogSha256,manifestSha256,entries}){
          assert.equal(catalogSha256,pendingSha);
          assert.equal(manifestSha256,manifestSha);
          assert.equal(entries,6);
          return {anchorVerified:true,catalogSha256};
        }
      };
      const auditAnchor={tenantId,async verifyAgainstLedger(){
        return {anchored:true,providerWormVerified:true,
          productionCutoverAllowed:false};
      }};
      const planner=createR61RecoveryAssessment({
        tenantId,pool,forensics,witness,auditAnchor,
        auditObjectKey:'r60/audit/'+'a'.repeat(64)+'.json',
        manifestSha256:manifestSha
      });
      const report=await planner.assess({incidentId});
      assert.equal(report.classification,'consistent-evidence-manual-review');
      const store=createR61PgIncidentStore({
        pool:second,tenantId,hmacKey:randomBytes(32)
      });
      assert.equal((await store.open({
        incidentId,evidenceSha256:report.reportSha256,
        epoch,s3Version:version,actor:'incident_controller'
      })).created,true);
      const sec=generateKeyPairSync('ed25519'),
        rel=generateKeyPairSync('ed25519');
      const reviewers={
        security_guard:{role:'security',publicKey:sec.publicKey},
        reliability_guard:{role:'reliability',publicKey:rel.publicKey}
      };
      const now=Date.now();
      const approvals=[
        ['security','security_guard',sec],
        ['reliability','reliability_guard',rel]
      ].map(([role,reviewerId,kp])=>signR61Approval({
        privateKey:kp.privateKey,
        payload:{tenantId,incidentId,evidenceSha256:report.reportSha256,
          epoch,s3Version:version,role,reviewerId,action:'investigate',
          nonce:randomBytes(16).toString('hex'),
          issuedAt:now-1000,expiresAt:now+30000}
      }));
      assert.equal((await store.recordReview({
        incidentId,action:'investigate',actor:'incident_controller',
        approvals,reviewers
      })).reviewed,true);
      const inspected=await store.inspect(incidentId);
      assert.equal(inspected.chainVerified,true);
      assert.equal(inspected.reviewEvents,1);
      assert.equal(inspected.quarantined,true);
      assert.equal(inspected.mayClearPendingIntent,false);
      const row=(await pool.query(
        'SELECT pending_op,pending_sha,epoch,committed_op FROM ox_r57_checkpoint_control WHERE tenant=$1',
        [tenantId])).rows[0];
      assert.equal(row.pending_op,pendingOp);
      assert.equal(row.pending_sha,pendingSha);
      assert.equal(Number(row.epoch),epoch);
      assert.equal(row.committed_op,null);
      assert.equal(readbacks,1);
      assert.equal(s3Writes,0);
    }finally{await Promise.all([pool.end(),second.end()]);}
  });
