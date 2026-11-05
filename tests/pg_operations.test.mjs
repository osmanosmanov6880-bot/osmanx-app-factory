import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightPostgres, applyPostgres, applyTenantAcl, assessPostgresTarget, verifyPostgresSnapshot, verifyTenantAcl, feedAtomicSql } from '../src/migration/pg-operations.mjs';
import { createSigningIdentity, signMigration, verifyTrustedMigration } from '../src/migration/pg-trust.mjs';
import { PassThrough } from 'node:stream';
import { tenantAccessPlan } from '../src/migration/pg-kit.mjs';

const digest=s=>createHash('sha256').update(s).digest('hex');
const s1='ox_studio',s2='ox_p_22222222222242228222222222222222',s3='ox_p_33333333333343338333333333333333';
const schemaIds=[s1,s2,s3];
const rows={
 [s1+'.entries']:[['owner-1'],['owner-2']],
 [s2+'.entries']:[['crm-1']],
 [s3+'.entries']:[['site-1']]
};
async function fixture(){
 const base=await mkdtemp(join(tmpdir(),'ox-pgops-'));
 const dir=join(base,'migration');await mkdir(dir);

 const databases=[];
 for(let i=0;i<schemaIds.length;i++){
  const schema=schemaIds[i];
  const role=i===0?'studio':i===1?'crm':'site';
  const projectId=i===0?null:i===1?'22222222-2222-4222-8222-222222222222':'33333333-3333-4333-8333-333333333333';
  const file=i===0?'studio.sql':'project-'+projectId.replaceAll('-','')+'.sql';
  const data=rows[schema+'.entries'];
  const sql=`-- migration test\nBEGIN;\nCREATE SCHEMA "${schema}";\nCREATE TABLE "${schema}"."entries" ("id" TEXT PRIMARY KEY);\n${data.map(row=>`INSERT INTO "${schema}"."entries" VALUES ('${row[0]}');`).join('\n')}\nCOMMIT;\n`;
  await writeFile(join(dir,file),sql);
  const sha=digest(data.map(row=>JSON.stringify(row)+'\n').join(''));
  databases.push({role,projectId,sqlFile:file,sqlSha256:digest(sql),schema,
   tables:[{name:'entries',rows:data.length,sha256:sha,columns:[{name:'id',type:'TEXT'}],primary:['id']}]
  });
 }
 const accessRoles=databases.map((d,i)=>({schema:d.schema,
  reader:'ox_ro_'+(i===0?'studio':d.projectId.replaceAll('-','')),
  writer:'ox_rw_'+(i===0?'studio':d.projectId.replaceAll('-',''))}));
 const access=tenantAccessPlan(databases);
 await writeFile(join(dir,'access.sql'),access.sql);
 const manifest={format:'osmanx-pg-offline-v1',version:1,databases,
  access:{file:'access.sql',sha256:digest(access.sql),roles:accessRoles}};
 await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
 const keys=await createSigningIdentity(join(base,'signing'));
 await signMigration(dir,keys.privateKey);
 const mock=join(base,'mock-psql');
 const mockCode=`#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
if(args.includes('--command')){
 const sql=args[args.indexOf('--command')+1];
 if(sql.includes("'existingRoles'")){
  console.log(JSON.stringify({version:170000,database:'safe_test_db',occupied:${JSON.stringify(schemaIds)},existingRoles:process.env.OX_MOCK_EXISTING_ROLE==='1'?['ox_ro_studio']:[]}));process.exit(0);
 }
 if(sql.includes('SELECT current_database()')){console.log('safe_test_db');process.exit(0);}
 if(sql.includes("'version',current_setting")){
  const r={version:Number(process.env.OX_MOCK_VERSION||170000),database:'safe_test_db',canCreate:process.env.OX_MOCK_NOCREATE!=='1',occupied:process.env.OX_MOCK_OCCUPIED==='1'?['ox_studio']:[]};
  console.log(JSON.stringify(r)); process.exit(0);
 }
 if(sql.includes("'attrs',")){
  const matches=[...sql.matchAll(/'role','([^']+)','kind','(reader|writer)'/g)];
  for(const m of matches){console.log(JSON.stringify({role:m[1],kind:m[2],attrs:{login:false,super:false,createRole:false,createDb:false,replication:false,bypassRls:false},ownUsage:true,read:true,
   insert:m[2]==='writer',update:m[2]==='writer',delete:m[2]==='writer',
   crossUsage:process.env.OX_MOCK_ACL_LEAK==='1',crossRead:process.env.OX_MOCK_ACL_CROSSREAD==='1',
   ownCreate:false,publicExposure:process.env.OX_MOCK_ACL_PUBLIC==='1',
   unexpectedGrantee:process.env.OX_MOCK_ACL_EXTRA==='1',isMember:false}));}
  process.exit(0);
 }
 console.error('unexpected query');process.exit(4);
}
let input='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
 if(args.includes('--single-transaction')){
  fs.writeFileSync(process.env.OX_MOCK_LOG,JSON.stringify({args,input}));
  if(process.env.OX_MOCK_FAIL==='1'){console.error('mock server rejected import');process.exit(3);}
  if(input.includes('\\nBEGIN;')||input.includes('\\nCOMMIT;')){console.error('nested transaction');process.exit(2);}
  if(!input.includes('ox_studio'))process.exit(2);
  if(!input.includes('CREATE ROLE')&&!input.includes('pg_advisory_xact_lock'))process.exit(2);
  process.exit(0);
 }
 if(input.includes('REPEATABLE READ READ ONLY')){
  const data=JSON.parse(process.env.OX_MOCK_ROWS);
  const matches=[...input.matchAll(/SELECT 'OXV1:' \\|\\| json_build_object\\('i',(\\d+),'v',[^;]+ FROM "([^"]+)"\\."([^"]+)" ORDER BY[^;]+;/g)];
  if(matches.length!==3){console.error('missing queries: '+matches.length);process.exit(2);}
  for(const m of matches){
   const i=Number(m[1]);const key=m[2]+'.'+m[3];
   for(const row of data[key]){
    const values=(process.env.OX_MOCK_CORRUPT==='1'&&i===1)?['CORRUPTED']:row;
    console.log('OXV1:'+JSON.stringify({i,v:values}));
   }
   console.log('OXV1:'+JSON.stringify({end:i}));
  }
  process.exit(0);
 }
 console.error('unexpected mode');process.exit(5);
});
`;
 await writeFile(mock,mockCode);await chmod(mock,0o700);
 return {base,dir,mock,manifest,keys,log:join(base,'psql-log.json')};
}
async function run(fn){const f=await fixture();const before={...process.env};
 process.env.OX_MOCK_ROWS=JSON.stringify(rows);process.env.OX_MOCK_LOG=f.log;
 try{await fn(f);}finally{
  for(const key of ['OX_MOCK_ROWS','OX_MOCK_LOG','OX_MOCK_FAIL','OX_MOCK_VERSION','OX_MOCK_NOCREATE','OX_MOCK_OCCUPIED','OX_MOCK_ACL_LEAK','OX_MOCK_CORRUPT','OX_MOCK_ACL_CROSSREAD','OX_MOCK_ACL_PUBLIC','OX_MOCK_ACL_EXTRA','OX_MOCK_EXISTING_ROLE']){
   if(Object.hasOwn(before,key))process.env[key]=before[key];else delete process.env[key];
  }
  await rm(f.base,{recursive:true,force:true});
 }
}

