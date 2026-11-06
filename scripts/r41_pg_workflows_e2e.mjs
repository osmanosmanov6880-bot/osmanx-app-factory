#!/usr/bin/env node
// R4.0 true HTTP + PostgreSQL integration. Synthetic local database ONLY.
// Creates private temporary Studio + two CRM SQLite fixtures, signs their
// migration, imports into real PostgreSQL, and tests a limited LOGIN role.
// NEVER operates on a production database or changes the primary runtime.
import { randomBytes, randomUUID,createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as createTcpListener } from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {createR47ObjectReceiver} from '../src/migration/r47-receiver.mjs';
import {createR48WitnessReceiver} from '../src/migration/r48-witness.mjs';
import { mkdtemp, mkdir, rm, rename, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { studioDb } from '../src/studio/db.mjs';
import { crmDb } from '../src/crm/db.mjs';
import { issueSession } from '../src/common/security.mjs';
import { exportMigration } from '../src/migration/pg-kit.mjs';
import { createSigningIdentity, signMigration, verifyTrustedMigration } from '../src/migration/pg-trust.mjs';
import { applyPostgres, applyTenantAcl, verifyPostgresSnapshot } from '../src/migration/pg-operations.mjs';
import { runPsql, requireEmptyTarget } from '../src/migration/r39-acceptance.mjs';

const ownerA='11111111-1111-4111-8111-111111111111';
const ownerB='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const projectA='22222222-2222-4222-8222-222222222222';
const projectB='33333333-3333-4333-8333-333333333333';
const existingA='44444444-4444-4444-8444-444444444444';
const existingB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const staffA='88888888-8888-4888-8888-888888888888';
const managerA='99999999-9999-4999-8999-999999999999';
const taskInitial='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const now='2026-11-06T00:00:00.000Z';
const testName='ox_test_factory_r40';
const r42Secret=randomBytes(32).toString('hex');
const r46CatalogKey=randomBytes(32).toString('hex');
const r46OldKey=randomBytes(32).toString('hex');
const r46NewKey=randomBytes(32).toString('hex');
const r47Bearer=randomBytes(32).toString('hex');
let r47Endpoint='';
const r48WitnessKey=randomBytes(32).toString('hex');
const r48QueueKey=randomBytes(32).toString('hex');
const r48WebhookKey=randomBytes(32).toString('hex');
const r48Bearer=randomBytes(32).toString('hex');
let r48WitnessEndpoint='',r48AlertEndpoint='';
const r49WitnessKey=randomBytes(32).toString('hex');
const r49WitnessToken=randomBytes(32).toString('hex');
let r49WitnessEndpoint='';
let r46NextKeyActive=false;
function check(ok,message) {if(!ok)throw Error(message);}
function guard(){
  check(process.argv.includes('--confirm-synthetic') && process.env.OX_R40_EPHEMERAL==='YES',
    'R4.0 requires explicit synthetic test opt-in');
  check(process.env.PGDATABASE===testName,'R4.0 requires exact isolated PostgreSQL test database');
  check(['127.0.0.1','localhost','::1'].includes(process.env.PGHOST),'R4.0 requires localhost Postgres');
  check(!process.env.PGHOSTADDR || ['127.0.0.1','::1'].includes(process.env.PGHOSTADDR),'PGHOSTADDR override forbidden');
  check(!process.env.PGSERVICE && !process.env.PGSERVICEFILE && !process.env.PGOPTIONS && !process.env.DATABASE_URL,'PG service overrides forbidden');
  check(process.env.PGUSER==='postgres' && process.env.PGPASSWORD && Number(process.env.PGPORT)>=1024,
    'R4.0 requires dedicated ephemeral admin connection');
  const version=runPsql("SELECT current_database() || '|' || current_setting('server_version_num');");
  check(version.ok && /^ox_test_factory_r40\|1[5-9]\d{4,}$/.test(version.stdout),'Wrong test database or unsupported PostgreSQL');
  requireEmptyTarget();
  return Number(version.stdout.split('|')[1]);
}
async function freePort(){
  const socket=createTcpListener();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;
}
async function launchFactory(dataDir,bundle,keyPath,pgUser,pgPass){
  const port=await freePort();
  const env={...process.env,DATA_DIR:dataDir,PORT:String(port),HOST:'127.0.0.1',
    PGUSER:pgUser,PGPASSWORD:pgPass, OX_R40_PG_PREVIEW:'YES',
    OX_R40_PG_BUNDLE:bundle,OX_R40_PG_TRUST_KEY:keyPath,OX_R40_EPHEMERAL:'YES',
     OX_R42_PG_RECONCILIATION:'YES',OX_R42_JOURNAL_HMAC_KEY:r42Secret,
    ...(process.env.OX_R43_E2E==='YES'?{OX_R43_SHADOW_REPLAY:'YES',OX_R43_CONFIRM_SYNTHETIC:'YES'}:{}),
    ...(process.env.OX_R44_E2E==='YES'?{OX_R44_CRITICAL_PARITY:'YES',OX_R44_CONFIRM_SYNTHETIC:'YES'}:{}),
    ...(process.env.OX_R45_E2E==='YES'?{OX_R45_BACKUP_DRILL:'YES',OX_R45_CONFIRM_SYNTHETIC:'YES'}:{}),
    ...(process.env.OX_R46_E2E==='YES'?{
      OX_R46_VAULT:'YES',OX_R46_CONFIRM_SYNTHETIC:'YES',
      OX_R46_CATALOG_KEY_HEX:r46CatalogKey,OX_R46_RETENTION_COUNT:'2',
      OX_R46_ACTIVE_KEY_ID:r46NextKeyActive?'key_two':'key_one',
      OX_R46_ACTIVE_KEY_HEX:r46NextKeyActive?r46NewKey:r46OldKey,
      ...(r46NextKeyActive?{
        OX_R46_PREVIOUS_KEY_ID:'key_one',OX_R46_PREVIOUS_KEY_HEX:r46OldKey
      }:{})
    }:{}),
    ...(process.env.OX_R47_E2E==='YES'?{
      OX_R47_OFFSITE:'YES',OX_R47_CONFIRM_SYNTHETIC:'YES',
      OX_R47_ENDPOINT:r47Endpoint,OX_R47_REMOTE_TOKEN:r47Bearer,
      OX_R47_LOOPBACK_TEST:'YES',OX_R47_INTERVAL_MINUTES:'60',
      OX_R47_MAX_AGE_MINUTES:'180',OX_R47_SCHEDULE_PROJECT_IDS:projectA
    }:{}),
    ...(process.env.OX_R48_E2E==='YES'?{
      OX_R48_PROTECTION:'YES',OX_R48_CONFIRM_SYNTHETIC:'YES',
      OX_R48_WITNESS_ENDPOINT:r48WitnessEndpoint,
      OX_R48_WITNESS_TOKEN:r48Bearer,
      OX_R48_WITNESS_KEY_HEX:r48WitnessKey,
      OX_R48_ALERT_QUEUE_KEY_HEX:r48QueueKey,
      OX_R48_ALERT_WEBHOOK_KEY_HEX:r48WebhookKey,
      OX_R48_ALERT_ENDPOINT:r48AlertEndpoint,
      OX_R48_LOOPBACK_TEST:'YES'
    }:{})};
  const server=spawn(process.execPath,['server.mjs'],{cwd:new URL('../',import.meta.url),env,stdio:['ignore','pipe','pipe']});
  let tail='';let closed=false;
  server.stderr.on('data',b=>{tail=(tail+b.toString('utf8')).slice(-600);});
  server.once('close',()=>{closed=true;});
  const url=`http://127.0.0.1:${port}`;
  for(let i=0;i<100;i++){
    if(closed) throw Error('Factory failed startup during test (private server diagnostics withheld)');
    try{const result=await fetch(url+'/api/health',{signal:AbortSignal.timeout(500)});if(result.status===200)return {server,url,stop:()=>stopFactory(server)};}catch{}
    await sleep(100);
  }
  await stopFactory(server);
  throw Error('Factory startup timed out (private server diagnostics withheld)');
}
async function stopFactory(child){
  if(child.exitCode!==null || child.signalCode!==null)return;
  child.kill('SIGTERM');
  const result=await Promise.race([
    new Promise(resolve=>child.once('close',resolve)),sleep(5000).then(()=>null)
  ]);
  if(result===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));}
}
function authRequest(base,token,csrf,cookieName='ox_studio'){
  return async (path,method='GET',body,overrideCsrf)=>{
    const headers={cookie:`${cookieName}=${token}`, 'cache-control':'no-store'};
    if(body!==undefined)headers['content-type']='application/json';
    if(method!=='GET')headers['x-csrf-token']=overrideCsrf===undefined?csrf:overrideCsrf;
    const response=await fetch(base+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
    return {status:response.status,data:await response.json()};
  };
}
function insertStudioFixtures(studio){
  for(const [owner,project,name] of [[ownerA,projectA,'Owner A'],[ownerB,projectB,'Owner B']]){
    studio.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(owner,owner+'@example.test',name,'synthetic-only','owner',1,now);
    studio.prepare('INSERT INTO projects(id,owner_id,name,type,industry,modules_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(project,owner,name,'crm','restaurant',JSON.stringify(['auth','clients','tasks']),JSON.stringify({accent:'#234567'}),now,now);
  }
  return [issueSession(studio,ownerA),issueSession(studio,ownerB)];
}
function seedCrm(path,clientId,person,{staff=false}={}){
  const r44=staff&&process.env.OX_R44_E2E==='YES';
  const customDefinitions=r44?[{
    slug:'orders',title:'Synthetic orders',description:'',access:{
      read:['admin','manager','staff'],write:['admin','manager']},
    fields:[{key:'ticket',label:'Ticket',type:'text',required:false}]
  }]:[];
  const db=crmDb(path,customDefinitions);
  try{
    db.prepare('INSERT INTO clients(id,full_name,phone,email,source,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(clientId,person,'','','walkin','',now,now);
    if(!staff)return null;
    for(const [id,role] of [[staffA,'staff'],[managerA,'manager']]){
      db.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id,id+'@example.test',role,'synthetic',''+role,1,now);
    }
    db.prepare(`INSERT INTO tasks(id,title,description,status,priority,due_at,client_id,assigned_to,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(taskInitial,'Imported assigned task','','todo','medium',null,clientId,staffA,managerA,now,now);
    if(r44){
      const paymentId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
      const ruleId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
      db.prepare(`INSERT INTO payments(id,client_id,amount_minor,currency,method,status,
        external_reference,note,idem_key,request_fingerprint,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(paymentId,clientId,12500,'RUB','terminal','paid','','Synthetic invoice',
          'synthetic-r44-payment','synthetic-only-fingerprint',managerA,now,now);
      db.prepare(`INSERT INTO automations(id,name,event,task_title,priority,enabled,created_by,
        created_at,entity_slug,condition_field,condition_value,due_days)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(ruleId,'Notify about order','entity_created','Call client','medium',1,managerA,now,
          'orders',null,null,0);
      db.prepare('INSERT INTO automation_runs(id,automation_id,event_key,task_id,created_at) VALUES(?,?,?,?,?)')
        .run('ffffffff-ffff-4fff-8fff-ffffffffffff',ruleId,'synthetic-r44-event',taskInitial,now);
      db.prepare(`INSERT INTO custom_orders(id,version,created_at,updated_at,archived_at,
        created_by,ticket) VALUES(?,?,?,?,?,?,?)`)
        .run('abababab-abab-4aba-8aba-abababababab',1,now,now,null,managerA,'Test booking');
    }
    return {staff:issueSession(db,staffA),manager:issueSession(db,managerA)};
  }finally{db.close();}
}
async function main(){
  const version=guard();
  // The driver is loaded only in explicitly enabled test/runtime contexts.
  const {Pool}=await import('pg');
  const dir=await mkdtemp(join(tmpdir(),'ox-r40-http-'));
  let server,adminPool,offsiteServer,witnessServer,alertServer,witness49Server;
  const alertReceived=[];
  try{
    if(process.env.OX_R47_E2E==='YES'){
      offsiteServer=createHttpServer(createR47ObjectReceiver({root:join(dir,'offsite-receiver'),token:r47Bearer}));
      await new Promise(resolve=>offsiteServer.listen(0,'127.0.0.1',resolve));
      r47Endpoint='http://127.0.0.1:'+offsiteServer.address().port+'/';
    }
    if(process.env.OX_R48_E2E==='YES'){
      witnessServer=createHttpServer(createR48WitnessReceiver({
        root:join(dir,'independent-witness'),token:r48Bearer,
        secret:Buffer.from(r48WitnessKey,'hex')}));
      await new Promise(resolve=>witnessServer.listen(0,'127.0.0.1',resolve));
      r48WitnessEndpoint='http://127.0.0.1:'+witnessServer.address().port+'/';
      alertServer=createHttpServer(async(req,res)=>{
        const pieces=[];for await(const x of req)pieces.push(x);
        const bytes=Buffer.concat(pieces),stamp=req.headers['x-ox-alert-at'];
        const signature=createHmac('sha256',Buffer.from(r48WebhookKey,'hex'))
          .update('OSMANX-R48-WEBHOOK-v1\0').update(String(stamp)).update('\0')
          .update(bytes).digest('hex');
        if(req.method!=='POST'||req.url!=='/v1/alerts'||
          req.headers['x-ox-alert-signature']!==signature){
          res.writeHead(403);res.end();return;
        }
        alertReceived.push(JSON.parse(bytes.toString('utf8')));
        res.writeHead(204);res.end();
      });
      await new Promise(resolve=>alertServer.listen(0,'127.0.0.1',resolve));
      r48AlertEndpoint='http://127.0.0.1:'+alertServer.address().port+'/';
    }
    if(process.env.OX_R49_E2E==='YES'){
      check(process.env.OX_R49_S3_ENDPOINT?.startsWith('http://127.0.0.1:')&&
        process.env.OX_R49_S3_BUCKET==='r49-synthetic-worm'&&
        process.env.OX_R49_S3_ACCESS_KEY&&process.env.OX_R49_S3_SECRET_KEY,
        'R4.9 requires isolated live MinIO on loopback and synthetic credentials');
      witness49Server=createHttpServer(createR48WitnessReceiver({
        root:join(dir,'r49-separate-witness'),
        token:r49WitnessToken,secret:Buffer.from(r49WitnessKey,'hex')}));
      await new Promise(resolve=>witness49Server.listen(0,'127.0.0.1',resolve));
      r49WitnessEndpoint='http://127.0.0.1:'+witness49Server.address().port+'/';
    }
    const dataDir=join(dir,'data');const bundle=join(dir,'signed-export');
    await mkdir(join(dataDir,'projects'),{recursive:true,mode:0o700});
    const studio=studioDb(join(dataDir,'studio.sqlite'));
    let sA,sB;
    try{[sA,sB]=insertStudioFixtures(studio);}finally{studio.close();}
    const employees=seedCrm(join(dataDir,'projects',projectA+'.sqlite'),existingA,'Original A',{staff:true});
    seedCrm(join(dataDir,'projects',projectB+'.sqlite'),existingB,'Original B');
    await exportMigration(dataDir,bundle,{allowSensitive:true});
    const keys=await createSigningIdentity(join(dir,'keys'));
    await signMigration(bundle,keys.privateKey);
    const signed=await verifyTrustedMigration(bundle,keys.publicKey);
    check(signed.manifest.databases.length===3,'Two synthetic tenant manifests required');
    const imported=await applyPostgres(bundle,{confirm:true,trustedPublicKey:keys.publicKey,timeoutMs:180000});
    check(imported.state==='imported-verified','Signed PostgreSQL import verification failed');
    const acl=await applyTenantAcl(bundle,{confirm:true,trustedPublicKey:keys.publicKey,timeoutMs:120000});
    check(acl.tenantIsolationVerified,'Postgres ACL not independently verified');
    const before=await verifyPostgresSnapshot(bundle);
    check(before.ok===true,'Initial PostgreSQL snapshot rejected');

    const adminConfig={host:process.env.PGHOST,port:Number(process.env.PGPORT),database:process.env.PGDATABASE,
      user:process.env.PGUSER,password:process.env.PGPASSWORD,ssl:false,max:2};
    adminPool=new Pool(adminConfig);
    const pgUser='ox_r40_runtime', password=randomBytes(32).toString('hex');
    // Dedicated non-superuser and NOINHERIT login; membership only in the 4
    // signed tenant NOLOGIN roles. Unscoped login cannot SELECT customer tables.
    await adminPool.query(`CREATE ROLE "ox_r40_runtime" LOGIN NOINHERIT PASSWORD '${password}'`);
    for (const role of signed.manifest.access.roles.filter(r=>r.schema!=='ox_studio')){
      await adminPool.query(`GRANT "${role.reader}", "${role.writer}" TO "ox_r40_runtime"`);
    }
    const effective=await adminPool.query("SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolinherit FROM pg_roles WHERE rolname='ox_r40_runtime'");
    check(effective.rows.length===1 && Object.values(effective.rows[0]).every(v=>v===false),'Test login is privileged');

    const live=await launchFactory(dataDir,bundle,keys.publicKey,pgUser,password);
    server=live.server;
    const reqA=authRequest(live.url,sA.token,sA.csrf),reqB=authRequest(live.url,sB.token,sB.csrf);
    const pathA='/api/studio/pg-preview/projects/'+projectA+'/clients';
    const pathB='/api/studio/pg-preview/projects/'+projectB+'/clients';
    let checks=0,vaultSurvivorId;
    const requireStatus=(r,expected,label)=>{check(r.status===expected,`${label}: HTTP ${r.status}`);checks++;};
    requireStatus(await reqA('/api/studio/pg-preview/status'),200,'Preview status');
    const reconcilePath='/api/studio/pg-preview/projects/'+projectA+'/reconcile';
    const pristine=await reqA(reconcilePath+'/check','POST');
    requireStatus(pristine,200,'R4.2 pristine signed import');
    check(pristine.data.report.ok===true&&pristine.data.report.totalDifferences===0&&
      pristine.data.readiness.productionCutoverAllowed===false,'Initial signed reconciliation mismatch');checks++;
    requireStatus(await reqB(reconcilePath+'/check','POST'),404,'R4.2 foreign owner denied');
    if(process.env.OX_R45_E2E==='YES'){
      const drillPath='/api/studio/pg-preview/projects/'+projectA+'/backup-drill';
      const receipt=await reqA(drillPath+'/check','POST');
      requireStatus(receipt,200,'R4.5 encrypted CRM backup and signed restore');
      const proof=receipt.data.receipt;
      check(proof?.verified===true&&proof.signedManifestVerified===true&&
        proof.encryptedArchiveVerified===true&&proof.decryptedBytesVerified===true&&
        proof.sqliteIntegrityVerified===true&&proof.foreignKeyIntegrityVerified===true&&
        proof.financialRecords>=1&&proof.automationRules>=1&&proof.automationRuns>=1&&
        proof.customEntities>=1&&proof.customRecords>=1&&
        /^[a-f0-9]{64}$/.test(proof.financialTotalsHmac)&&
        proof.sourcePrimaryModified===false&&proof.productionCutoverAllowed===false,
        'R4.5 encrypted backup restoration or financial proof failed');checks++;
      check(!JSON.stringify(receipt.data).includes('Synthetic invoice')&&
        !JSON.stringify(receipt.data).includes('Test booking'),'R4.5 leaked CRM record values');checks++;
      requireStatus(await reqB(drillPath+'/check','POST'),404,'R4.5 cross-owner backup denied');
      requireStatus(await reqA(drillPath+'/check','POST',undefined,'wrong-csrf'),403,
        'R4.5 CSRF backup rejected');
      requireStatus(await reqA(drillPath+'/check','GET'),405,'R4.5 GET cannot run backup drill');
      const history=await reqA(drillPath+'/history');
      requireStatus(history,200,'R4.5 verified encrypted restore evidence history');
      check(history.data.entries===1&&history.data.history[0].verified===true,
        'R4.5 evidence journal missing');checks++;
      const unchanged=crmDb(join(dataDir,'projects',projectA+'.sqlite'));
      try{
        check(unchanged.prepare('SELECT amount_minor FROM payments').get().amount_minor===12500&&
          unchanged.prepare('SELECT count(*) AS n FROM clients').get().n===1,
          'R4.5 unexpectedly modified live primary');checks++;
      }finally{unchanged.close();}
    }
    if(process.env.OX_R46_E2E==='YES'){
      const vault='/api/studio/pg-preview/projects/'+projectA+'/backup-vault';
      const copies=[];
      for(let n=0;n<3;n++){
        const result=await reqA(vault+'/create','POST');
        requireStatus(result,200,'R4.6 create retained encrypted archive '+n);
        check(result.data.result?.archiveRetained===true&&
          result.data.result?.restoredIntegrityVerified===true&&
          result.data.result?.sourcePrimaryModified===false&&
          result.data.result?.productionCutoverAllowed===false,
          'R4.6 newly retained backup failed signed restore gate');checks++;
        copies.push(result.data.result.archive.id);
      }
      const listing=await reqA(vault+'/list');
      requireStatus(listing,200,'R4.6 authenticated persisted vault catalog');
      check(listing.data.index.activeCount===3&&listing.data.index.catalogVerified===true,
        'R4.6 encrypted archive catalog lost data');checks++;
      const verified=await reqA(vault+'/verify/'+copies[2],'POST');
      requireStatus(verified,200,'R4.6 restore latest retained signed archive');
      check(verified.data.result.verified===true&&verified.data.result.payments>=1,
        'R4.6 archived synthetic financial records unavailable');checks++;
      requireStatus(await reqB(vault+'/create','POST'),404,'R4.6 cross-owner archive creation forbidden');
      requireStatus(await reqA(vault+'/create','GET'),405,'R4.6 GET cannot persist an archive');
      requireStatus(await reqA(vault+'/create','POST',undefined,'bad-csrf'),403,'R4.6 CSRF archive denial');
      const cleaned=await reqA(vault+'/prune','POST');
      requireStatus(cleaned,200,'R4.6 verified retention prunes oldest');
      check(cleaned.data.result.removed.length===1&&
        cleaned.data.result.allActiveVerifiedBeforeRetirement===true,
        'R4.6 retention did not verify archives before retirement');checks++;
      const gone=await reqA(vault+'/verify/'+copies[0],'POST');
      requireStatus(gone,409,'R4.6 retired archives cannot be restored');
      vaultSurvivorId=copies[2];
    }
    if(process.env.OX_R47_E2E==='YES'){
      const route='/api/studio/pg-preview/projects/'+projectA+'/offsite';
      const before=await reqA(route+'/status');
      requireStatus(before,200,'R4.7 offsite status before first sync');
      check(before.data.healthy===false,'R4.7 no backup must never report healthy');checks++;
      const published=await reqA(route+'/sync','POST');
      requireStatus(published,200,'R4.7 encrypted remote sync');
      check(published.data.result.published.uploadedArchives===2&&
        published.data.result.restoreProof.restoredIntegrityVerified===true,
        'R4.7 offsite snapshot did not verify');checks++;
      // The signed manifest/keys and remote ciphertext suffice even after
      // complete loss of the original local archive directory.
      const vaultRoot=join(dataDir,'.r46-encrypted-vault',projectA);
      const disconnected=join(dir,'temporarily-disconnected-vault');
      await rename(vaultRoot,disconnected);
      try{
        const independent=await reqA(route+'/restore-check','POST');
        requireStatus(independent,200,'R4.7 independent remote restore without local vault');
        check(independent.data.result.financialRecords>=1&&
          independent.data.result.restoredIntegrityVerified===true,
          'R4.7 disaster restore cannot recover signed financial records');checks++;
      }finally{await rename(disconnected,vaultRoot);}
      const scheduled=await reqA(route+'/tick','POST');
      requireStatus(scheduled,200,'R4.7 scheduled backup creation and remote replication');
      check(scheduled.data.result.ran===true&&
        scheduled.data.result.proof.remoteReadbackVerified===true,
        'R4.7 scheduled tick not committed');checks++;
      const skipped=await reqA(route+'/tick','POST');
      requireStatus(skipped,200,'R4.7 scheduled interval prevents duplicate backup');
      check(skipped.data.result.ran===false,'R4.7 duplicate tick was not suppressed');checks++;
      const health=await reqA(route+'/status');
      requireStatus(health,200,'R4.7 offsite and schedule status');
      check(health.data.healthy===true&&health.data.remoteHealth.remoteMatchesLocal===true,
        'R4.7 status failed despite authenticated remote copy');checks++;
      requireStatus(await reqB(route+'/sync','POST'),404,'R4.7 cross-tenant remote sync forbidden');
      requireStatus(await reqA(route+'/sync','POST',undefined,'bad-csrf'),403,
        'R4.7 remote sync CSRF denied');
      requireStatus(await reqA(route+'/sync','GET'),405,'R4.7 GET cannot trigger uploads');
      const tenantToken=(await import('../src/migration/r47-offsite.mjs')).r47TenantToken(
        Buffer.from(r46CatalogKey,'hex'),projectA);
      const headPath=join(dir,'offsite-receiver',tenantToken,'head.json');
      const goodHead=await readFile(headPath);
      await writeFile(headPath,Buffer.from('{"forged":true}'));
      try{
        requireStatus(await reqA(route+'/restore-check','POST'),409,
          'R4.7 remote head tampering denied');
      }finally{await writeFile(headPath,goodHead);}
    }
    if(process.env.OX_R48_E2E==='YES'){
      const route='/api/studio/pg-preview/projects/'+projectA+'/recovery';
      const initial=await reqA(route+'/sync','POST');
      requireStatus(initial,200,'R4.8 external witness confirms remote signed catalog');
      check(initial.data.result.witnessConfirmed===true,'R4.8 independent witness not confirmed');checks++;
      const token=(await import('../src/migration/r47-offsite.mjs'))
        .r47TenantToken(Buffer.from(r46CatalogKey,'hex'),projectA);
      const headPath=join(dir,'offsite-receiver',token,'head.json');
      const oldHead=await readFile(headPath);
      const extra=await reqA('/api/studio/pg-preview/projects/'+projectA+'/backup-vault/create','POST');
      requireStatus(extra,200,'R4.8 new signed local backup advances remote catalog');
      const updated=await reqA(route+'/sync','POST');
      requireStatus(updated,200,'R4.8 independent witness advances monotonically');
      const goodHead=await readFile(headPath);
      await writeFile(headPath,oldHead);
      try{
        requireStatus(await reqA(route+'/drill','POST'),409,
          'R4.8 older valid remote head rejected by independent witness');
        const badStatus=await reqA(route+'/status');
        requireStatus(badStatus,200,'R4.8 witnessed status detects rollback');
        check(badStatus.data.healthy===false&&badStatus.data.alerts.pending>=1,
          'R4.8 rollback was erroneously shown as healthy');checks++;
        const delivered=await reqA(route+'/alerts','POST');
        requireStatus(delivered,200,'R4.8 durable alert queue dispatched signed failure');
        check(delivered.data.result.delivered>=1&&
          alertReceived.some(x=>x.code==='ROLLBACK_DETECTED')&&
          alertReceived.every(x=>!JSON.stringify(x).includes('Synthetic invoice')),
          'R4.8 alerts missing or leaking client details');checks++;
      }finally{await writeFile(headPath,goodHead);}
      const restored=await reqA(route+'/drill','POST');
      requireStatus(restored,200,'R4.8 measured independently witnessed disaster recovery');
      check(restored.data.result.signedRestoreVerified===true&&
        restored.data.result.meetsTargets===true&&
        restored.data.result.financialRecords>=1&&
        Number.isInteger(restored.data.result.rtoMs)&&
        restored.data.result.productionCutoverAllowed===false,
        'R4.8 measured remote restore proof not accepted');checks++;
      const pruned=await reqA('/api/studio/pg-preview/projects/'+projectA+'/backup-vault/prune','POST');
      requireStatus(pruned,200,'R4.8 restore original retention count before restart');
      // Retention now advances the oldest surviving R4.6 fixture: use
      // the newly verified key_one archive when rehearsing restart/rotation.
      vaultSurvivorId=extra.data.result.archive.id;
      const prunedSync=await reqA(route+'/sync','POST');
      requireStatus(prunedSync,200,'R4.8 witness advances to retained archive set');
      requireStatus(await reqB(route+'/sync','POST'),404,'R4.8 cross-tenant witness denied');
      requireStatus(await reqA(route+'/sync','POST',undefined,'bad-csrf'),403,
        'R4.8 CSRF protects witness and remote storage');
      requireStatus(await reqA(route+'/sync','GET'),405,'R4.8 GET cannot alter remote witness');
    }
    const firstA=await reqA(pathA);requireStatus(firstA,200,'Owner A read');
    check(firstA.data.clients.length===1 && firstA.data.clients[0].fullName==='Original A','Owner A sees only own imported rows');checks++;
    const firstB=await reqB(pathB);requireStatus(firstB,200,'Owner B read');
    check(firstB.data.clients.length===1 && firstB.data.clients[0].fullName==='Original B','Owner B sees only own imported rows');checks++;
    requireStatus(await reqA(pathB),404,'Cross tenant project forbidden');
    requireStatus(await reqB(pathA),404,'Reverse cross tenant forbidden');
    requireStatus(await reqA(pathA+'/not-a-uuid'),404,'Invalid client id rejected');
    requireStatus(await reqA(pathA,'POST',{fullName:'No csrf'},'bad-csrf'),403,'CSRF denied');
    const created=await reqA(pathA,'POST',{fullName:'New PG client',phone:'+79990000000',source:'website'});
    requireStatus(created,201,'Create PostgreSQL client');
    check(created.data.client.fullName==='New PG client','Created client returned from PG');checks++;
    const id=created.data.client.id;
    const edited=await reqA(pathA+'/'+id,'PATCH',{fullName:'Updated PG client',notes:'synthetic'});
    requireStatus(edited,200,'Update PostgreSQL client');
    check(edited.data.client.notes==='synthetic','Updated row returned from PostgreSQL');checks++;
    if(process.env.OX_R43_E2E==='YES'){
      const quick1=await reqA(pathA+'/'+id,'PATCH',{notes:'First fast edit'});
      const quick2=await reqA(pathA+'/'+id,'PATCH',{notes:'Second fast edit'});
      requireStatus(quick1,200,'R4.3 first monotonic client version');
      requireStatus(quick2,200,'R4.3 second monotonic client version');
      check(quick1.data.client.updatedAt>edited.data.client.updatedAt &&
        quick2.data.client.updatedAt>quick1.data.client.updatedAt &&
        quick2.data.client.notes==='Second fast edit','R4.3 client revision not monotonic');checks++;
    }
    const batch=await reqA(pathA+'/batch','POST',{items:[{fullName:'Batch 1'},{fullName:'Batch 2'}]});
    requireStatus(batch,201,'Atomic two-client batch');checks+=Number(batch.data.clients?.length===2);
    const beforeFailed=(await reqA(pathA)).data.clients.length;
    const failed=await reqA(pathA+'/batch','POST',{items:[{fullName:'Must rollback'},{fullName:''}]});
    requireStatus(failed,400,'Later validation failure');
    const afterFailed=(await reqA(pathA)).data.clients;
    check(afterFailed.length===beforeFailed && !afterFailed.some(c=>c.fullName==='Must rollback'),
      'Real PostgreSQL failed batch must roll back first insert');checks++;
    const crossClient=await reqA(pathA+'/'+existingB);
    requireStatus(crossClient,404,'Cross tenant client lookup');
    const afterB=await reqB(pathB);requireStatus(afterB,200,'Owner B unaffected');
    check(afterB.data.clients.length===1 && afterB.data.clients[0].id===existingB,'Tenant B data unchanged');checks++;

    // Verify neither imported SQLite source was modified by PG Preview writes.
    const oldCrm=crmDb(join(dataDir,'projects',projectA+'.sqlite'));
    try{check(oldCrm.prepare('SELECT count(*) n FROM clients').get().n===1,'Legacy SQLite changed unexpectedly');}
    finally{oldCrm.close();}checks++;
    const pgCount=await adminPool.query(`SELECT count(*)::int AS n FROM "ox_p_${projectA.replaceAll('-','')}".clients`);
    check(pgCount.rows[0].n===4,'Postgres commit and rollback counts mismatch');checks++;

    // As the unscoped non-inheriting login, even a known tenant schema is inaccessible.
    const limited=new Pool({...adminConfig,user:pgUser,password,max:1});
    let unscopedDenied=false;
    try{await limited.query(`SELECT count(*) FROM "ox_p_${projectA.replaceAll('-','')}".clients`);}
    catch(e){unscopedDenied=e.code==='42501';}
    finally{await limited.end();}
    check(unscopedDenied,'Unscoped runtime login could directly read tenant rows');checks++;
    // R4.1: real PostgreSQL tasks and visits, plus genuine CRM employee sessions.
    const staffReq=authRequest(live.url,employees.staff.token,employees.staff.csrf,'ox_crm');
    const managerReq=authRequest(live.url,employees.manager.token,employees.manager.csrf,'ox_crm');
    const tasksA='/api/studio/pg-preview/projects/'+projectA+'/tasks';
    const visitsA='/api/studio/pg-preview/projects/'+projectA+'/visits';
    const taskStaff='/workspace/'+projectA+'/api/pg-preview/tasks';
    const visitStaff='/workspace/'+projectA+'/api/pg-preview/visits';
    const taskOther='/workspace/'+projectB+'/api/pg-preview/tasks';
    const importedTasks=await reqA(tasksA);
    requireStatus(importedTasks,200,'Owner reads imported PG tasks');
    check(importedTasks.data.tasks.some(t=>t.id===taskInitial),'Imported task absent from PostgreSQL');checks++;
    const staffList=await staffReq(taskStaff);requireStatus(staffList,200,'Employee sees assigned tasks');
    check(staffList.data.tasks.every(t=>t.assignedTo===staffA) && staffList.data.tasks.length===1,'Employee task scoping failed');checks++;
    requireStatus(await staffReq(taskOther),401,'Foreign project employee session denied');
    requireStatus(await staffReq(tasksA),401,'Employee cannot impersonate Studio owner');
    requireStatus(await staffReq(taskStaff,'POST',{title:'Must not create'}),403,'Staff cannot assign tasks');
    requireStatus(await managerReq(taskStaff,'POST',{title:'Wrong client',clientId:existingB}),409,'Manager cannot link foreign client');
    requireStatus(await managerReq(taskStaff,'POST',{title:'Unknown employee',assignedTo:existingB}),409,'Unknown assignee denied');
    const madeTask=await managerReq(taskStaff,'POST',{title:'New task',clientId:existingA,assignedTo:staffA,priority:'high'});
    requireStatus(madeTask,201,'Manager creates linked PG task');
    check(madeTask.data.task.createdBy===managerA && madeTask.data.task.assignedTo===staffA,'Manager task metadata wrong');checks++;
    const ownerTask=await reqA(tasksA,'POST',{title:'Owner-only task'});
    requireStatus(ownerTask,201,'Studio owner creates PG task');
    const ownerTaskId=ownerTask.data.task.id;
    requireStatus(await staffReq(taskStaff+'/'+ownerTaskId,'PATCH',{status:'done',expectedUpdatedAt:ownerTask.data.task.updatedAt}),404,
      'Staff cannot modify unassigned task');
    requireStatus(await staffReq(taskStaff+'/'+madeTask.data.task.id,'PATCH',{
      assignedTo:managerA,expectedUpdatedAt:madeTask.data.task.updatedAt}),403,'Staff cannot reassign');
    const first=await staffReq(taskStaff+'/'+madeTask.data.task.id,'PATCH',{
      status:'doing',expectedUpdatedAt:madeTask.data.task.updatedAt});
    requireStatus(first,200,'Staff changes own task status');
    requireStatus(await staffReq(taskStaff+'/'+madeTask.data.task.id,'PATCH',{
      status:'done',expectedUpdatedAt:madeTask.data.task.updatedAt}),409,'Stale task update rejected');
    // Two simultaneous HTTP updates with the same version: exactly one may win.
    const concurrent=await Promise.all([
      managerReq(taskStaff+'/'+madeTask.data.task.id,'PATCH',{status:'done',expectedUpdatedAt:first.data.task.updatedAt}),
      managerReq(taskStaff+'/'+madeTask.data.task.id,'PATCH',{status:'cancelled',expectedUpdatedAt:first.data.task.updatedAt})
    ]);
    check(concurrent.map(r=>r.status).sort().join(',')==='200,409','Compare-and-swap failed to isolate concurrent task updates');checks++;
    requireStatus(await staffReq(visitStaff,'POST',{clientId:existingB}),409,'Staff cannot record other tenant visit');
    const staffVisit=await staffReq(visitStaff,'POST',{clientId:existingA,note:'Synthetic staff visit'});
    requireStatus(staffVisit,201,'Staff records own PG visit');
    check(staffVisit.data.visit.createdBy===staffA,'Staff visit creator wrong');checks++;
    const managerVisit=await managerReq(visitStaff,'POST',{clientId:existingA});
    requireStatus(managerVisit,201,'Manager records visit');
    const staffVisits=await staffReq(visitStaff),ownerVisits=await reqA(visitsA);
    requireStatus(staffVisits,200,'Staff visit feed');
    requireStatus(ownerVisits,200,'Owner visit feed');
    check(staffVisits.data.visits.every(v=>v.createdBy===staffA) && ownerVisits.data.visits.length>staffVisits.data.visits.length,
      'Staff could read other employee visits');checks++;
    const visitCount=ownerVisits.data.visits.length;
    const deniedBatch=await staffReq(visitStaff+'/batch','POST',{items:[{clientId:existingA},{clientId:existingB}]});
    requireStatus(deniedBatch,409,'Atomic visit batch invalid second client');
    const afterBatch=await reqA(visitsA);requireStatus(afterBatch,200,'Visit feed after failed batch');
    check(afterBatch.data.visits.length===visitCount,'First item persisted after failed PostgreSQL batch');checks++;
    const goodBatch=await staffReq(visitStaff+'/batch','POST',{items:[{clientId:existingA},{clientId:existingA}]});
    requireStatus(goodBatch,201,'Successful atomic visit batch');
    check(goodBatch.data.visits.length===2,'Successful batch count mismatch');checks++;
    // Restart the actual HTTP server while keeping PG committed records.
    await stopFactory(server);server=null;
    if(process.env.OX_R46_E2E==='YES')r46NextKeyActive=true;
    const restarted=await launchFactory(dataDir,bundle,keys.publicKey,pgUser,password);
    server=restarted.server;
    const afterRestart=authRequest(restarted.url,sA.token,sA.csrf);
    if(process.env.OX_R46_E2E==='YES'){
      const vault='/api/studio/pg-preview/projects/'+projectA+'/backup-vault';
      const persisted=await afterRestart(vault+'/list');
      requireStatus(persisted,200,'R4.6 encrypted archive survives process restart');
      check(persisted.data.index.activeCount===2,'R4.6 vault not durable after restart');checks++;
      const historical=await afterRestart(vault+'/verify/'+vaultSurvivorId,'POST');
      requireStatus(historical,200,'R4.6 old encryption key restored after restart');
      const rotated=await afterRestart(vault+'/rotate/'+vaultSurvivorId,'POST');
      requireStatus(rotated,200,'R4.6 key rotation creates second encrypted copy');
      check(rotated.data.result.rotationVerified===true&&rotated.data.result.oldArchiveRetained===true&&
        rotated.data.result.archive.keyId==='key_two','R4.6 key rotation verification failed');checks++;
      const newId=rotated.data.result.archive.id;
      const rotatedCheck=await afterRestart(vault+'/verify/'+newId,'POST');
      requireStatus(rotatedCheck,200,'R4.6 restored archive after key rotation');
      check(rotatedCheck.data.result.financialHmac===historical.data.result.financialHmac,
        'R4.6 rotation altered the financial ledger');checks++;
      const retention=await afterRestart(vault+'/prune','POST');
      requireStatus(retention,200,'R4.6 post-rotation retention');
      check(retention.data.result.retained===2,'R4.6 retention failed after rotation');checks++;
    }
    if(process.env.OX_R47_E2E==='YES'){
      const offsite='/api/studio/pg-preview/projects/'+projectA+'/offsite';
      const stale=await afterRestart(offsite+'/status');
      requireStatus(stale,200,'R4.7 detects unsynced rotated archive after restart');
      check(stale.data.remoteHealth.remoteMatchesLocal===false,
        'R4.7 remote freshness checker missed local key rotation');checks++;
      const pushed=await afterRestart(offsite+'/sync','POST');
      requireStatus(pushed,200,'R4.7 recovers remote replication after process restart');
      const restored=await afterRestart(offsite+'/restore-check','POST');
      requireStatus(restored,200,'R4.7 independent restore of rotated encrypted copy');
      check(restored.data.result.restoredIntegrityVerified===true&&
        restored.data.result.financialRecords>=1&&
        restored.data.result.productionCutoverAllowed===false,
        'R4.7 rotated archive could not be restored safely');checks++;
      const monitor=await afterRestart(offsite+'/status');
      requireStatus(monitor,200,'R4.7 healthy remote monitor after resync');
      check(monitor.data.healthy===true,
        'R4.7 backup schedule checkpoint did not survive process restart');checks++;
    }
    if(process.env.OX_R48_E2E==='YES'){
      const route='/api/studio/pg-preview/projects/'+projectA+'/recovery';
      const old=await afterRestart(route+'/status');
      requireStatus(old,200,'R4.8 separate witness reports stale remote after key rotation');
      check(old.data.protection.independentWitnessMatches===false,
        'R4.8 witness incorrectly matched changed remote catalog');checks++;
      const sync=await afterRestart(route+'/sync','POST');
      requireStatus(sync,200,'R4.8 witness reattests rotated remote catalog');
      const proof=await afterRestart(route+'/drill','POST');
      requireStatus(proof,200,'R4.8 verified disaster recovery after restart');
      check(proof.data.result.signedRestoreVerified===true&&
        proof.data.result.financialRecords>=1,'R4.8 financial restore failed after restart');checks++;
    }
    if(process.env.OX_R49_E2E==='YES'){
      const {createR48S3Transport,signR48S3Request}=await import('../src/migration/r48-s3.mjs');
      const {createR48WitnessClient}=await import('../src/migration/r48-witness.mjs');
      const {r47TenantToken}=await import('../src/migration/r47-offsite.mjs');
      const {publishR49IndependentlyLockedBackup,restoreR49Offline}=
        await import('../src/migration/r49-operational-dr.mjs');
      const catalogKey=Buffer.from(r46CatalogKey,'hex');
      const token=r47TenantToken(catalogKey,projectA);
      const verified=(await verifyTrustedMigration(bundle,keys.publicKey));
      const vault={directory:join(dataDir,'.r46-encrypted-vault',projectA),
        projectId:projectA,manifestSha256:verified.manifestSha256,catalogKey,
        keyRing:{activeId:'key_two',
          keys:{key_one:Buffer.from(r46OldKey,'hex'),key_two:Buffer.from(r46NewKey,'hex')}}};
      const cfg={endpoint:process.env.OX_R49_S3_ENDPOINT,
        bucket:process.env.OX_R49_S3_BUCKET,
        region:process.env.OX_R49_S3_REGION||'us-east-1',
        accessKey:process.env.OX_R49_S3_ACCESS_KEY,
        secretKey:process.env.OX_R49_S3_SECRET_KEY,
        projectPrefix:token+'/',allowSyntheticLoopback:true};
      const remote=createR48S3Transport(cfg);
      const witness=createR48WitnessClient({endpoint:r49WitnessEndpoint,
        token:r49WitnessToken,secret:Buffer.from(r49WitnessKey,'hex'),
        tenant:token,allowSyntheticLoopback:true});
      const first=await publishR49IndependentlyLockedBackup({vault,remote,witness});
      check(first.independentWitnessVerified===true&&first.remoteArchives>=2&&
        first.s3ComplianceObjectVersionsVerified===first.remoteArchives+2&&
        first.productionCutoverAllowed===false,
        'R4.9 real MinIO S3 retention and witness gate failed');checks++;
      const newest=(await import('../src/migration/r46-vault.mjs'))
        .listR46Vault(vault);
      const catalog=await newest;
      const id=catalog.archives[0].id;
      const locked=await remote.inspectR49Worm('archives/'+id+'.oxb');
      check(locked.objectLockVerified===true&&locked.versionId,
        'R4.9 S3 object version ID or COMPLIANCE mode missing');checks++;
      // Attempt to delete exactly the signed synthetic version with the
      // test root credentials; COMPLIANCE protection must block deletion.
      const uri=new URL(cfg.endpoint);
      const pathname='/'+cfg.bucket+'/'+token+'/archives/'+id+'.oxb';
      const query='versionId='+encodeURIComponent(locked.versionId);
      const signed=signR48S3Request({method:'DELETE',path:pathname,query,
        body:Buffer.alloc(0),host:uri.host,region:cfg.region,
        accessKey:cfg.accessKey,secretKey:cfg.secretKey});
      const denied=await fetch(uri.origin+pathname+'?'+query,{method:'DELETE',
        headers:signed,signal:AbortSignal.timeout(10000)});
      const deletionBody=await denied.text();
      const s3ErrorCode=(deletionBody.match(/<Code>([A-Za-z0-9_]+)<\/Code>/)||[])[1]||'none';
      const s3ErrorMessage=(deletionBody.match(/<Message>([^<]{0,240})<\/Message>/)||[])[1]||'none';
      const explicitWormDenial=([403,409].includes(denied.status)&&
        /AccessDenied|ObjectLocked|WORM|retention/i.test(deletionBody))||
        (denied.status===400&&s3ErrorCode==='InvalidRequest'&&
          /^Object is WORM protected and cannot be overwritten/.test(s3ErrorMessage));
      check(explicitWormDenial&&
        !/SignatureDoesNotMatch|InvalidAccessKeyId|AuthorizationHeaderMalformed/i.test(deletionBody),
        'R4.9 exact-version delete denied incorrectly (HTTP '+denied.status+
          ', S3 code '+s3ErrorCode+', message '+s3ErrorMessage+')');checks++;
      const stillLocked=await remote.get('archives/'+id+'.oxb');
      check(stillLocked.length>0,'R4.9 protected archive disappeared after denied delete');checks++;
      stillLocked.fill(0);
      const originalHead=await remote.get('head.json');
      const copy=await afterRestart('/api/studio/pg-preview/projects/'+projectA+
        '/backup-vault/create','POST');
      requireStatus(copy,200,'R4.9 adds another signed CRM snapshot');
      const second=await publishR49IndependentlyLockedBackup({vault,remote,witness});
      check(second.independentWitnessVerified===true&&second.remoteArchives>=3,
        'R4.9 witness did not advance after new COMPLIANCE copy');checks++;
      const newestHead=await remote.get('head.json');
      await remote.put('head.json',originalHead); // new current version of an older valid head
      const recoveredDir=join(dir,'r49-disaster-recovery');
      const offlineArgs={vault:{...vault,directory:join(dir,'lost-local-disk')},
        remote,witness,bundleDir:bundle,trustedPublicKey:keys.publicKey,
        recoveryDirectory:recoveredDir};
      let refusedRollback=false;
      try{await restoreR49Offline(offlineArgs);}
      catch(e){refusedRollback=/witness|older|different/.test(e.message);}
      check(refusedRollback,'R4.9 accepted an older valid S3 head after independent witness advanced');checks++;
      await remote.put('head.json',newestHead);
      const recovery=await restoreR49Offline(offlineArgs);
      check(recovery.signedTablesVerified>=1&&recovery.financialRecords>=1&&
        recovery.objectLockVerified===true&&recovery.catalogWitnessVerified===true&&
        Number.isInteger(recovery.measuredRecoveryMs)&&
        recovery.productionCutoverAllowed===false,
        'R4.9 independently restored signed full CRM data incorrectly');checks++;
      const recovered=crmDb(recovery.outputFile);
      try{
        check(recovered.prepare('SELECT amount_minor FROM payments').get().amount_minor===12500&&
          recovered.prepare('SELECT count(*) AS n FROM clients').get().n===1,
          'R4.9 isolated recovery altered or lost signed CRM financial data');checks++;
      }finally{recovered.close();}
    }
    const afterTasks=await afterRestart(tasksA),afterVisits=await afterRestart(visitsA);
    requireStatus(afterTasks,200,'Task persists after server restart');
    requireStatus(afterVisits,200,'Visits persist after server restart');
    check(afterTasks.data.tasks.some(t=>t.id===madeTask.data.task.id) &&
      afterVisits.data.visits.some(v=>v.id===staffVisit.data.visit.id),'PostgreSQL data lost after server restart');checks++;
    const sourceDb=crmDb(join(dataDir,'projects',projectA+'.sqlite'));
    try{
      check(sourceDb.prepare('SELECT count(*) n FROM visits').get().n===0 &&
        sourceDb.prepare('SELECT count(*) n FROM tasks').get().n===1,
        'Read-only SQLite primary source mutated by PostgreSQL preview');
    }finally{sourceDb.close();}checks++;
    const pgVisits=await adminPool.query(`SELECT count(*)::int AS n FROM "ox_p_${projectA.replaceAll('-','')}".visits`);
    check(pgVisits.rows[0].n===4,'PostgreSQL visit commits/rollback count wrong');checks++;
    const drift=await afterRestart(reconcilePath+'/check','POST');
    requireStatus(drift,200,'R4.2 detects PostgreSQL-only changes');
    check(drift.data.report.ok===false&&drift.data.report.totalDifferences>0&&
      drift.data.readiness.productionCutoverAllowed===false,'R4.2 drift gate failed');checks++;
    const history=await afterRestart(reconcilePath+'/history');
    requireStatus(history,200,'R4.2 HMAC journal verified');
    check(history.data.entries===2&&history.data.history[0].ok===true&&history.data.history[1].ok===false,
      'R4.2 journal chain failed');checks++;
    const auditCheck=await adminPool.query('SELECT action,entity FROM "ox_p_'+projectA.replaceAll('-','')+'".audit_log');
    check(auditCheck.rows.length>=10&&auditCheck.rows.every(x=>x.action.startsWith('pg-preview.'))&&
      ['clients','tasks','visits'].every(x=>auditCheck.rows.some(r=>r.entity===x)),
      'R4.2 atomic mutation audit incomplete');checks++;
    if(process.env.OX_R43_E2E==='YES'){
      const shadowPath='/api/studio/pg-preview/projects/'+projectA+'/shadow-replay';
      const first=await afterRestart(shadowPath+'/check','POST');
      requireStatus(first,200,'R4.3 PG-to-ephemeral shadow replay');
      if(process.env.OX_R44_E2E==='YES'){
        check(first.data.receipt.criticalParity?.ok===true&&
          first.data.receipt.criticalParity.financial?.records>=1&&
          first.data.receipt.criticalParity.automations?.rules>=1&&
          first.data.receipt.criticalParity.automations?.runs>=1&&
          first.data.receipt.criticalParity.custom?.entities>=1&&
          first.data.receipt.criticalParity.paymentWritesPermitted===false,
          'R4.4 critical nonempty financial/workflow/custom-entity gate failed');checks++;
      }
      check(first.data.receipt.shadowAligned===true&&first.data.receipt.primarySqliteModified===false
        &&first.data.receipt.firstPass.inserted>0&&first.data.receipt.idempotentRetryVerified===true
        &&first.data.receipt.productionCutoverAllowed===false,'R4.3 signed shadow replay validation failed');checks++;
      const repeated=await afterRestart(shadowPath+'/check','POST');
      requireStatus(repeated,200,'R4.3 same-checkpoint retry');
      check(repeated.data.checkpoint.deduplicated===true&&repeated.data.checkpoint.sequence===1,
        'R4.3 shadow checkpoint duplicate not suppressed');checks++;
      const ownersOther=authRequest(restarted.url,sB.token,sB.csrf);
      requireStatus(await ownersOther(shadowPath+'/check','POST'),404,'R4.3 different owner denied');
      const checkpoints=await afterRestart(shadowPath+'/history');
      requireStatus(checkpoints,200,'R4.3 verifies checkpoint HMAC');
      check(checkpoints.data.entries===1&&checkpoints.data.history[0].idempotentRetryVerified===true,
        'R4.3 checkpoint history incorrect');checks++;
      const unchangedPrimary=crmDb(join(dataDir,'projects',projectA+'.sqlite'));
      try{
        check(unchangedPrimary.prepare('SELECT full_name FROM clients WHERE id=?').get(existingA).full_name==='Original A'
          &&unchangedPrimary.prepare('SELECT count(*) AS n FROM visits').get().n===0,
          'R4.3 wrote to live SQLite source');
      }finally{unchangedPrimary.close();}checks++;
      // Direct PG mutation with no pg-preview audit must fail closed.
      await adminPool.query('UPDATE "ox_p_'+projectA.replaceAll('-','')+
        '".clients SET full_name=$1 WHERE id=$2',['Unlogged tampering of audited client',id]);
      const unlogged=await afterRestart(shadowPath+'/check','POST');
      requireStatus(unlogged,409,'R4.3 unlogged PG write refused');
      const historyAfter=await afterRestart(shadowPath+'/history');
      requireStatus(historyAfter,200,'R4.3 journal unchanged after rejected direct write');
      check(historyAfter.data.entries===1,'R4.3 failure created a misleading checkpoint');checks++;
    }
    const receipt={format:process.env.OX_R43_E2E==='YES'?'osmanx-r43-real-pg-shadow-acceptance':'osmanx-r42-real-pg-crm-reconciliation',success:true,syntheticOnly:true,
      pgVersionNum:version,realPostgres:true,realHttp:true,signedManifestVerified:true,
      tenantSchemas:2,rolesWithLeastPrivilege:true,forbiddenCrossTenantRequests:3,
      csrfDenied:true,transactionRollbackVerified:true,sourceSqliteUnchanged:true,
      checks,crmOperations:['clients','tasks','visits'],employeeSessionsVerified:true,
      optimisticConcurrencyVerified:true,visitBatchRollbackVerified:true,httpRestartPersistenceVerified:true,
      postgresRuntimeEnabled:true,sqlitePrimaryRuntime:true,productionCutoverApproved:false,
      initialDriftZero:true,subsequentDriftDetected:true,ownerReconciliationProtected:true,
      r43ShadowReplayVerified:process.env.OX_R43_E2E==='YES',
      r44CriticalParityVerified:process.env.OX_R44_E2E==='YES',
      r45EncryptedRestoreVerified:process.env.OX_R45_E2E==='YES',
      r46RetainedEncryptedVaultVerified:process.env.OX_R46_E2E==='YES',
      r47OffsiteIndependentRecoveryVerified:process.env.OX_R47_E2E==='YES',
      r48IndependentWitnessAndMeasuredRecoveryVerified:process.env.OX_R48_E2E==='YES',
      r49LiveS3ObjectLockAndOfflineRestoreVerified:process.env.OX_R49_E2E==='YES',
      privateJournalVerified:true,postgresMutationAuditVerified:true,
      publicHttpsVerified:false,customerDataUsed:false};
    console.log(JSON.stringify(receipt,null,2));
  }finally{
    if(server)await stopFactory(server);
    if(offsiteServer)await new Promise(resolve=>offsiteServer.close(resolve));
    if(witnessServer)await new Promise(resolve=>witnessServer.close(resolve));
    if(alertServer)await new Promise(resolve=>alertServer.close(resolve));
    if(witness49Server)await new Promise(resolve=>witness49Server.close(resolve));
    if(adminPool)await adminPool.end();
    await rm(dir,{recursive:true,force:true});
  }
}
try{await main();}catch(e){
  // Never emit PG URLs, SQL dumps, signatures or passwords from a failing test.
  console.error('[R4.1] SYNTHETIC PG CRM WORKFLOW GATE FAILED: '+String(e.message).slice(0,180));
  process.exitCode=1;
}
