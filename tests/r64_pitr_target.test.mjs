import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes,generateKeyPairSync} from 'node:crypto';
import {verifyR64NamedPitrReplay}
  from '../src/migration/r64-pitr-target.mjs';
import {makeR64WalSegmentRecord,signR64WalArchive,verifyR64WalArchive}
  from '../src/migration/r64-wal-archive.mjs';
const exec=promisify(execFile),sha=x=>createHash('sha256').update(x).digest('hex'),
  id=()=>randomBytes(16).toString('hex');
const SYSTEM='7392526296213040844',TENANT='a'.repeat(24);
function mockDb({events,systemId=SYSTEM,timeline=1,recovering=false}){
  return {async query(sql,args){
    if(sql.includes('pg_control_system()'))return {rows:[{
      system_id:systemId,timeline,recovering
    }]};
    assert(sql.startsWith('SELECT event_id,payload_sha'));
    return {rows:[...events].filter(([event])=>args[1].includes(event))
      .map(([event,payload])=>({event_id:event,payload_sha:payload}))};
  }};
}
test('R6.4 named target accepts only new WAL-before-target and excludes post-target commit',
  async()=>{
    const pre='b'.repeat(32),post='c'.repeat(32),
      a='d'.repeat(64),b='e'.repeat(64);
    const report=await verifyR64NamedPitrReplay({
      source:mockDb({events:[[pre,a],[post,b]]}),
      restored:mockDb({events:[[pre,a]],timeline:2}),
      tenantId:TENANT,targetName:'r64_marker_valid',preId:pre,postId:post,
      preSha256:a,postSha256:b,expectedSystemId:SYSTEM,
      archiveReceipt:{format:'osmanx-r64-verified-wal-archive-v1',
        tenantId:TENANT,systemId:SYSTEM,fullSegmentHashesVerified:true,
        walPitrCompleted:false,verifiedSegments:2},
      restoreStartedAt:Date.now()-2000
    });
    assert.equal(report.isolatedNamedPointInTimeRecoveryVerified,true);
    assert.equal(report.preTargetWalCommitReplayed,true);
    assert.equal(report.postTargetWalCommitExcluded,true);
    assert.equal(report.fullCustomerRestoreVerified,false);
    assert.equal(report.industrialRpoCertified,false);
    assert.equal(report.productionCutoverAllowed,false);
  });
test('R6.4 base-backup-only, late-commit-included and foreign PostgreSQL rejected',
  async()=>{
    const pre='b'.repeat(32),post='c'.repeat(32),
      a='d'.repeat(64),b='e'.repeat(64);
    const base={source:mockDb({events:[[pre,a],[post,b]]}),
      tenantId:TENANT,targetName:'r64_marker_valid',preId:pre,postId:post,
      preSha256:a,postSha256:b,expectedSystemId:SYSTEM,
      archiveReceipt:{format:'osmanx-r64-verified-wal-archive-v1',
        tenantId:TENANT,systemId:SYSTEM,fullSegmentHashesVerified:true,
        walPitrCompleted:false,verifiedSegments:1},
      restoreStartedAt:Date.now()-3000};
    await assert.rejects(verifyR64NamedPitrReplay({
      ...base,restored:mockDb({events:[]})
    }),/PITR did not replay pre-target/);
    await assert.rejects(verifyR64NamedPitrReplay({
      ...base,restored:mockDb({events:[[pre,a],[post,b]]})
    }),/post-target commit/);
    await assert.rejects(verifyR64NamedPitrReplay({
      ...base,restored:mockDb({events:[[pre,a]],systemId:'1234567890123456789'})
    }),/not an independent writable cluster/);
    await assert.rejects(verifyR64NamedPitrReplay({
      ...base,restored:base.source
    }),/separate PG sources/);
  });
const enabled=process.env.OX_R64_PITR_LAB==='YES'&&
  process.env.OX_R64_PITR_ACK==='YES'&&
  process.env.OX_R40_EPHEMERAL==='YES';
function conf(port){return {host:'127.0.0.1',port,
  user:'postgres',password:'r64-synthetic-pg',database:'ox_r64',
  max:3,connectionTimeoutMillis:5000,statement_timeout:12000};}
