import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {digestR62Checkpoint,signR62RestoreManifest,verifyR62Restore,
  shaR62} from '../src/migration/r62-restore-evidence.mjs';
const run=promisify(execFile);
const TENANT='a'.repeat(24),HASH='c'.repeat(64);
function fixtureRow(){
  return {tenant:TENANT,epoch:9,holder:'b'.repeat(24),
    lease_id:'d'.repeat(32),expires_at:new Date('2026-11-10T00:00:00.000Z'),
    pending_op:'e'.repeat(32),pending_sha:HASH,pending_if_match:null,
    pending_create:true,pending_epoch:9,pending_before_version:null,
    committed_op:null,committed_sha:null,committed_version:null,
    committed_epoch:null};
}
function signed(row,logicalDump){
  const {privateKey,publicKey}=generateKeyPairSync('ed25519'),now=Date.now();
  const manifest=signR62RestoreManifest({privateKey,payload:{
    format:'osmanx-r62-logical-restore-v1',scope:'disposable-lab',
    tenantId:TENANT,walLsn:'0/1000',dumpSha256:shaR62(logicalDump),
    checkpointSha256:digestR62Checkpoint(row,TENANT),
    nonce:randomBytes(16).toString('hex'),issuedAt:now-1000,
    expiresAt:now+60000
  }});
  return {manifest,publicKey,clock:now};
}
test('R6.2 signed logical dump exactly matches retained pending checkpoint fields',
  ()=>{
    const row=fixtureRow(),dump=Buffer.from('synthetic isolated SQL dump'),
      proof=signed(row,dump);
    const result=verifyR62Restore({...proof,tenantId:TENANT,
      logicalDump:dump,restoredRow:{...row}});
    assert.equal(result.offlineSignatureValid,true);
    assert.equal(result.restoredRowVerified,true);
    assert.equal(result.logicalExportOnly,true);
    assert.equal(result.walPitrVerified,false);
    assert.equal(result.fullDatabaseRestoreVerified,false);
    assert.equal(result.customerDataRestored,false);
    assert.equal(result.productionCutoverAllowed,false);
  });
test('R6.2 mismatched pending payload, expired signer and changed SQL bytes fail closed',
  ()=>{
    const row=fixtureRow(),dump=Buffer.from('SELECT 1;'),p=signed(row,dump);
    assert.throws(()=>verifyR62Restore({
      ...p,tenantId:TENANT,logicalDump:dump,
      restoredRow:{...row,pending_sha:'f'.repeat(64)}
    }),/restored checkpoint differs/);
    assert.throws(()=>verifyR62Restore({
      ...p,tenantId:TENANT,logicalDump:Buffer.from('SELECT 2;'),
      restoredRow:row
    }),/logical dump digest/);
    assert.throws(()=>verifyR62Restore({
      ...p,tenantId:TENANT,logicalDump:dump,now:()=>p.clock+100000
    }),/expired/);
    const forged={...p.manifest,walLsn:'0/2000'};
    assert.throws(()=>verifyR62Restore({...p,manifest:forged,
      tenantId:TENANT,logicalDump:dump,restoredRow:row
    }),/invalid offline restore signature/);
  });
test('R6.2 refusing a foreign-tenant row or incomplete pending epoch',
  ()=>{
    assert.throws(()=>digestR62Checkpoint({...fixtureRow(),tenant:'other'},TENANT),
      /invalid tenant/);
    assert.throws(()=>digestR62Checkpoint({...fixtureRow(),pending_epoch:8},TENANT),
      /incomplete pending checkpoint/);
  });
async function runPsqlRestore(sql){
  const args=['exec','-i','pg-r62-restore','psql',
    '-v','ON_ERROR_STOP=1','-U','postgres','-d','ox_r62_restore'];
  const child=spawn('docker',args,{stdio:['pipe','pipe','pipe']});
  let error='';
  child.stderr.on('data',b=>{error+=b.toString('utf8');});
  child.stdout.resume();
  child.stdin.on('error',()=>{});
  child.stdin.end(sql);
  await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('exit',code=>code===0?resolve():reject(Error(
      'isolated pg restore exited '+code+': '+error.slice(0,350))));
  });
}
const enabled=process.env.OX_R62_RESTORE_LAB==='YES'&&
  process.env.OX_R59_LAB_ACK==='YES'&&
  process.env.OX_R40_EPHEMERAL==='YES';
