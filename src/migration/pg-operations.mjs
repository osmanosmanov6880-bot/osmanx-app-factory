// Guarded PostgreSQL cutover tools. The live OSMANX server remains on SQLite.
// All SQL comes from a checksum-verified migration bundle; no shell evaluation.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { once } from 'node:events';
import { quoteIdent, pgVerificationQueries, verifyMigration } from './pg-kit.mjs';
import { verifyTrustedMigration } from './pg-trust.mjs';

const PREFIX = 'OXV1:';
const DEFAULT_TIMEOUT_MS = 600000;
const LOCK_ID = '842976347122311';
function invariant(ok, msg) { if (!ok) throw new Error(msg); }
function lit(s) { return "'" + s.replaceAll("'", "''") + "'"; }
function targetSchemas(manifest) { return manifest.databases.map(d => d.schema); }
function psqlOptions(psql) {
  invariant(typeof psql === 'string' && psql.length > 0, 'psql executable is required');
  const host=process.env.PGHOST||'';
  const addr=process.env.PGHOSTADDR||'';
  const localHost = !host || host.startsWith('/') || ['localhost','127.0.0.1','::1'].includes(host);
  const remote = (host && !localHost) || (addr && !['127.0.0.1','::1'].includes(addr)) || !!process.env.PGSERVICE;
  // PostgreSQL's default SSL mode 'prefer' does not authenticate the server;
  // a migration export can contain private customer records and password hashes.
  invariant(!remote || process.env.PGSSLMODE==='verify-full',
    'Remote PostgreSQL migration requires PGSSLMODE=verify-full (verified server certificate)');
  return { executable: psql, env: { ...process.env, PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '10',
    PGAPPNAME: process.env.PGAPPNAME || 'osmanx-pg-migration' } };
}
function launch(psql, args, {input=false, timeoutMs=DEFAULT_TIMEOUT_MS}={}) {
  invariant(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 3600000, 'Invalid command timeout');
  const {executable,env} = psqlOptions(psql);
  const child=spawn(executable,['-X','--no-password','--set=ON_ERROR_STOP=1', ...args],{
    stdio:[input?'pipe':'ignore','pipe','pipe'],env,shell:false
  });
  let stderr='';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',data=>{stderr=(stderr+data).slice(-5000);});
  const timer=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);
  const exit=new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signal)=>resolve({code,signal}));
  }).finally(()=>clearTimeout(timer));
  return {child,exit,error:()=>stderr};
}
async function runQuery(psql, sql, timeoutMs) {
  const {child,exit,error}=launch(psql,['--no-align','--tuples-only','--quiet','--command',sql],{timeoutMs});
  let out='';
  try {
    for await(const part of child.stdout) {
      out+=part.toString('utf8');
      invariant(out.length<65536,'Unexpectedly large preflight response');
    }
    const status=await exit;
    invariant(status.code===0,'psql preflight failed: '+error().replace(/password[^\n]*/gi,'password [redacted]'));
    return out.trim();
  } catch(e) { child.kill(); await exit.catch(()=>{}); throw e; }
}
export async function preflightPostgres(directory,{psql='psql',timeoutMs=30000}={}) {
  const m=await verifyMigration(directory);
  const schemaSql=targetSchemas(m).map(lit).join(',');
  const sql=`SELECT json_build_object(
    'version',current_setting('server_version_num')::integer,
    'database',current_database(),
    'canCreate',has_database_privilege(current_user,current_database(),'CREATE'),
    'occupied',COALESCE((SELECT json_agg(nspname ORDER BY nspname) FROM pg_namespace WHERE nspname IN (${schemaSql})),'[]'::json)
  )::text;`;
  let result;
  try {result=JSON.parse(await runQuery(psql,sql,timeoutMs));}
  catch(e) {throw new Error('PostgreSQL preflight could not be completed: '+e.message);}
  invariant(Number.isInteger(result.version) && result.version>=150000,'PostgreSQL 15+ required');
  invariant(result.canCreate===true,'PostgreSQL connection lacks CREATE privilege on target database');
  invariant(Array.isArray(result.occupied),'Invalid PostgreSQL preflight result');
  invariant(result.occupied.length===0,'Target schemas already exist: '+result.occupied.join(', '));
  return {ok:true,serverVersionNum:result.version,database:String(result.database),schemas:targetSchemas(m)};
}