test('PG preflight requires Postgres 15+, schema absence, CREATE privilege and valid checksums',async()=>run(async({dir,mock})=>{
 const result=await preflightPostgres(dir,{psql:mock});
 assert.equal(result.schemas.length,3);assert.equal(result.database,'safe_test_db');
 process.env.OX_MOCK_VERSION='140000';await assert.rejects(preflightPostgres(dir,{psql:mock}),/15\+/);
 delete process.env.OX_MOCK_VERSION;
 process.env.OX_MOCK_NOCREATE='1';await assert.rejects(preflightPostgres(dir,{psql:mock}),/CREATE privilege/);
 delete process.env.OX_MOCK_NOCREATE;
 process.env.OX_MOCK_OCCUPIED='1';await assert.rejects(preflightPostgres(dir,{psql:mock}),/already exist/);
}),{timeout:30000});

test('Atomic PG importer explicitly gated, streams 3 schemas in 1 transaction and audits after commit',async()=>run(async({dir,mock,log,keys})=>{
 await assert.rejects(applyPostgres(dir,{psql:mock}),/confirm-atomic-import/);
 const result=await applyPostgres(dir,{psql:mock,confirm:true,trustedPublicKey:keys.publicKey});
 assert.equal(result.state,'imported-verified');assert.equal(result.tables,3);assert.equal(result.rows,4);
 const script=JSON.parse(await readFile(log,'utf8'));
 assert.ok(script.args.includes('--single-transaction'));
 assert.ok(script.input.includes('DO $ox_guard$'));
 assert.ok(script.input.includes('CREATE SCHEMA "ox_studio"'));
 assert.ok(script.input.includes('CREATE SCHEMA "'+s2+'"'));
 assert.ok(script.input.includes('CREATE SCHEMA "'+s3+'"'));
 assert.ok(!script.input.includes('\nCOMMIT;'));
}),{timeout:30000});

