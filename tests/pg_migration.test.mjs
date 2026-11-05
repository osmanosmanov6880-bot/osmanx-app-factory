import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { studioDb } from '../src/studio/db.mjs';
import { crmDb } from '../src/crm/db.mjs';
import { siteDb } from '../src/site/db.mjs';
import { acquireLock } from '../src/common/maintenance.mjs';
import { planMigration, exportMigration, verifyMigration, verifyPostgres, pgVerificationQueries, quoteIdent } from '../src/migration/pg-kit.mjs';

const OWNER='11111111-1111-4111-8111-111111111111';
const CRM='22222222-2222-4222-8222-222222222222';
const SITE='33333333-3333-4333-8333-333333333333';
const STAMP='2026-11-05T00:00:00.000Z';
const id=n=>String(n).padStart(8,'0')+'-0000-4000-8000-000000000000';
async function fixture(withSite=true){
 const root=await mkdtemp(join(tmpdir(),'ox-pg-test-')),data=join(root,'data');
 await mkdir(join(data,'projects'),{recursive:true});
 const studio=studioDb(join(data,'studio.sqlite'));
 studio.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
  .run(OWNER,'owner@example.test','Admin','scrypt:PLACEHOLDER_SECRET_HASH','owner',STAMP);
 for (const [id,type] of [[CRM,'crm'],...(withSite?[[SITE,'site']]:[])]) {
   studio.prepare('INSERT INTO projects(id,owner_id,name,type,industry,modules_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
   .run(id,OWNER,type==='crm'?'Кафе «Тест»':'Магазин',type,'restaurant','["auth","clients"]','{}',STAMP,STAMP);
 }
 studio.close();
 const db=crmDb(join(data,'projects',CRM+'.sqlite'));
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
   .run(OWNER,'admin@crm.test','Владелец','hashed-password','admin',STAMP);
 db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
   .run('secret-session-token',OWNER,'secret-csrf',STAMP,STAMP);
 db.prepare('INSERT INTO clients(id,full_name,phone,email,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
   .run(id(4),"О'Коннор\\\n\\t; DROP TABLE clients; --",'+70000000000','a@b.test','multi\nline\\backslash',STAMP,STAMP);
 db.prepare('INSERT INTO tasks(id,title,created_at,updated_at) VALUES(?,?,?,?)').run(id(5),'Позвонить',STAMP,STAMP);
 db.prepare('INSERT INTO visits(id,client_id,occurred_at,created_at) VALUES(?,?,?,?)').run(id(6),id(4),STAMP,STAMP);
 db.close();
 if(withSite){const s=siteDb(join(data,'projects',SITE+'.sqlite'),{name:'Магазин',modules:['auth','cms','leads'],settings:{},pages:[]});s.close();}
 return {root,data};
}
async function withFixture(fn,withSite=true){const f=await fixture(withSite);try{await fn(f);}finally{await rm(f.root,{recursive:true,force:true});}}

test('migration cold plan + three independent schemas + R13 data parity and session revocation',async()=>withFixture(async({root,data})=>{
 const plan=await planMigration(data);
 assert.equal(plan.length,3);
 assert.equal(new Set(plan.map(x=>x.schema)).size,3);
 const out=join(root,'migration');
 await assert.rejects(exportMigration(data,out),/allow-sensitive/);
 const result=await exportMigration(data,out,{allowSensitive:true});
 assert.equal(result.databases,3);
 const manifest=await verifyMigration(out);
 assert.equal(manifest.databases.length,3);
 assert.equal(manifest.sessionPolicy,'rows-omitted; users must log in again');
 const project=manifest.databases.find(x=>x.projectId===CRM);
 const crmSql=await readFile(join(out,project.sqlFile),'utf8');
 assert.match(crmSql,/CREATE SCHEMA "ox_p_22222222222242228222222222222222"/);
 assert.match(crmSql,/CREATE TABLE "clients"/);
 assert.match(crmSql,/FOREIGN KEY \("client_id"\) REFERENCES "clients"/);
 assert.match(crmSql,/CHECK \(status IN \('todo','doing','done','cancelled'\)\)/);
 assert.match(crmSql,/CHECK \(amount_minor>0 AND amount_minor<=999999999999\)/);
 assert.match(crmSql,/О''Коннор/);
 assert.ok(!crmSql.includes('secret-session-token'));
 assert.ok(!crmSql.includes('secret-csrf'));
 assert.ok(crmSql.includes('hashed-password'));
 assert.equal(project.tables.find(t=>t.name==='sessions').rows,0);
 assert.equal(project.tables.find(t=>t.name==='clients').rows,1);
 const fmode=(await stat(join(out,project.sqlFile))).mode & 0o777;
 assert.equal(fmode & 0o077,0);
 assert.ok((await readFile(join(out,'studio.sql'),'utf8')).includes('"role" TEXT NOT NULL'));
 await assert.rejects(exportMigration(data,out,{allowSensitive:true}),/already exists/);
}),{timeout:20000});

test('tampered SQL fails checksum and path traversal manifest fails closed',async()=>withFixture(async({root,data})=>{
 const out=join(root,'migration');await exportMigration(data,out,{allowSensitive:true});
 const man=await verifyMigration(out);const file=join(out,man.databases[0].sqlFile);
 await writeFile(file,await readFile(file,'utf8')+'\n-- changed');
 await assert.rejects(verifyMigration(out),/checksum mismatch/);
 man.databases[0].sqlFile='../evil.sql';
 await writeFile(join(out,'manifest.json'),JSON.stringify(man));
 await assert.rejects(verifyMigration(out),/Unsafe SQL filename/);
}),{timeout:20000});

test('refuses stale schema: orphan project SQLite + missing referenced project SQLite',async()=>withFixture(async({data})=>{
 const db=crmDb(join(data,'projects',id(7)+'.sqlite'));db.close();
 await assert.rejects(planMigration(data),/Orphan project/);
 await rm(join(data,'projects',id(7)+'.sqlite'));
 await rm(join(data,'projects',CRM+'.sqlite'));
 await assert.rejects(planMigration(data),/Uninitialized project/);
}),{timeout:20000});

test('refuses untrusted linked SQLite files and unsupported SQLite triggers',async()=>withFixture(async({root,data})=>{
 const db=new DatabaseSync(join(data,'projects',CRM+'.sqlite'));
 db.exec('CREATE TRIGGER injection_trigger AFTER INSERT ON clients BEGIN SELECT 1; END;');db.close();
 await assert.rejects(planMigration(data),/Views and triggers/);
 await rm(join(data,'projects',CRM+'.sqlite'));
 await symlink(join(root,'missing'),join(data,'projects',CRM+'.sqlite'));
 await assert.rejects(planMigration(data),/regular file/);
}),{timeout:20000});

test('exclusive lock gate: export refuses live server and leaves no output',async()=>withFixture(async({root,data})=>{
 const unlock=acquireLock(data,'server');
 try{await assert.rejects(exportMigration(data,join(root,'blocked'),{allowSensitive:true}),/Application is active/);}
 finally{unlock();}
 await assert.rejects(stat(join(root,'blocked')),/ENOENT/);
}),{timeout:20000});

test('integrity gate catches FK corruption even if SQLite foreign keys were manually disabled',async()=>withFixture(async({data})=>{
 const db=new DatabaseSync(join(data,'projects',CRM+'.sqlite'));
 db.exec('PRAGMA foreign_keys=OFF;');
 db.prepare('INSERT INTO visits(id,client_id,occurred_at,created_at) VALUES(?,?,?,?)').run(id(8),id(9999),STAMP,STAMP);
 db.close();
 await assert.rejects(planMigration(data),/foreign_key_check failure/);
}),{timeout:20000});

test('PostgreSQL verification streams hash parity and fails on altered target',async()=>withFixture(async({root,data})=>{
 const out=join(root,'migration');await exportMigration(data,out,{allowSensitive:true});
 const manifest=await verifyMigration(out);
 const queries=pgVerificationQueries(manifest);
 assert.ok(queries.some(q=>q.sql.includes('json_build_array')&&q.sql.includes('ORDER BY')));
 const fixtures={};
 for(const entry of manifest.databases){
   const src=entry.role==='studio'?join(data,'studio.sqlite'):join(data,'projects',entry.projectId+'.sqlite');
   const db=new DatabaseSync(src,{readOnly:true});
   try {for(const t of entry.tables){
     const key=entry.schema+'.'+t.name;
     const quote=name=>'"'+name+'"';
     const rows=t.name==='sessions'?[]:db.prepare('SELECT * FROM '+quote(t.name)+' ORDER BY '+t.primary.map(quote).join(', ')).all();
     fixtures[key]=rows.map(row=>t.columns.map(c=>{
       const v=row[c.name];if(v===null)return null;
       if(c.type==='BYTEA')return Buffer.from(v).toString('hex');
       return String(v);
     }));
   }}finally{db.close();}
 }
 const fixturePath=join(root,'pg-fixtures.json');await writeFile(fixturePath,JSON.stringify(fixtures));
 const mock=join(root,'mock-psql');
 await writeFile(mock,`#!/usr/bin/env node\nconst fs=require('node:fs');\nconst sql=process.argv[process.argv.length-1];\nconst match=sql.match(/FROM "([^"]+)"\."([^"]+)"/);\nif(!match)process.exit(2);\nconst rows=JSON.parse(fs.readFileSync(process.env.OX_PG_FIXTURE,'utf8'))[match[1]+'.'+match[2]];\nif(!rows)process.exit(3);\nfor(const row of rows)console.log(JSON.stringify(row));\nif(process.env.OX_PG_CORRUPT==='1' && match[2]==='clients')console.log(JSON.stringify(['hijacked']));\n`);
 await chmod(mock,0o700);
 process.env.OX_PG_FIXTURE=fixturePath;
 try{
   const done=await verifyPostgres(out,{psql:mock});
   assert.equal(done.tables,queries.length);
   process.env.OX_PG_CORRUPT='1';
   await assert.rejects(verifyPostgres(out,{psql:mock}),/PostgreSQL data mismatch|Invalid PostgreSQL verification row/);
 }finally{delete process.env.OX_PG_FIXTURE;delete process.env.OX_PG_CORRUPT;}
}),{timeout:30000});

test('identifier validator blocks injection into SQL object names',()=>{
 assert.equal(quoteIdent('my_table'), '"my_table"');
 for(const x of ['x;DROP SCHEMA public','a-b','a"b','', 'x'.repeat(64)]) assert.throws(()=>quoteIdent(x));
});

test('tenant ACL uses separate NOLOGIN roles without cross-tenant grants',async()=>withFixture(async({root,data})=>{
 const out=join(root,'migration');await exportMigration(data,out,{allowSensitive:true});
 const m=await verifyMigration(out);
 assert.equal(m.access.roles.length,3);
 const acl=await readFile(join(out,'access.sql'),'utf8');
 assert.ok(!acl.includes('SUPERUSER'));
 for(const role of m.access.roles){
   assert.match(acl,new RegExp('CREATE ROLE "'+role.reader+'" NOLOGIN;'));
   assert.match(acl,new RegExp('CREATE ROLE "'+role.writer+'" NOLOGIN;'));
   const grants=acl.split('\n').filter(line=>line.startsWith('GRANT ') && (line.includes('"'+role.reader+'"') || line.includes('"'+role.writer+'"')));
   assert.ok(grants.length>=3);
   assert.ok(grants.every(line=>line.includes('"'+role.schema+'"')));
 }
 await writeFile(join(out,'access.sql'),acl+'-- unauthorized change');
 await assert.rejects(verifyMigration(out),/access SQL checksum mismatch/);
}),{timeout:20000});

test('binary payload roundtrip is lossless and unsupported collation aborts',async()=>withFixture(async({root,data})=>{
 const src=join(data,'projects',CRM+'.sqlite');
 const db=new DatabaseSync(src);
 db.exec('CREATE TABLE binary_records(id TEXT PRIMARY KEY,payload BLOB NOT NULL)');
 db.prepare('INSERT INTO binary_records(id,payload) VALUES(?,?)').run(id(777),Buffer.from([0,255,92,10]));db.close();
 const out=join(root,'migration');await exportMigration(data,out,{allowSensitive:true});
 const m=await verifyMigration(out);const entry=m.databases.find(x=>x.projectId===CRM);
 const text=await readFile(join(out,entry.sqlFile),'utf8');
 assert.ok(text.includes("decode('00ff5c0a','hex')"));
 const binary=entry.tables.find(t=>t.name==='binary_records');
 assert.equal(binary.rows,1);
 const reopened=new DatabaseSync(src);
 reopened.exec('CREATE TABLE collation_bad(id TEXT PRIMARY KEY,value TEXT COLLATE NOCASE)');reopened.close();
 await assert.rejects(planMigration(data),/collation/);
}),{timeout:20000});

test('CLI synthetic demo does not need live data, and produces a verifiable bundle',async()=>{
 const {spawnSync}=await import('node:child_process');
 const root=await mkdtemp(join(tmpdir(),'ox-pg-cli-'));
 try{
  const out=join(root,'migration');
  const p=spawnSync(process.execPath,['scripts/pg_demo.mjs','--out',out],{cwd:resolve('.')});
  assert.equal(p.status,0,p.stderr.toString());
  const demo=JSON.parse(p.stdout.toString());
  assert.equal(demo.demo,true);
  assert.equal(demo.databases,3);
  const m=await verifyMigration(out);
  assert.equal(m.databases.length,3);
 }finally{await rm(root,{recursive:true,force:true});}
},{timeout:30000});