function pgConf(port,db='ox_r59'){
  return {host:'127.0.0.1',port,user:'postgres',
    password:'r59-disposable-pg',database:db,
    connectionTimeoutMillis:5000,statement_timeout:10000,max:3};
}
test('R6.2 actual PG15/16 pg_dump to independent empty PostgreSQL restores exact fenced intent',
  {skip:!enabled,timeout:60000},async()=>{
    const version=process.env.OX_R59_POSTGRES_VERSION;
    assert(['15','16'].includes(version));
    const tenantId=randomBytes(12).toString('hex');
    const source=new pg.Pool(pgConf(5543));
    let destination=null,created=false;
    try{
      await source.query(await readFile(
        new URL('../ops/r57/schema.sql',import.meta.url),'utf8'));
      await source.query(
        'INSERT INTO ox_r57_checkpoint_control (tenant,epoch,pending_op,pending_sha,pending_epoch,pending_create,pending_before_version) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [tenantId,15,'a'.repeat(32),'b'.repeat(64),15,true,null]);
      const from=(await source.query(
        'SELECT * FROM ox_r57_checkpoint_control WHERE tenant=$1',
        [tenantId])).rows[0];
      const lsn=(await source.query(
        'SELECT pg_current_wal_lsn()::text AS lsn')).rows[0].lsn;
      const dump=Buffer.from((await run('docker',[
        'exec','pg-r59-primary','pg_dump','--data-only','--inserts',
        '--table=public.ox_r57_checkpoint_control','-U','postgres',
        '-d','ox_r59'
      ],{timeout:20000,maxBuffer:2*1024*1024})).stdout);
      assert(dump.toString('utf8').includes('INSERT INTO'));
      const pair=generateKeyPairSync('ed25519'),now=Date.now();
      const manifest=signR62RestoreManifest({
        privateKey:pair.privateKey,payload:{
          format:'osmanx-r62-logical-restore-v1',scope:'disposable-lab',
          tenantId,walLsn:lsn,
          dumpSha256:shaR62(dump),
          checkpointSha256:digestR62Checkpoint(from,tenantId),
          nonce:randomBytes(16).toString('hex'),issuedAt:now-1000,
          expiresAt:now+120000
        }
      });
      const receipt=verifyR62Restore({
        manifest,publicKey:pair.publicKey,tenantId,logicalDump:dump
      });
      assert.equal(receipt.dumpVerified,true);
      assert.equal(receipt.restoredRowVerified,false);
      await assert.rejects(run('docker',['container','inspect','pg-r62-restore']),
        /Command failed|No such object/);
      await run('docker',['run','-d','--name','pg-r62-restore',
        '--network','ox-r59-net','-p','127.0.0.1:5545:5432',
        '-e','POSTGRES_PASSWORD=r59-disposable-pg',
        '-e','POSTGRES_DB=ox_r62_restore',
        'postgres:'+version],{timeout:20000});
      created=true;
      destination=new pg.Pool(pgConf(5545,'ox_r62_restore'));
      let ready=false;
      for(let i=0;i<60;i++){
        try{await destination.query('SELECT 1');ready=true;break;}
        catch{await new Promise(ok=>setTimeout(ok,200));}
      }
      assert.equal(ready,true);
      await destination.query(await readFile(
        new URL('../ops/r57/schema.sql',import.meta.url),'utf8'));
      // Verify the detached logical dump before passing it to psql.
      verifyR62Restore({manifest,publicKey:pair.publicKey,tenantId,
        logicalDump:dump});
      await runPsqlRestore(dump);
      const after=(await destination.query(
        'SELECT * FROM ox_r57_checkpoint_control WHERE tenant=$1',
        [tenantId])).rows[0];
      const checked=verifyR62Restore({
        manifest,publicKey:pair.publicKey,tenantId,
        logicalDump:dump,restoredRow:after
      });
      assert.equal(checked.restoredRowVerified,true);
      assert.equal(after.pending_op,'a'.repeat(32));
      assert.equal(after.pending_sha,'b'.repeat(64));
      assert.equal(after.committed_op,null);
      assert.equal(checked.walPitrVerified,false);
    }finally{
      await Promise.all([source.end().catch(()=>{}),
        destination?.end().catch(()=>{})]);
      if(created)await run('docker',['rm','-f','pg-r62-restore'])
        .catch(()=>{});
    }
  });