test('Importer fails closed on SQL error without claiming target verified',async()=>run(async({dir,mock,base,keys})=>{
 process.env.OX_MOCK_FAIL='1';
 const report=join(base,'failure.json');
 await assert.rejects(applyPostgres(dir,{psql:mock,confirm:true,receiptPath:report,trustedPublicKey:keys.publicKey}),/transaction normally rolls back/);
 const receipt=JSON.parse(await readFile(report,'utf8'));
 assert.equal(receipt.state,'failed-or-uncertain');assert.match(receipt.action,/Do not switch/);
}),{timeout:30000});

test('Read-only PG snapshot verification detects corrupted target and incomplete table result',async()=>run(async({dir,mock})=>{
 const status=await verifyPostgresSnapshot(dir,{psql:mock});
 assert.equal(status.tables,3);assert.equal(status.consistentSnapshot,true);
 process.env.OX_MOCK_CORRUPT='1';await assert.rejects(verifyPostgresSnapshot(dir,{psql:mock}),/Target data mismatch/);
}),{timeout:30000});

test('Post-commit mismatch produces unverified receipt and prohibits claimed rollback',async()=>run(async({dir,mock,base,keys})=>{
 process.env.OX_MOCK_CORRUPT='1';const report=join(base,'unverified.json');
 await assert.rejects(applyPostgres(dir,{psql:mock,confirm:true,receiptPath:report,trustedPublicKey:keys.publicKey}),/Import committed but target verification failed/);
 const receipt=JSON.parse(await readFile(report,'utf8'));
 assert.equal(receipt.state,'imported-unverified');
 assert.match(receipt.action,/DO NOT switch/);
}),{timeout:30000});

test('Postgres ACL read-only audit proves role separation and rejects cross-tenant grants',async()=>run(async({dir,mock})=>{
 const r=await verifyTenantAcl(dir,{psql:mock});assert.equal(r.roles,6);assert.equal(r.crossTenantAccess,false);
 process.env.OX_MOCK_ACL_LEAK='1';
 await assert.rejects(verifyTenantAcl(dir,{psql:mock}),/separation audit/);
}),{timeout:30000});

test('Manifest corruption rejects import before any attempt to connect',async()=>run(async({dir,mock,manifest,keys})=>{
 const path=join(dir,manifest.databases[0].sqlFile);
 await writeFile(path,'BEGIN;\nDROP SCHEMA public CASCADE;\nCOMMIT;\n');
 await assert.rejects(applyPostgres(dir,{psql:mock,confirm:true,trustedPublicKey:keys.publicKey}),/checksum mismatch/);
}),{timeout:30000});

test('Live PostgreSQL smoke script refuses to operate on production-shaped database names',async()=>{
 const {spawnSync}=await import('node:child_process');
 const command=join(process.cwd(),'scripts','pg_live_e2e.mjs');
 for(const name of ['prod','osmanx_factory','postgres','ox_test_bad-name']){
  const result=spawnSync(process.execPath,[command,'--confirm-test-database'],{
   env:{...process.env,PGDATABASE:name},encoding:'utf8'});
  assert.equal(result.status,2,`Must refuse ${name}`);
  assert.match(result.stderr,/REFUSED/);
 }
 const absent=spawnSync(process.execPath,[command],{
  env:{...process.env,PGDATABASE:'ox_test_factory123'},encoding:'utf8'});
 assert.equal(absent.status,2);
});

test('Remote database transport requires certificate-verified TLS',async()=>run(async({dir,mock})=>{
 const oldHost=process.env.PGHOST,oldMode=process.env.PGSSLMODE;
 try {
  process.env.PGHOST='db.example.test';
  delete process.env.PGSSLMODE;
  await assert.rejects(preflightPostgres(dir,{psql:mock}),/verify-full/);
  process.env.PGSSLMODE='verify-full';
  assert.equal((await preflightPostgres(dir,{psql:mock})).ok,true);
 }finally{
  if(oldHost===undefined)delete process.env.PGHOST;else process.env.PGHOST=oldHost;
  if(oldMode===undefined)delete process.env.PGSSLMODE;else process.env.PGSSLMODE=oldMode;
 }
}),{timeout:30000});


test('Ed25519 trust anchor rejects wrong keys, tampered manifests and missing signatures',async()=>run(async({dir,keys,base,mock})=>{
  const good=await verifyTrustedMigration(dir,keys.publicKey);
  assert.equal(good.manifest.databases.length,3);
  const other=await createSigningIdentity(join(base,'other-keys'));
  await assert.rejects(verifyTrustedMigration(dir,other.publicKey),/untrusted key/);
  await assert.rejects(applyPostgres(dir,{psql:mock,confirm:true}),/trusted Ed25519/);
  const manifestPath=join(dir,'manifest.json');
  await writeFile(manifestPath,(await readFile(manifestPath,'utf8'))+'\n');
  await assert.rejects(verifyTrustedMigration(dir,keys.publicKey),/manifest has changed/);
  await assert.rejects(applyPostgres(dir,{psql:mock,confirm:true,trustedPublicKey:keys.publicKey}),/manifest has changed/);
}),{timeout:30000});