async function writeStream(stream,chunk) {
  if(!stream.write(chunk)) await once(stream,'drain');
}
// Converts a set of transaction-wrapped, previously hashed SQL files into a
// single psql transaction. File chunks are streamed; customer data is not
// duplicated in a temporary combined SQL file.
// Read the exact SQL bytes through one file descriptor and hash them as they are
// sent to psql. The importer NEVER ends stdin (and therefore cannot commit) if
// content is replaced or modified between initial preflight and actual import.
async function streamSignedSql(file,expectedSha256,writable,{name='SQL'}={}) {
  const handle=await open(file,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  const hash=createHash('sha256');
  let begin=0,commit=0;
  let raw;
  try {
    invariant((await handle.stat()).isFile(),'Not a regular SQL file: '+name);
    raw=handle.createReadStream({autoClose:false});
    const checked=raw.pipe(new Transform({transform(chunk,enc,done){hash.update(chunk);done(null,chunk);}}));
    const lines=createInterface({input:checked,crlfDelay:Infinity});
    try {
      for await(const line of lines){
        const trimmed=line.trim();
        if(trimmed==='BEGIN;'){
          invariant(begin===0 && commit===0,'Repeated BEGIN: '+name);begin++;continue;
        }
        if(trimmed==='COMMIT;'){
          invariant(begin===1 && commit===0,'Unexpected COMMIT: '+name);commit++;continue;
        }
        invariant(commit===0,'Unexpected SQL after COMMIT: '+name);
        invariant(!/^\s*\\/.test(line),'psql meta-command forbidden in migration SQL: '+name);
        await writeStream(writable,line+'\n');
      }
    }finally{lines.close();}
    invariant(begin===1 && commit===1,'Missing transaction markers: '+name);
    invariant(hash.digest('hex')===expectedSha256,'SQL changed during import: '+name);
  }finally{raw?.destroy();await handle.close();}
}

export async function feedAtomicSql(input, manifest, writable) {
  const schemas=targetSchemas(manifest).map(lit).join(',');
  await writeStream(writable,`SET LOCAL lock_timeout='15s';\nSET LOCAL statement_timeout='10min';\n`);
  await writeStream(writable,`SELECT pg_advisory_xact_lock(${LOCK_ID});\n`);
  await writeStream(writable,`DO $ox_guard$ BEGIN
    IF current_setting('server_version_num')::integer < 150000 THEN
      RAISE EXCEPTION 'PostgreSQL 15+ required';
    END IF;
    IF NOT has_database_privilege(current_user,current_database(),'CREATE') THEN
      RAISE EXCEPTION 'CREATE permission required';
    END IF;
    IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN (${schemas})) THEN
      RAISE EXCEPTION 'One or more OSMANX schemas already exist';
    END IF;
  END $ox_guard$;\n`);
  for(const db of manifest.databases){
    await streamSignedSql(join(resolve(input),db.sqlFile),db.sqlSha256,writable,{name:db.sqlFile});
  }
}

function cleanSummary(result){return {state:result.state,database:result.database,schemas:result.schemas,tables:result.tables,rows:result.rows};}
// Writes a private operator receipt if requested; never records connection secrets.
async function receipt(path,record){if(path)await writeFile(resolve(path),JSON.stringify(record,null,2)+'\n',{mode:0o600,flag:'wx'});}
async function ensureNewReceipt(path){
  if(!path)return;
  try {await lstat(resolve(path));throw Error('Receipt path already exists: refusing to begin any database mutation');}
  catch(e){if(e.code!=='ENOENT')throw e;}
}
export async function applyPostgres(directory,{psql='psql',confirm=false,verify=true,receiptPath=null,timeoutMs=DEFAULT_TIMEOUT_MS,trustedPublicKey=null}={}) {
  invariant(confirm,'Explicit --confirm-atomic-import required. No target data changed.');
  invariant(trustedPublicKey,'A separately trusted Ed25519 public key is required for PostgreSQL import.');
  await ensureNewReceipt(receiptPath);
  const {manifest:m}=await verifyTrustedMigration(directory,trustedPublicKey);
  const preflight=await preflightPostgres(directory,{psql,timeoutMs:Math.min(timeoutMs,30000)});
  // Trust and checksums are verified again after the remote round-trip.
  await verifyTrustedMigration(directory,trustedPublicKey);
  const schemas=preflight.schemas;
  const state={state:'not-started',database:preflight.database,schemas,
    tables:m.databases.reduce((n,d)=>n+d.tables.length,0),
    rows:m.databases.reduce((n,d)=>n+d.tables.reduce((v,t)=>v+t.rows,0),0)};
  const {child,exit,error}=launch(psql,['--quiet','--single-transaction','--file=-'],{input:true,timeoutMs});
  // Consume stdout concurrently to avoid deadlock if psql prints notices/tags.
  const drain=(async()=>{let len=0;for await(const chunk of child.stdout){len+=chunk.length;invariant(len<1000000,'Excessive psql import output');}})();
  try {
    await feedAtomicSql(directory,m,child.stdin);
    child.stdin.end();
    await drain;
    const code=await exit;
    invariant(code.code===0 && !code.signal,'PostgreSQL import failed (single transaction normally rolls back; confirm target state before retry). SQL details are withheld to protect customer data.');
    state.state='imported-unverified';
  } catch(e) {
    child.kill();child.stdin.destroy();
    await Promise.allSettled([exit,drain]);
    state.state='failed-or-uncertain';
    await receipt(receiptPath,{...cleanSummary(state),error:e.message,action:'Do not switch application; check target schemas and server logs.'});
    throw e;
  }
  if(verify){
    try {
      const checked=await verifyPostgresSnapshot(directory,{psql,timeoutMs});
      state.state='imported-verified';state.tables=checked.tables;
    }catch(e){
      // Import was COMMITTED; verification cannot automatically undo it.
      await receipt(receiptPath,{...cleanSummary(state),error:e.message,action:'Import committed; verify target manually. DO NOT switch application.'});
      throw new Error('Import committed but target verification failed: '+e.message);
    }
  }
  const result=cleanSummary(state);
  await receipt(receiptPath,result);
  return {ok:true,...result};
}

// Entire target is verified from one REPEATABLE READ snapshot rather than
// 20+ independent connections that could observe different data versions.
export async function verifyPostgresSnapshot(directory,{psql='psql',timeoutMs=DEFAULT_TIMEOUT_MS}={}) {
  const m=await verifyMigration(directory);
  const queries=pgVerificationQueries(m);
  const {child,exit,error}=launch(psql,['--quiet','--no-align','--tuples-only','--file=-'],{input:true,timeoutMs});
  const hashes=queries.map(()=>createHash('sha256'));
  const counts=queries.map(()=>0);
  let index=0;
  const read=(async()=>{
    for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})){
      if(!line.trim())continue;
      invariant(line.startsWith(PREFIX),'Unexpected psql output in snapshot verification');
      const obj=JSON.parse(line.slice(PREFIX.length));
      if(Object.hasOwn(obj,'end')){
        invariant(obj.end===index,'Target table marker missing or out of order');
        index++;
        continue;
      }
      invariant(index<queries.length && obj.i===index && Array.isArray(obj.v),'Unexpected target row');
      const q=queries[index];
      invariant(obj.v.length===q.columns.length,'Invalid target row width');
      const normalized=obj.v.map((v,j)=>v===null?null:q.columns[j].type==='DOUBLE PRECISION'?String(Number(v)):String(v));
      hashes[index].update(JSON.stringify(normalized)+'\n');
      counts[index]++;
      invariant(counts[index]<=q.expectedRows,'Target has extra rows: '+q.schema+'.'+q.table);
    }
  })();
  const write=(async()=>{
    await writeStream(child.stdin,"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL statement_timeout='10min';\n");
    for(let i=0;i<queries.length;i++){
      const query=queries[i];
      const from=query.sql.indexOf(' FROM ');
      invariant(from>=0,'Invalid target query');
      const rowExpr=query.sql.slice('SELECT '.length,from).replace(/::text$/, '');
      await writeStream(child.stdin,`SELECT '${PREFIX}' || json_build_object('i',${i},'v',${rowExpr})::text${query.sql.slice(from)};\n`);
      await writeStream(child.stdin,`SELECT '${PREFIX}' || json_build_object('end',${i})::text;\n`);
    }
    await writeStream(child.stdin,'COMMIT;\n');child.stdin.end();
  })();
  try{
    await Promise.all([write,read]);
    const status=await exit;
    invariant(status.code===0 && !status.signal,'psql snapshot verification failed: '+error());
    invariant(index===queries.length,'Target verification finished before all table markers');
    for(let i=0;i<queries.length;i++){
      invariant(counts[i]===queries[i].expectedRows && hashes[i].digest('hex')===queries[i].expectedSha256,
        'Target data mismatch: '+queries[i].schema+'.'+queries[i].table);
    }
  } catch(e){child.kill();child.stdin.destroy();await Promise.allSettled([exit,write,read]);throw e;}
  return {ok:true,tables:queries.length,rows:counts.reduce((a,b)=>a+b,0),consistentSnapshot:true};
}

