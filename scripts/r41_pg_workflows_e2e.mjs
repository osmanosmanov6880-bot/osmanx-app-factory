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
const staffA='88888888-8888-4888-8888-888888888888';
const managerA='99999999-9999-4999-8999-999999999999';
const taskInitial='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const now='2026-11-06T00:00:00.000Z';
const testName='ox_test_factory_r40';
const r42Secret=randomBytes(32).toString('hex');
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
    ...(process.env.OX_R43_E2E==='YES'?{OX_R43_SHADOW_REPLAY:'YES',OX_R43_CONFIRM_SYNTHETIC:'YES'}:{})};
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
  const db=crmDb(path);
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
    return {staff:issueSession(db,staffA),manager:issueSession(db,managerA)};
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
    let checks=0;const requireStatus=(r,expected,label)=>{check(r.status===expected,`${label}: HTTP ${r.status}`);checks++;};
    requireStatus(await reqA('/api/studio/pg-preview/status'),200,'Preview status');
    const reconcilePath='/api/studio/pg-preview/projects/'+projectA+'/reconcile';
    const pristine=await reqA(reconcilePath+'/check','POST');
    requireStatus(pristine,200,'R4.2 pristine signed import');
    check(pristine.data.report.ok===true&&pristine.data.report.totalDifferences===0&&
      pristine.data.readiness.productionCutoverAllowed===false,'Initial signed reconciliation mismatch');checks++;
    requireStatus(await reqB(reconcilePath+'/check','POST'),404,'R4.2 foreign owner denied');
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
    const restarted=await launchFactory(dataDir,bundle,keys.publicKey,pgUser,password);
    server=restarted.server;
    const afterRestart=authRequest(restarted.url,sA.token,sA.csrf);
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
      privateJournalVerified:true,postgresMutationAuditVerified:true,
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
  console.error('[R4.1] SYNTHETIC PG CRM WORKFLOW GATE FAILED: '+String(e.message).slice(0,180));
  process.exitCode=1;
}