test('Ed25519 signer refuses an overly permissive private key',async()=>run(async({dir,keys,base})=>{
  const privateCopy=join(base,'unsafe-key.pem');
  await writeFile(privateCopy,await readFile(keys.privateKey));
  await chmod(privateCopy,0o644);
  const other=join(base,'other-bundle');await mkdir(other);
  for(const name of ['manifest.json','studio.sql','access.sql',...schemaIds.slice(1).map((_,i)=>'project-'+(['22222222222242228222222222222222','33333333333343338333333333333333'][i])+'.sql')]){
    await writeFile(join(other,name),await readFile(join(dir,name)));
  }
  await assert.rejects(signMigration(other,privateCopy),/0600 permissions/);
}),{timeout:30000});

test('Atomic importer catches SQL changed after manifest verification but before stream commit',async()=>run(async({dir,manifest})=>{
  const path=join(dir,'studio.sql');
  const s=await readFile(path,'utf8');
  await writeFile(path,s.replace('CREATE SCHEMA "ox_studio"','CREATE SCHEMA "ox_swapped"'));
  const sink=new PassThrough();sink.resume();
  await assert.rejects(feedAtomicSql(dir,manifest,sink),/SQL changed during import/);
}),{timeout:30000});

test('Tenant ACL audit catches PUBLIC exposure, unexpected grantees and direct cross-schema table grants',async()=>run(async({dir,mock})=>{
  for(const key of ['OX_MOCK_ACL_PUBLIC','OX_MOCK_ACL_EXTRA','OX_MOCK_ACL_CROSSREAD']){
    process.env[key]='1';
    await assert.rejects(verifyTenantAcl(dir,{psql:mock}),/separation audit/);
    delete process.env[key];
  }
}),{timeout:30000});

test('Signed ACL activation is separate, requires explicit confirmation, and verifies roles',async()=>run(async({dir,mock,keys})=>{
  await assert.rejects(applyTenantAcl(dir,{psql:mock,trustedPublicKey:keys.publicKey}),/confirm-tenant-acl/);
  await assert.rejects(applyTenantAcl(dir,{psql:mock,confirm:true}),/trusted Ed25519/);
  const applied=await applyTenantAcl(dir,{psql:mock,confirm:true,trustedPublicKey:keys.publicKey});
  assert.equal(applied.roles,6);
  assert.equal(applied.state,'roles-verified');
  process.env.OX_MOCK_EXISTING_ROLE='1';
  await assert.rejects(applyTenantAcl(dir,{psql:mock,confirm:true,trustedPublicKey:keys.publicKey}),/already exist/);
}),{timeout:30000});

test('Read-only PG acceptance assesses signed data and ACL; never approves runtime cutover',async()=>run(async({dir,mock,keys})=>{
  const report=await assessPostgresTarget(dir,{psql:mock,trustedPublicKey:keys.publicKey});
  assert.equal(report.postgresqlDataReady,true);
  assert.equal(report.schemas,3);
  assert.equal(report.tables,3);
  assert.equal(report.roles,6);
  assert.equal(report.productionCutoverApproved,false);
  assert.equal(report.postgresqlRuntimeReady,false);
}),{timeout:30000});


test('SQL stream denies psql backslash meta-commands even for previously hashed input',async()=>run(async({dir,manifest})=>{
 const sql=join(dir,'studio.sql');
 await writeFile(sql,(await readFile(sql,'utf8')).replace('CREATE SCHEMA', '\\! echo unsafe\nCREATE SCHEMA'));
 const sink=new PassThrough();sink.resume();
 await assert.rejects(feedAtomicSql(dir,manifest,sink),/psql meta-command forbidden/);
}),{timeout:30000});

test('Existing receipt file prevents mutations before contacting PostgreSQL',async()=>run(async({dir,mock,keys,base})=>{
 const receiptPath=join(base,'receipt.json');
 await writeFile(receiptPath,'keep intact');
 await assert.rejects(applyPostgres(dir,{psql:mock,confirm:true,trustedPublicKey:keys.publicKey,receiptPath}),/Receipt path already exists/);
 await assert.rejects(applyTenantAcl(dir,{psql:mock,confirm:true,trustedPublicKey:keys.publicKey,receiptPath}),/Receipt path already exists/);
 assert.equal(await readFile(receiptPath,'utf8'),'keep intact');
}),{timeout:30000});