// Read-only ACL proof for every NOLOGIN role: role attributes, own schema,
// permitted DML and absence of inherited permissions on other tenant schemas.
// Requires a privileged auditor connection after *manual* application of access.sql.
export async function verifyTenantAcl(directory,{psql='psql',timeoutMs=30000}={}) {
  const m=await verifyMigration(directory);
  const plans=m.access.roles;
  invariant(Array.isArray(plans) && plans.length===m.databases.length,'Invalid tenant role map');
  let commands=[];
  const expected=[];
  const schemas=targetSchemas(m);
  for(const p of plans){
    invariant(schemas.includes(p.schema),'Unknown tenant schema in access roles');
    for(const [role,kind] of [[p.reader,'reader'],[p.writer,'writer']]){
      quoteIdent(role);
      const r=lit(role),s=lit(p.schema);
      const rows=`FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${s} AND c.relkind IN ('r','p')`;
      const allOwn=priv=>`COALESCE((SELECT bool_and(has_table_privilege(${r},format('%I.%I',n.nspname,c.relname),${lit(priv)})) ${rows}),false)`;
      const otherSchemas=schemas.filter(x=>x!==p.schema);
      const other=otherSchemas.length?otherSchemas.map(x=>`has_schema_privilege(${r},${lit(x)},'USAGE')`).join(' OR '):'false';
      const crossRead=otherSchemas.length?`EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname IN (${otherSchemas.map(lit).join(',')}) AND c.relkind IN ('r','p')
        AND has_table_privilege(${r},format('%I.%I',n.nspname,c.relname),'SELECT'))`:'false';
      const memberOid=name=>`COALESCE((SELECT oid FROM pg_roles WHERE rolname=${lit(name)}),0)`;
      const publicSchema=`EXISTS(SELECT 1 FROM pg_namespace n,
        LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
        WHERE n.nspname=${s} AND a.grantee=0 AND a.privilege_type IN ('USAGE','CREATE'))`;
      const publicTable=`EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
        LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
        WHERE n.nspname=${s} AND c.relkind IN ('r','p')
          AND a.grantee=0 AND a.privilege_type IN ('SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'))`;
      const extraSchema=`EXISTS(SELECT 1 FROM pg_namespace n,
        LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
        WHERE n.nspname=${s} AND a.grantee NOT IN (0,n.nspowner,${memberOid(p.reader)},${memberOid(p.writer)}))`;
      const extraTable=`EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
        LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
        WHERE n.nspname=${s} AND c.relkind IN ('r','p')
          AND a.grantee NOT IN (0,c.relowner,${memberOid(p.reader)},${memberOid(p.writer)}))`;
      const roleInfo=`(SELECT json_build_object('login',rolcanlogin,'super',rolsuper,'createRole',rolcreaterole,'createDb',rolcreatedb,'replication',rolreplication,'bypassRls',rolbypassrls)
        FROM pg_roles WHERE rolname=${r})`;
      commands.push(`SELECT json_build_object('role',${r},'kind',${lit(kind)},'attrs',${roleInfo},
        'ownUsage',has_schema_privilege(${r},${s},'USAGE'),
        'ownCreate',has_schema_privilege(${r},${s},'CREATE'),
        'read',${allOwn('SELECT')},'insert',${allOwn('INSERT')},'update',${allOwn('UPDATE')},'delete',${allOwn('DELETE')},
        'crossUsage',(${other}),'crossRead',${crossRead},
        'publicExposure',(${publicSchema} OR ${publicTable}),
        'unexpectedGrantee',(${extraSchema} OR ${extraTable}),
        'isMember',EXISTS(SELECT 1 FROM pg_auth_members a JOIN pg_roles v ON a.member=v.oid WHERE v.rolname=${r})
      )::text;`);
      expected.push({role,kind});
    }
  }
  // Bounded CLI command length: handle many companies without a single enormous SQL argument.
  const batches=[];let current='';
  for(const command of commands){
    invariant(command.length<100000,'Tenant ACL query too large; split the project set');
    if(current.length+command.length+1>100000){batches.push(current);current='';}
    current+=command+'\n';
  }
  if(current)batches.push(current);
  const lines=[];
  for(const batch of batches){
    const output=await runQuery(psql,batch,timeoutMs);
    lines.push(...output.split(/\r?\n/).filter(Boolean));
  }
  invariant(lines.length===expected.length,'Incomplete PostgreSQL ACL audit result');
  const checks=[];
  for(let i=0;i<expected.length;i++){
    const found=JSON.parse(lines[i]),want=expected[i];
    invariant(found.role===want.role && found.kind===want.kind,'Role audit output mismatch');
    const attrs=found.attrs;
    invariant(attrs && attrs.login===false && attrs.super===false && attrs.createRole===false && attrs.createDb===false && attrs.replication===false && attrs.bypassRls===false,'Tenant role has privileged attributes');
    invariant(found.ownUsage===true && found.ownCreate===false && found.read===true
      && found.crossUsage===false && found.crossRead===false && found.isMember===false
      && found.publicExposure===false && found.unexpectedGrantee===false,
      'Tenant role fails separation audit: '+want.role);
    const writable=found.insert===true && found.update===true && found.delete===true;
    invariant(want.kind==='writer'?writable:!found.insert&&!found.update&&!found.delete,'Incorrect tenant write grants: '+want.role);
    checks.push({role:want.role,kind:want.kind,verified:true});
  }
  return {ok:true,roles:checks.length,crossTenantAccess:false};
}

