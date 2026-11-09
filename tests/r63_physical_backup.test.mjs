import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,generateKeyPairSync} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {digestR62Checkpoint} from '../src/migration/r62-restore-evidence.mjs';
import {inspectR63PgBackupManifest,signR63PhysicalBackupEvidence,
  verifyR63PhysicalBackup} from '../src/migration/r63-physical-backup-evidence.mjs';
import {readR63PgTimeline} from '../src/migration/r63-timeline-rejoin.mjs';
const run=promisify(execFile),TENANT='a'.repeat(24),
  SYSTEM='7392526296213040844',NOW=Date.now();
function row(tenant=TENANT){return {
  tenant,epoch:11,holder:null,lease_id:null,expires_at:null,
  pending_op:'b'.repeat(32),pending_sha:'c'.repeat(64),
  pending_if_match:null,pending_create:true,pending_epoch:11,
  pending_before_version:null,committed_op:null,committed_sha:null,
  committed_version:null,committed_epoch:null};
}
function sample(){
  return Buffer.from(JSON.stringify({
    'PostgreSQL-Backup-Manifest-Version':1,
    Files:[{Path:'base/1/123',Size:8192}],
    'WAL-Ranges':[{'Timeline':1,'Start-LSN':'0/1000','End-LSN':'0/3000'}],
    'Manifest-Checksum':'d'.repeat(64)
  }));
}
function signed(bytes=sample(),source=row()){
  const kp=generateKeyPairSync('ed25519'),now=Date.now();
  const manifest=signR63PhysicalBackupEvidence({
    privateKey:kp.privateKey,
    payload:{format:'osmanx-r63-physical-backup-v1',scope:'disposable-lab',
      tenantId:TENANT,systemId:SYSTEM,timeline:1,sourceLsn:'0/5000',
      manifestSha256:inspectR63PgBackupManifest(bytes).backupManifestSha256,
      checkpointSha256:digestR62Checkpoint(source,TENANT),
      verifierTool:'pg_verifybackup',nonce:randomBytes(16).toString('hex'),
      issuedAt:now-1000,expiresAt:now+90000
    }
  });
  return {publicKey:kp.publicKey,manifest,manifestBytes:bytes,
    tenantId:TENANT,restoredRow:source,restoredSystemId:SYSTEM,
    restoredTimeline:1,verifierExitCode:0,now:()=>now};
}
test('R6.3 bounded PostgreSQL physical manifest is signed and restored checkpoint matches',
  ()=>{
    const p=signed(),out=verifyR63PhysicalBackup(p);
    assert.equal(out.pgVerifybackupPassed,true);
    assert.equal(out.restoredPhysicalNodeVerified,true);
    assert.equal(out.restoredCheckpointExactlyMatches,true);
    assert.equal(out.walArchivePitrVerified,false);
    assert.equal(out.productionCutoverAllowed,false);
});
test('R6.3 denies forged manifest bytes, lost checksum, wrong system or altered pending state',
  ()=>{
    const p=signed();
    assert.throws(()=>verifyR63PhysicalBackup({...p,
      restoredRow:{...p.restoredRow,pending_sha:'f'.repeat(64)}
    }),/restored system, timeline or fenced checkpoint differs/);
    assert.throws(()=>verifyR63PhysicalBackup({...p,
      restoredSystemId:'1234567890123456789'
    }),/restored system, timeline or fenced checkpoint differs/);
    assert.throws(()=>verifyR63PhysicalBackup({...p,
      verifierExitCode:1
    }),/pg_verifybackup must complete without error/);
    const altered=Buffer.from(p.manifestBytes);
    altered[altered.length-5]=0x32;
    assert.throws(()=>verifyR63PhysicalBackup({...p,
      manifestBytes:altered
    }));
    assert.throws(()=>verifyR63PhysicalBackup({...p,
      now:()=>Date.now()+1000000
    }),/expired/);
  });
test('R6.3 rejects path traversal, duplicate file and missing WAL range',()=>{
  const noWal=JSON.parse(sample().toString());
  noWal['WAL-Ranges']=[];
  assert.throws(()=>inspectR63PgBackupManifest(
    Buffer.from(JSON.stringify(noWal))
  ),/missing PG version/);
  const traversal=JSON.parse(sample().toString());
  traversal.Files[0].Path='../pg_hba.conf';
  assert.throws(()=>inspectR63PgBackupManifest(
    Buffer.from(JSON.stringify(traversal))
  ),/duplicate, foreign/);
  const duplicate=JSON.parse(sample().toString());
  duplicate.Files.push({...duplicate.Files[0]});
  assert.throws(()=>inspectR63PgBackupManifest(
    Buffer.from(JSON.stringify(duplicate))
  ),/duplicate, foreign/);
});
const enabled=process.env.OX_R63_PHYSICAL_LAB==='YES'&&
  process.env.OX_R59_LAB_ACK==='YES'&&
  process.env.OX_R40_EPHEMERAL==='YES';
