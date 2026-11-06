#!/usr/bin/env node
// R4.0 true HTTP + PostgreSQL integration. Synthetic local database ONLY.
// Creates private temporary Studio + two CRM SQLite fixtures, signs their
// migration, imports into real PostgreSQL, and tests a limited LOGIN role.
// NEVER operates on a production database or changes the primary runtime.
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer as createTcpListener } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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
const now='2026-11-06T00:00:00.000Z';
const testName='ox_test_factory_r40';
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
    OX_R40_PG_BUNDLE:bundle,OX_R40_PG_TRUST_KEY:keyPath,OX_R40_EPHEMERAL:'YES'};
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
function authRequest(base,token,csrf){
  return async (path,method='GET',body,overrideCsrf)=>{
    const headers={cookie:`ox_studio=${token}`, 'cache-control':'no-store'};
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
      .run(project,owner,name,'crm','restaurant',JSON.stringify(['auth','clients']),JSON.stringify({accent:'#234567'}),now,now);
  }
  return [issueSession(studio,ownerA),issueSession(studio,ownerB)];
}
function seedCrm(path,clientId,person){
  const db=crmDb(path);
  try{db.prepare('INSERT INTO clients(id,full_name,phone,email,source,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(clientId,person,'','','walkin','',now,now);
  }finally{db.close();}
}
async function main(){
  const version=guard();
  // The driver is loaded only in explicitly enabled test/runtime contexts.
  const {Pool}=await import('pg');
  const dir=await mkdtemp(join(tmpdir(),'ox-r40-http-'));
  let server,adminPool;
  try{
    const dataDir=join(dir,'data');const bundle=join(dir,'signed-export');
    await mkdir(join(dataDir,'projects'),{recursive:true,mode:0o700});
    const studio=studioDb(join(dataDir,'studio.sqlite'));
    let sA,sB;
    try{[sA,sB]=insertStudioFixtures(studio);}finally{studio.close();}
    seedCrm(join(dataDir,'projects',projectA+'.sqlite'),existingA,'Original A');
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
    let checks=0;const requireStatus=(r,expected,label)=>{check(r.status===expected,`${label}: HTTP ${r.status}`);checks++;};
    requireStatus(await reqA('/api/studio/pg-preview/status'),200,'Preview status');
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
    const receipt={format:'osmanx-r40-real-pg-http-acceptance',success:true,syntheticOnly:true,
      pgVersionNum:version,realPostgres:true,realHttp:true,signedManifestVerified:true,
      tenantSchemas:2,rolesWithLeastPrivilege:true,forbiddenCrossTenantRequests:3,
      csrfDenied:true,transactionRollbackVerified:true,sourceSqliteUnchanged:true,
      checks,postgresRuntimeEnabled:true,sqlitePrimaryRuntime:true,productionCutoverApproved:false,
      publicHttpsVerified:false,customerDataUsed:false};
    console.log(JSON.stringify(receipt,null,2));
  }finally{
    if(server)await stopFactory(server);
    if(adminPool)await adminPool.end();
    await rm(dir,{recursive:true,force:true});
  }
}
try{await main();}catch(e){
  // Never emit PG URLs, SQL dumps, signatures or passwords from a failing test.
  console.error('[R4.0] SYNTHETIC PG HTTP GATE FAILED: '+String(e.message).slice(0,180));
  process.exitCode=1;
}