// Operator-controlled ACL activation, deliberately separate from data import.
// Signed access.sql is streamed into one transaction. Schema/role collisions abort.
export async function applyTenantAcl(directory,{psql='psql',confirm=false,trustedPublicKey=null,
  receiptPath=null,timeoutMs=DEFAULT_TIMEOUT_MS}={}){
  invariant(confirm,'Explicit --confirm-tenant-acl required. Roles were not modified.');
  invariant(trustedPublicKey,'A separately trusted Ed25519 public key is required for ACL activation.');
  await ensureNewReceipt(receiptPath);
  const {manifest:m}=await verifyTrustedMigration(directory,trustedPublicKey);
  const schemas=targetSchemas(m);
  const roles=m.access.roles.flatMap(r=>[r.reader,r.writer]);
  const sql=`SELECT json_build_object('version',current_setting('server_version_num')::integer,
    'database',current_database(),
    'occupied',COALESCE((SELECT json_agg(nspname ORDER BY nspname) FROM pg_namespace WHERE nspname IN (${schemas.map(lit).join(',')})),'[]'::json),
    'existingRoles',COALESCE((SELECT json_agg(rolname ORDER BY rolname) FROM pg_roles WHERE rolname IN (${roles.map(lit).join(',')})),'[]'::json))::text;`;
  const state=JSON.parse(await runQuery(psql,sql,Math.min(timeoutMs,30000)));
  invariant(state.version>=150000,'PostgreSQL 15+ required');
  invariant(Array.isArray(state.occupied) && state.occupied.length===schemas.length
    && schemas.every(s=>state.occupied.includes(s)),'Target migration schemas incomplete; ACL activation stopped');
  invariant(Array.isArray(state.existingRoles) && state.existingRoles.length===0,'Tenant role names already exist; refusing repeated ACL activation');
  if(process.env.PGDATABASE)invariant(state.database===process.env.PGDATABASE,'PostgreSQL target database mismatch');
  await verifyTrustedMigration(directory,trustedPublicKey);
  const {child,exit}=launch(psql,['--quiet','--single-transaction','--file=-'],{input:true,timeoutMs});
  const drain=(async()=>{for await(const _ of child.stdout){ /* no application data should appear */ }})();
  try{
    await streamSignedSql(join(resolve(directory),m.access.file),m.access.sha256,child.stdin,{name:'access.sql'});
    child.stdin.end();
    await drain;
    const result=await exit;
    invariant(result.code===0 && !result.signal,'Tenant ACL transaction failed. Inspect target before retry.');
  }catch(e){
    child.kill();child.stdin.destroy();await Promise.allSettled([exit,drain]);
    await receipt(receiptPath,{state:'failed-or-uncertain',database:state.database,
      note:'Do not enable PostgreSQL runtime; inspect tenant roles manually.'});
    throw e;
  }
  try{
    const audit=await verifyTenantAcl(directory,{psql,timeoutMs:Math.min(timeoutMs,30000)});
    const result={ok:true,state:'roles-verified',database:state.database,roles:audit.roles,tenantIsolationVerified:true};
    await receipt(receiptPath,result);
    return result;
  }catch(e){
    await receipt(receiptPath,{state:'roles-unverified',database:state.database,
      note:'Roles may have been committed; do not enable PostgreSQL runtime.'});
    throw new Error('ACL committed but security audit failed: '+e.message);
  }
}