async function docker(args,{timeout=30000,maxBuffer=3*1024*1024,
  binary=false}={}){
  const out=await exec('docker',args,{timeout,maxBuffer,
    encoding:binary?'buffer':'utf8'});
  return out.stdout;
}
test('R6.4 REAL PG15/16 base backup + archived WAL named-target PITR includes pre-target and excludes post-target transaction',
  {skip:!enabled,timeout:150000},async()=>{
    const version=process.env.OX_R64_POSTGRES_VERSION;
    assert(['15','16'].includes(version));
    const tenantId=id().slice(0,24),preId=id(),postId=id(),
      baselineId=id(),preSha=sha('r64-pre-'+preId),
      postSha=sha('r64-late-'+postId),targetName='r64_marker_'+id().slice(0,10);
    const source=new pg.Pool(conf(5561));let restored=null,
      created=false;const started=Date.now();
    try{
      await source.query(await readFile(
        new URL('../ops/r64/pitr-schema.sql',import.meta.url),'utf8'));
      await source.query(
        'INSERT INTO ox_r64_pitr_event (tenant,event_id,payload_sha) VALUES ($1,$2,$3)',
        [tenantId,baselineId,sha('base-transaction')]);
      const original=await source.query(
        'SELECT s.system_identifier::text AS sys, c.timeline_id::integer AS timeline '+
        'FROM pg_control_system() s CROSS JOIN pg_control_checkpoint() c');
      const systemId=original.rows[0].sys,
        timeline=original.rows[0].timeline;
      const backupSql='set -euo pipefail; chown postgres:postgres /backup; '+
        'chmod 0700 /backup; gosu postgres env PGPASSWORD=r64-lab-repl-only '+
        'pg_basebackup -h pg-r64-primary -p 5432 -U r64_repl '+
        '-D /backup -Fp -Xs --checkpoint=fast --manifest-checksums=SHA256';
      await docker(['run','--rm','--network','ox-r64-net',
        '-v','ox-r64-basebackup:/backup','--entrypoint','bash',
        'postgres:'+version,'-ec',backupSql],{timeout:65000});
      await docker(['run','--rm','-v','ox-r64-basebackup:/backup:ro',
        '--entrypoint','bash','postgres:'+version,'-ec',
        'gosu postgres pg_verifybackup /backup'],{timeout:35000});
      const baseManifest=await docker(['run','--rm',
        '-v','ox-r64-basebackup:/backup:ro','--entrypoint','cat',
        'postgres:'+version,'/backup/backup_manifest'],
        {binary:true,maxBuffer:8*1024*1024});
      const backupSha=sha(baseManifest);
      // PRE is deliberately committed AFTER the base backup.
      await source.query('INSERT INTO ox_r64_pitr_event '+
        '(tenant,event_id,payload_sha) VALUES($1,$2,$3)',
        [tenantId,preId,preSha]);
      const point=(await source.query(
        'SELECT pg_create_restore_point($1)::text AS lsn',
        [targetName])).rows[0].lsn;
      await source.query('INSERT INTO ox_r64_pitr_event '+
        '(tenant,event_id,payload_sha) VALUES($1,$2,$3)',
        [tenantId,postId,postSha]);
      await source.query('SELECT pg_switch_wal()');
      // Archive is async; prove all returned full 16MiB files cover point.
      const list=async()=>String(await docker(['run','--rm',
        '-v','ox-r64-walarchive:/archive:ro',
        '--entrypoint','ls','postgres:'+version,'-1','/archive']))
        .split(/\r?\n/).map(x=>x.trim()).filter(x=>/^[0-9A-F]{24}$/.test(x));
      let names=[];
      const at=Date.now();
      for(let attempt=0;attempt<70;attempt++){
        names=await list();
        const pointBytes=(BigInt('0x'+point.split('/')[0])*0x100000000n+
          BigInt('0x'+point.split('/')[1]))/BigInt(16*1024*1024);
        const covered=names.some(name=>{
          const wal=BigInt('0x'+name.slice(8,16))*256n+
            BigInt('0x'+name.slice(16,24));
          return wal===pointBytes;
        });
        if(covered)break;
        if(Date.now()-at>30000)break;
        await new Promise(ok=>setTimeout(ok,300));
      }
      assert(names.length>=1&&names.length<=16,
        'no bounded archived WAL segment names');
      const data=new Map();
      for(const name of names){
        const bytes=await docker(['run','--rm',
          '-v','ox-r64-walarchive:/archive:ro',
          '--entrypoint','cat','postgres:'+version,
          '/archive/'+name],{binary:true,maxBuffer:20*1024*1024});
        assert.equal(bytes.length,16*1024*1024);
        data.set(name,bytes);
      }
      const pair=generateKeyPairSync('ed25519'),now=Date.now();
      const packet=signR64WalArchive({privateKey:pair.privateKey,
        payload:{format:'osmanx-r64-wal-archive-v1',
          scope:'disposable-lab',tenantId,systemId,
          timeline,baseBackupSha256:backupSha,targetLsn:point,
          segments:[...data].map(([name,bytes])=>
            makeR64WalSegmentRecord({name,bytes})),
          issuer:'archive_reviewer',nonce:id(),
          issuedAt:now-1000,expiresAt:now+110000
        }});
      const archiveReceipt=await verifyR64WalArchive({
        packet,publicKey:pair.publicKey,tenantId,systemId,
        baseBackupSha256:backupSha,reader:async name=>data.get(name)
      });
      assert.equal(archiveReceipt.fullSegmentHashesVerified,true);
      // No reuse of a live data volume. The lab setup verified its absence.
      const targetConfig=[
        'set -euo pipefail',
        'cp -a /backup/. /restore/',
        'chown -R postgres:postgres /restore',
        'chmod 0700 /restore',
        'rm -f /restore/postmaster.pid /restore/standby.signal',
        'touch /restore/recovery.signal',
        "echo \"restore_command = 'cp /archive/%f %p'\" >> /restore/postgresql.auto.conf",
        "echo \"recovery_target_name = '"+targetName+"'\" >> /restore/postgresql.auto.conf",
        "echo \"recovery_target_action = 'promote'\" >> /restore/postgresql.auto.conf",
        'echo "recovery_target_inclusive = on" >> /restore/postgresql.auto.conf'
      ].join('; ');
      await docker(['run','--rm',
        '-v','ox-r64-basebackup:/backup:ro',
        '-v','ox-r64-pitr-restore:/restore',
        '--entrypoint','bash','postgres:'+version,
        '-ec',targetConfig],{timeout:30000});
      await docker(['run','-d','--name','pg-r64-recovered',
        '--network','ox-r64-net',
        '-p','127.0.0.1:5562:5432',
        '-v','ox-r64-pitr-restore:/var/lib/postgresql/data',
        '-v','ox-r64-walarchive:/archive:ro',
        'postgres:'+version,'-c','archive_mode=off',
        '-c','synchronous_commit=local'],{timeout:25000});
      created=true;restored=new pg.Pool(conf(5562));
      let ready=false;
      for(let attempt=0;attempt<160;attempt++){
        try{
          const q=await restored.query(
            'SELECT pg_is_in_recovery() AS recovering');
          if(q.rows[0].recovering===false){ready=true;break;}
        }catch{}
        await new Promise(ok=>setTimeout(ok,250));
      }
      if(!ready){
        const logs=await docker(['logs','--tail','75','pg-r64-recovered']);
        throw Error('real PITR target did not promote: '+String(logs).slice(-1200));
      }
      const verified=await verifyR64NamedPitrReplay({
        source,restored,tenantId,targetName,preId,postId,
        preSha256:preSha,postSha256:postSha,
        archiveReceipt,expectedSystemId:systemId,restoreStartedAt:started
      });
      assert.equal(verified.isolatedNamedPointInTimeRecoveryVerified,true);
      assert.equal(verified.preTargetWalCommitReplayed,true);
      assert.equal(verified.postTargetWalCommitExcluded,true);
      assert.equal(verified.productionCutoverAllowed,false);
    }finally{
      await Promise.all([source.end().catch(()=>{}),
        restored?.end().catch(()=>{})]);
      if(created)await docker(['rm','-f','pg-r64-recovered']).catch(()=>{});
    }
  });