function conf(port){return{
  host:'127.0.0.1',port,user:'postgres',password:'r59-disposable-pg',
  database:'ox_r59',max:3,connectionTimeoutMillis:5000,
  statement_timeout:15000
};}
async function command(args,timeout=30000,buffer=8*1024*1024){
  return run('docker',args,{timeout,maxBuffer:buffer});
}
test('R6.3 ACTUAL PG15/16 full physical basebackup, pg_verifybackup and independently booted restored node',
  {skip:!enabled,timeout:120000},async()=>{
    const version=process.env.OX_R59_POSTGRES_VERSION;
    assert(['15','16'].includes(version));
    const tenantId=randomBytes(12).toString('hex'),
      old=new pg.Pool(conf(5543));let fresh,backupCreated=false,
      restoredCreated=false,containerCreated=false;
    try{
      await old.query(await readFile(
        new URL('../ops/r57/schema.sql',import.meta.url),'utf8'));
      await old.query(
        'INSERT INTO ox_r57_checkpoint_control'+
        '(tenant,epoch,pending_op,pending_sha,pending_epoch,pending_create)'+
        ' VALUES($1,$2,$3,$4,$5,$6)',
        [tenantId,18,'a'.repeat(32),'b'.repeat(64),18,true]);
      const before=(await old.query(
        'SELECT * FROM ox_r57_checkpoint_control WHERE tenant=$1',
        [tenantId])).rows[0];
      const control=await readR63PgTimeline({
        pool:old,nodeId:'pg-r59-primary'
      });
      const sourceLsn=(await old.query(
        'SELECT pg_current_wal_lsn()::text AS lsn')).rows[0].lsn;
      await command(['volume','create','ox-r63-physical-backup']);
      backupCreated=true;
      const backupSql='set -euo pipefail; chown postgres:postgres /backup; '+
        'chmod 0700 /backup; '+
        'gosu postgres env PGPASSWORD=r59-only-disposable-repl '+
        'pg_basebackup -h pg-r59-primary -p 5432 -U r59_repl '+
        '-D /backup -Fp -Xs --checkpoint=fast --manifest-checksums=SHA256';
      await command(['run','--rm','--network','ox-r59-net',
        '-v','ox-r63-physical-backup:/backup',
        '--entrypoint','bash','postgres:'+version,'-ec',backupSql],60000);
      // Independent official verifier parses WAL and validates all
      // manifest file hashes. Do not use --no-parse-wal or --no-manifest.
      await command(['run','--rm',
        '-v','ox-r63-physical-backup:/backup:ro',
        '--entrypoint','bash','postgres:'+version,
        '-ec','gosu postgres pg_verifybackup /backup'],40000);
      const manifestBytes=Buffer.from((await command([
        'run','--rm','-v','ox-r63-physical-backup:/backup:ro',
        '--entrypoint','cat','postgres:'+version,
        '/backup/backup_manifest'],20000)).stdout);
      const info=inspectR63PgBackupManifest(manifestBytes);
      assert(info.fileCount>1);
      assert(info.walRangeCount>=1);
      const signer=generateKeyPairSync('ed25519'),now=Date.now();
      const manifest=signR63PhysicalBackupEvidence({
        privateKey:signer.privateKey,payload:{
          format:'osmanx-r63-physical-backup-v1',scope:'disposable-lab',
          tenantId,systemId:control.systemId,
          timeline:control.timelineId,sourceLsn,
          manifestSha256:info.backupManifestSha256,
          checkpointSha256:digestR62Checkpoint(before,tenantId),
          verifierTool:'pg_verifybackup',
          nonce:randomBytes(16).toString('hex'),
          issuedAt:now-1000,expiresAt:now+120000
        }
      });
      await command(['volume','create','ox-r63-physical-restored']);
      restoredCreated=true;
      const cp='set -e; cp -a /backup/. /restore/; '+
        'chown -R postgres:postgres /restore; chmod 0700 /restore; '+
        'rm -f /restore/postmaster.pid /restore/standby.signal '+
        '/restore/recovery.signal';
      await command(['run','--rm',
        '-v','ox-r63-physical-backup:/backup:ro',
        '-v','ox-r63-physical-restored:/restore',
        '--entrypoint','bash','postgres:'+version,'-ec',cp],30000);
      await command(['run','-d','--name','pg-r63-physical-restored',
        '--network','ox-r59-net','-p','127.0.0.1:5546:5432',
        '-v','ox-r63-physical-restored:/var/lib/postgresql/data',
        'postgres:'+version,
        '-c','synchronous_commit=local',
        '-c','synchronous_standby_names='],20000);
      containerCreated=true;
      fresh=new pg.Pool(conf(5546));
      let ready=false;
      for(let i=0;i<90;i++){
        try{await fresh.query('SELECT 1');ready=true;break;}
        catch{await new Promise(ok=>setTimeout(ok,150));}
      }
      assert(ready,'physical restored node did not boot');
      const restored=(await fresh.query(
        'SELECT * FROM ox_r57_checkpoint_control WHERE tenant=$1',
        [tenantId])).rows[0];
      const restoredState=await readR63PgTimeline({
        pool:fresh,nodeId:'pg-r63-physical-restored'
      });
      const report=verifyR63PhysicalBackup({
        manifest,publicKey:signer.publicKey,
        manifestBytes,tenantId,restoredRow:restored,
        restoredSystemId:restoredState.systemId,
        restoredTimeline:restoredState.timelineId,
        verifierExitCode:0
      });
      assert.equal(report.restoredCheckpointExactlyMatches,true);
      assert.equal(restored.pending_op,'a'.repeat(32));
      assert.equal(restored.committed_op,null);
      assert.equal(report.walArchivePitrVerified,false);
      assert.equal(report.productionCutoverAllowed,false);
    }finally{
      await Promise.all([old.end().catch(()=>{}),fresh?.end().catch(()=>{})]);
      if(containerCreated)await command(['rm','-f',
        'pg-r63-physical-restored']).catch(()=>{});
      if(restoredCreated)await command(['volume','rm',
        'ox-r63-physical-restored']).catch(()=>{});
      if(backupCreated)await command(['volume','rm',
        'ox-r63-physical-backup']).catch(()=>{});
    }
  });