// A read-only acceptance gate for data + schema ACLs, NOT proof that the
// existing synchronous SQLite server is ready to run on PostgreSQL.
export async function assessPostgresTarget(directory,{psql='psql',trustedPublicKey=null,
  timeoutMs=DEFAULT_TIMEOUT_MS,receiptPath=null}={}){
  await ensureNewReceipt(receiptPath);
  const signed=await verifyTrustedMigration(directory,trustedPublicKey);
  const snapshot=await verifyPostgresSnapshot(directory,{psql,timeoutMs});
  const acl=await verifyTenantAcl(directory,{psql,timeoutMs:Math.min(timeoutMs,60000)});
  const database=await runQuery(psql,'SELECT current_database();',Math.min(timeoutMs,30000));
  if(process.env.PGDATABASE)invariant(database===process.env.PGDATABASE,'PostgreSQL target database mismatch');
  const report={status:'data-and-acl-verified',postgresqlDataReady:true,
    sqliteRuntimeUnchanged:true,postgresqlRuntimeReady:false,productionCutoverApproved:false,
    database,manifestSha256:signed.manifestSha256,keyFingerprint:signed.keyFingerprint,
    schemas:signed.manifest.databases.length,tables:snapshot.tables,rows:snapshot.rows,
    roles:acl.roles,consistentSnapshot:true,crossTenantAccess:false};
  await receipt(receiptPath,report);
  return report;
}
