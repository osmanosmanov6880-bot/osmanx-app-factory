import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,createHash,generateKeyPairSync} from 'node:crypto';
import {readFile,stat,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createR65DualWormCustody}
  from '../src/migration/r65-dual-worm-custody.mjs';
import {signR65DualWalBundle,verifyR65DualWalBundle}
  from '../src/migration/r65-dual-wal-bundle.mjs';
import {measureR65SyntheticRpo,readR65PostgresLedger}
  from '../src/migration/r65-synthetic-rpo.mjs';
import {scanR64LocalWalArchive}
  from '../src/migration/r64-wal-archive-evidence.mjs';
import {readR63PgTimeline}
  from '../src/migration/r63-timeline-rejoin.mjs';
const run=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const enabled=process.env.OX_R65_DETACHED_PITR_E2E==='YES'&&
  process.env.OX_R65_DUAL_MINIO_E2E==='YES'&&
  process.env.OX_R40_EPHEMERAL==='YES'&&
  process.env.OX_R65_LAB_ACK==='YES'&&
  process.env.OX_R64_LAB_ACK==='YES';
function stores(){
  return [
    {storeId:'first-process',endpoint:process.env.OX_R65_MINIO_A_ENDPOINT,
      bucket:process.env.OX_R65_MINIO_A_BUCKET,region:'us-east-1',
      accessKey:process.env.OX_R65_MINIO_A_KEY,
      secretKey:process.env.OX_R65_MINIO_A_SECRET},
    {storeId:'second-process',endpoint:process.env.OX_R65_MINIO_B_ENDPOINT,
      bucket:process.env.OX_R65_MINIO_B_BUCKET,region:'us-east-1',
      accessKey:process.env.OX_R65_MINIO_B_KEY,
      secretKey:process.env.OX_R65_MINIO_B_SECRET}
  ];
}
function config(port){
  return {host:'127.0.0.1',port,user:'postgres',
    password:'r64-disposable-only',database:'ox_r64',max:3,
    connectionTimeoutMillis:5000,statement_timeout:15000};
}
async function docker(args,timeout=30000){
  return run('docker',args,{timeout,maxBuffer:8*1024*1024});
}
async function basebackup(version){
  const script='set -euo pipefail; chown postgres:postgres /backup; '+
    'chmod 0700 /backup; gosu postgres env PGPASSWORD=r64-only-repl '+
    'pg_basebackup -h pg-r64-primary -p 5432 -U r64_repl '+
    '-D /backup -Fp -Xs --checkpoint=fast --manifest-checksums=SHA256';
  await docker(['run','--rm','--network','ox-r64-net',
    '-v','ox-r64-backup:/backup','--entrypoint','bash',
    'postgres:'+version,'-ec',script],60000);
  await docker(['run','--rm','-v','ox-r64-backup:/backup:ro',
    '--entrypoint','bash','postgres:'+version,
    '-ec','gosu postgres pg_verifybackup /backup'],45000);
  return Buffer.from((await docker(['run','--rm',
    '-v','ox-r64-backup:/backup:ro',
    '--entrypoint','cat','postgres:'+version,
    '/backup/backup_manifest'])).stdout);
}
async function waitArchive(pool,directory,filename){
  for(let i=0;i<100;i++){
    try{
      const files=await scanR64LocalWalArchive({directory});
      if(files.some(x=>x.name===filename))return files;
    }catch{}
    await new Promise(ok=>setTimeout(ok,250));
  }
  throw Error('specific acknowledged WAL segment never reached local archive');
}
async function restoreServer({version,archiveDir,targetLsn}){
  await docker(['volume','create','ox-r65-disaster-restored']);
  const cp='set -euo pipefail; cp -a /backup/. /restore/; '+
    'chown -R postgres:postgres /restore; chmod 0700 /restore; '+
    'rm -f /restore/postmaster.pid /restore/standby.signal; '+
    'touch /restore/recovery.signal; '+
    'chown postgres:postgres /restore/recovery.signal';
  await docker(['run','--rm','-v','ox-r64-backup:/backup:ro',
    '-v','ox-r65-disaster-restored:/restore',
    '--entrypoint','bash','postgres:'+version,'-ec',cp]);
  await docker(['run','-d','--name','pg-r65-disaster-restored',
    '--network','ox-r64-net','-p','127.0.0.1:5568:5432',
    '-v','ox-r65-disaster-restored:/var/lib/postgresql/data',
    '-v',archiveDir+':/detached:ro',
    'postgres:'+version,
    '-c','synchronous_commit=local',
    '-c','synchronous_standby_names=',
    '-c','restore_command=cp /detached/%f %p',
    '-c','recovery_target_lsn='+targetLsn,
    '-c','recovery_target_inclusive=on',
    '-c','recovery_target_action=promote'],25000);
}
test('R6.5 ACTUAL PG15/16 total source-container+local-WAL loss, dual WORM restore, 20-transaction measured loss',
  {skip:!enabled,timeout:200000},async()=>{
    const version=process.env.OX_R64_POSTGRES_VERSION,
      temp=process.env.RUNNER_TEMP;
    assert(['15','16'].includes(version));
    assert(temp?.startsWith('/'));
    const originalDir=temp+'/r64-archive',
      detachedDir=temp+'/r65-archive-from-independent-s3',
      source=new pg.Pool(config(5564));
    let recovered=null,volMade=false,restoredNode=false;
    const tenantId=randomBytes(12).toString('hex'),
      incidentId=randomBytes(16).toString('hex');
    const ack=[];
    const add=async seq=>{
      const h=sha(Buffer.from('r65 synthetic acknowledged '+tenantId+' #'+seq));
      await source.query(
        'INSERT INTO ox_r65_commit_ledger(tenant,seq,payload_sha) VALUES($1,$2,$3)',
        [tenantId,seq,h]);
      const lsn=(await source.query(
        'SELECT pg_current_wal_lsn()::text AS lsn')).rows[0].lsn;
      ack.push({seq,sha256:h,committedLsn:lsn,
        acknowledgedAtMs:Date.now()});
    };
    try{
      await source.query(await readFile(
        new URL('../ops/r65/synthetic-ledger.sql',import.meta.url),'utf8'));
      for(let seq=1;seq<=4;seq++)await add(seq);
      const sourceCtl=await readR63PgTimeline({
        pool:source,nodeId:'pg-r64-primary'
      });
      const backup=await basebackup(version);
      let targetLsn=null;
      for(let seq=5;seq<=20;seq++){
        await add(seq);
        if(seq===12)targetLsn=ack[ack.length-1].committedLsn;
      }
      assert(targetLsn);
      const originalRows=await readR65PostgresLedger({
        pool:source,tenantId
      });
      assert.equal(originalRows.length,20);
      const lastLsn=ack.at(-1).committedLsn;
      const required=(await source.query(
        'SELECT pg_walfile_name($1::pg_lsn) AS file',[lastLsn]
      )).rows[0].file;
      await source.query('SELECT pg_switch_wal()');
      const inventory=await waitArchive(source,originalDir,required);
      const dual=createR65DualWormCustody({
        tenantId,stores:stores(),allowSyntheticLoopback:true
      });
      const receipts=await dual.uploadArchive({
        directory:originalDir,inventory
      });
      const kp=generateKeyPairSync('ed25519'),now=Date.now();
      const sealed=signR65DualWalBundle({
        privateKey:kp.privateKey,
        payload:{format:'osmanx-r65-dual-worm-bundle-v1',
          scope:'disposable-lab',tenantId,incidentId,
          systemId:sourceCtl.systemId,timeline:sourceCtl.timelineId,
          targetLsn,baseBackupSha256:sha(backup),
          inventory,receipts,nonce:randomBytes(16).toString('hex'),
          issuedAt:now-500,expiresAt:now+600000
        }
      });
      const firstReview=verifyR65DualWalBundle({
        manifest:sealed,publicKey:kp.publicKey,tenantId
      });
      assert.equal(firstReview.storeCount,2);
      assert.equal(firstReview.independentlyRereadFromProviders,false);
      await source.end();
      // DROP both source process and its anonymous PGDATA volume.
      await docker(['rm','-fv','pg-r64-primary'],15000);
      const failureAtMs=Date.now();
      // The original local WAL folder is physically destroyed. Recovery
      // must not reference it: only two independently reread WORM stores.
      assert.equal(originalDir,temp+'/r64-archive');
      await run('sudo',['rm','-rf',originalDir],{timeout:15000});
      await assert.rejects(stat(originalDir),/ENOENT/);
      const rescued=await dual.restoreToFreshDirectory({
        directory:detachedDir,inventory,receipts
      });
      assert.equal(rescued.bothWormCopiesReread,true);
      // Synthetic, read-only mount for the PostgreSQL uid inside Docker.
      await chmod(detachedDir,0o755);
      for(const entry of inventory)
        await chmod(join(detachedDir,entry.name),0o644);
      const finalReview=verifyR65DualWalBundle({
        manifest:sealed,publicKey:kp.publicKey,tenantId
      });
      assert.equal(finalReview.evidenceSha256,firstReview.evidenceSha256);
      volMade=true;
      await restoreServer({version,archiveDir:detachedDir,targetLsn});
      restoredNode=true;
      recovered=new pg.Pool(config(5568));
      let online=false;
      for(let i=0;i<120;i++){
        try{
          const state=(await recovered.query(
            'SELECT pg_is_in_recovery() AS in_recovery'
          )).rows[0].in_recovery;
          if(state===false){online=true;break;}
        }catch{}
        await new Promise(ok=>setTimeout(ok,250));
      }
      assert(online,'detached PostgreSQL restore not promoted at target');
      const restoredRows=await readR65PostgresLedger({
        pool:recovered,tenantId
      });
      assert.equal(restoredRows.length,12);
      const recoveredCtl=await readR63PgTimeline({
        pool:recovered,nodeId:'pg-r65-disaster-restored'
      });
      assert.equal(recoveredCtl.systemId,sourceCtl.systemId);
      assert(recoveredCtl.timelineId>sourceCtl.timelineId);
      const rpo=measureR65SyntheticRpo({
        tenantId,acknowledged:ack,restoredRows,targetLsn,
        failureAtMs,recoveryAtMs:Date.now(),
        sourceProcessDestroyed:true,dualRemoteBytesVerified:true
      });
      assert.equal(rpo.lostAcknowledgedTransactions,8);
      assert.equal(rpo.recoveredTransactions,12);
      assert.equal(rpo.sourceSqliteCommitMeasured,false);
      assert.equal(rpo.industrialZeroRpoCertified,false);
      assert.equal(rpo.productionCutoverAllowed,false);
      await assert.rejects(docker(['inspect',
        'pg-r64-primary']),/No such object|No such container/);
    }finally{
      await Promise.all([source.end().catch(()=>{}),
        recovered?.end().catch(()=>{})]);
      if(restoredNode)await docker(['rm','-f',
        'pg-r65-disaster-restored']).catch(()=>{});
      if(volMade)await docker(['volume','rm',
        'ox-r65-disaster-restored']).catch(()=>{});
      await rm(detachedDir,{recursive:true,force:true}).catch(()=>{});
    }
  });
