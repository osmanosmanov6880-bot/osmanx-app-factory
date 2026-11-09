import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {randomBytes,createHash,generateKeyPairSync} from 'node:crypto';
import {readR63PgTimeline}
  from '../src/migration/r63-timeline-rejoin.mjs';
import {scanR64LocalWalArchive,signR64WalArchive,verifyR64WalArchive}
  from '../src/migration/r64-wal-archive-evidence.mjs';
import {signR64PitrBoundary,verifyR64PitrBoundary}
  from '../src/migration/r64-pitr-boundary.mjs';
const run=promisify(execFile),
  enabled=process.env.OX_R64_PITR_E2E==='YES'&&
    process.env.OX_R40_EPHEMERAL==='YES'&&
    process.env.OX_R64_LAB_ACK==='YES';
const sha=b=>createHash('sha256').update(b).digest('hex');
function config(port){
  return {host:'127.0.0.1',port,user:'postgres',
    password:'r64-disposable-only',database:'ox_r64',
    max:3,connectionTimeoutMillis:5000,statement_timeout:15000};
}
async function docker(args,timeout=30000,maxBuffer=8*1024*1024){
  return run('docker',args,{timeout,maxBuffer});
}
async function basebackup(version){
  const script='set -euo pipefail; chown postgres:postgres /backup; '+
    'chmod 0700 /backup; '+
    'gosu postgres env PGPASSWORD=r64-only-repl '+
    'pg_basebackup -h pg-r64-primary -p 5432 -U r64_repl '+
    '-D /backup -Fp -Xs --checkpoint=fast --manifest-checksums=SHA256';
  await docker(['run','--rm','--network','ox-r64-net',
    '-v','ox-r64-backup:/backup','--entrypoint','bash',
    'postgres:'+version,'-ec',script],60000);
  await docker(['run','--rm','-v','ox-r64-backup:/backup:ro',
    '--entrypoint','bash','postgres:'+version,'-ec',
    'gosu postgres pg_verifybackup /backup'],45000);
  return Buffer.from((await docker([
    'run','--rm','-v','ox-r64-backup:/backup:ro',
    '--entrypoint','cat','postgres:'+version,
    '/backup/backup_manifest'
  ])).stdout);
}
async function waitArchived(pool,dir){
  for(let i=0;i<80;i++){
    const state=(await pool.query(
      'SELECT last_archived_wal,failed_count FROM pg_stat_archiver'
    )).rows[0];
    if(state.last_archived_wal){
      try{
        const segments=await scanR64LocalWalArchive({directory:dir});
        if(segments.length>=1)return segments;
      }catch{}
    }
    await new Promise(ok=>setTimeout(ok,250));
  }
  throw Error('R6.4 WAL archive did not contain a complete segment');
}
async function bootRestore(version,targetLsn,archiveDir){
  await docker(['volume','create','ox-r64-restored']);
  const copy='set -euo pipefail; cp -a /backup/. /restore/; '+
    'chown -R postgres:postgres /restore;chmod 0700 /restore; '+
    'rm -f /restore/postmaster.pid /restore/standby.signal; '+
    'touch /restore/recovery.signal; '+
    'chown postgres:postgres /restore/recovery.signal';
  await docker(['run','--rm',
    '-v','ox-r64-backup:/backup:ro',
    '-v','ox-r64-restored:/restore',
    '--entrypoint','bash','postgres:'+version,'-ec',copy]);
  await docker(['run','-d','--name','pg-r64-restored',
    '--network','ox-r64-net','-p','127.0.0.1:5565:5432',
    '-v','ox-r64-restored:/var/lib/postgresql/data',
    '-v',archiveDir+':/archive:ro',
    'postgres:'+version,
    '-c','synchronous_commit=local',
    '-c','synchronous_standby_names=',
    '-c','restore_command=cp /archive/%f %p',
    '-c','recovery_target_lsn='+targetLsn,
    '-c','recovery_target_inclusive=on',
    '-c','recovery_target_action=promote'],25000);
}
test('R6.4 ACTUAL PostgreSQL 15/16 archived-WAL PITR retains selected COMMIT but excludes later acknowledged COMMIT',
  {skip:!enabled,timeout:125000},async()=>{
    const version=process.env.OX_R64_POSTGRES_VERSION,
      archiveDir=process.env.OX_R64_ARCHIVE_DIR;
    assert(['15','16'].includes(version));
    assert(archiveDir?.startsWith(process.env.RUNNER_TEMP+'/'));
    const primary=new pg.Pool(config(5564));
    let restored=null,restoreStarted=false,restoreVolume=false;
    try{
      const tenantId=randomBytes(12).toString('hex');
      await primary.query(await readFile(
        new URL('../ops/r64/pitr-markers.sql',import.meta.url),'utf8'));
      await primary.query(
        'INSERT INTO ox_r64_pitr_markers(tenant,marker) VALUES($1,$2)',
        [tenantId,'baseline']);
      const source=await readR63PgTimeline({
        pool:primary,nodeId:'pg-r64-primary'
      });
      const manifestBytes=await basebackup(version);
      // Both records are committed AFTER the physical backup snapshot.
      await primary.query(
        'INSERT INTO ox_r64_pitr_markers(tenant,marker) VALUES($1,$2)',
        [tenantId,'selected']);
      const targetLsn=(await primary.query(
        'SELECT pg_current_wal_lsn()::text AS lsn'
      )).rows[0].lsn;
      await primary.query(
        'INSERT INTO ox_r64_pitr_markers(tenant,marker) VALUES($1,$2)',
        [tenantId,'excluded']);
      const afterLsn=(await primary.query(
        'SELECT pg_current_wal_lsn()::text AS lsn'
      )).rows[0].lsn;
      const distance=(await primary.query(
        'SELECT pg_wal_lsn_diff($1::pg_lsn,$2::pg_lsn)::text AS delta',
        [afterLsn,targetLsn])).rows[0].delta;
      assert(Number(distance)>0,'target must precede excluded COMMIT');
      await primary.query('SELECT pg_switch_wal()');
      const segments=await waitArchived(primary,archiveDir);
      const kp=generateKeyPairSync('ed25519'),now=Date.now();
      const archive=signR64WalArchive({
        privateKey:kp.privateKey,payload:{
          format:'osmanx-r64-wal-archive-v1',scope:'disposable-lab',
          tenantId,systemId:source.systemId,timeline:source.timelineId,
          targetLsn,baseBackupSha256:sha(manifestBytes),
          segmentBytes:16*1024*1024,segments,
          nonce:randomBytes(16).toString('hex'),
          issuedAt:now-500,expiresAt:now+120000
        }
      });
      const verified=verifyR64WalArchive({
        manifest:archive,publicKey:kp.publicKey,tenantId,
        observedSegments:await scanR64LocalWalArchive({
          directory:archiveDir
        }),now:()=>now
      });
      assert.equal(verified.signatureVerified,true);
      await bootRestore(version,targetLsn,archiveDir);
      restoreStarted=true;restoreVolume=true;
      restored=new pg.Pool(config(5565));
      let ready=false;
      for(let i=0;i<120;i++){
        try{
          const recovering=(await restored.query(
            'SELECT pg_is_in_recovery() AS recovering'
          )).rows?.[0]?.recovering;
          if(recovering===false){ready=true;break;}
        }catch{}
        await new Promise(ok=>setTimeout(ok,250));
      }
      assert(ready,'isolated PITR server did not reach target and promote');
      const rows=(await restored.query(
        'SELECT marker FROM ox_r64_pitr_markers WHERE tenant=$1 ORDER BY marker',
        [tenantId])).rows.map(x=>x.marker);
      assert.deepEqual(rows,['baseline','selected'],
        'PITR must retain selected COMMIT but exclude later COMMIT');
      const post=await readR63PgTimeline({
        pool:restored,nodeId:'pg-r64-restored'
      });
      assert.equal(post.systemId,source.systemId);
      assert.equal(post.inRecovery,false);
      assert(post.timelineId>source.timelineId);
      const original=(await primary.query(
        'SELECT marker FROM ox_r64_pitr_markers WHERE tenant=$1 ORDER BY marker',
        [tenantId])).rows.map(x=>x.marker);
      const boundaryKey=generateKeyPairSync('ed25519');
      const receipt=signR64PitrBoundary({
        privateKey:boundaryKey.privateKey,payload:{
          format:'osmanx-r64-pitr-boundary-v1',scope:'disposable-lab',
          tenantId,incidentId:randomBytes(16).toString('hex'),
          systemId:source.systemId,targetLsn,afterLsn,
          archiveEvidenceSha256:verified.archiveEvidenceSha256,
          baseBackupSha256:verified.baseBackupSha256,
          nonce:randomBytes(16).toString('hex'),
          issuedAt:now-500,expiresAt:now+120000
        }
      });
      const measured=verifyR64PitrBoundary({
        manifest:receipt,publicKey:boundaryKey.publicKey,
        tenantId,sourceMarkers:original,restoredMarkers:rows,
        restoredSystemId:post.systemId,archiveReceipt:verified,
        now:()=>now
      });
      assert.equal(measured.selectedTransactionRecovered,true);
      assert.equal(measured.intentionallyLaterTransactionExcluded,true);
      assert.equal(measured.unknownCustomerWritesNotCounted,true);
      assert.equal(measured.industrialZeroRpoCertified,false);
      assert.equal(verified.offsiteImmutableCustodyVerified,false);
      assert.equal(verified.productionCutoverAllowed,false);
    }finally{
      await Promise.all([primary.end().catch(()=>{}),
        restored?.end().catch(()=>{})]);
      if(restoreStarted)await docker(['rm','-f','pg-r64-restored']).catch(()=>{});
      // Also attempt cleanups if a restore failed between volume creation
      // and container start. Never delete source backup or WAL archive here.
      if(restoreVolume||restoreStarted)
        await docker(['volume','rm','ox-r64-restored']).catch(()=>{});
    }
  });
