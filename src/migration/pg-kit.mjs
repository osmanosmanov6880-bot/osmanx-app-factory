import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, lstat, readdir, readFile, writeFile, rename, rm, chmod, open } from 'node:fs/promises';
import { existsSync, constants } from 'node:fs';
import { join, resolve, dirname, basename, relative, isAbsolute, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { acquireLock } from '../common/maintenance.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const MAX_TABLES = 160;
const MAX_COLUMNS = 120;
const SHA = /^[a-f0-9]{64}$/;
const sha = value => createHash('sha256').update(value).digest('hex');
function assert(condition, message) { if (!condition) throw Error(message); }
export function quoteIdent(value) {
  assert(typeof value === 'string' && IDENT.test(value), 'Unsafe SQL identifier: ' + String(value));
  return '"' + value + '"';
}
function q(name) { return quoteIdent(name); }
function checkFileName(path) { assert(typeof path === 'string' && /^[a-z0-9_-]+\.sql$/.test(path), 'Unsafe SQL filename'); return path; }

async function regularFile(path) {
  const s = await lstat(path);
  assert(s.isFile() && !s.isSymbolicLink(), 'Database must be a regular file: ' + path);
}
// Bounded-memory checksum: a user may migrate a database far larger than process RAM.
// O_NOFOLLOW and fd.stat() reduce pathname-swap attacks during verification.
export async function sha256RegularFile(path) {
  await regularFile(path);
  const fd=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat=await fd.stat();
    assert(stat.isFile(),'Not a regular SQL file: '+path);
    const hash=createHash('sha256');
    for await(const chunk of fd.createReadStream({autoClose:false}))hash.update(chunk);
    return hash.digest('hex');
  }finally{await fd.close();}
}
function pragma(db, expr) { return db.prepare(expr).all(); }
function pgType(sqliteType) {
  const normalized = sqliteType.toUpperCase().trim();
  if (normalized === 'TEXT' || normalized === 'VARCHAR' || normalized.startsWith('VARCHAR(')) return 'TEXT';
  if (normalized === 'INTEGER' || normalized === 'INT' || normalized === 'BIGINT') return 'BIGINT';
  if (normalized === 'REAL' || normalized === 'FLOAT' || normalized === 'DOUBLE') return 'DOUBLE PRECISION';
  if (normalized === 'BLOB') return 'BYTEA';
  throw Error('Unsupported SQLite column type: ' + sqliteType);
}
function defaultExpression(value) {
  if (value === null || value === undefined) return '';
  const v = String(value);
  if (/^-?\d+(?:\.\d+)?$/.test(v) || /^'(?:[^']|'')*'$/.test(v) || /^NULL$/i.test(v)) return ' DEFAULT ' + v;
  throw Error('Unsupported SQLite DEFAULT: ' + v);
}
function extractChecks(ddl, columns) {
  const found = [];
  // SQL is generated from SQLite metadata; only the narrowly supported CHECK grammar is emitted.
  for (const m of ddl.matchAll(/\bCHECK\s*\(/gi)) {
    const start = m.index + m[0].length;
    let depth = 1, inString = false, end = start;
    for (; end < ddl.length && depth > 0; end++) {
      const c = ddl[end];
      if (c === "'" && inString && ddl[end + 1] === "'") { end++; continue; }
      if (c === "'") { inString = !inString; continue; }
      if (!inString && c === '(') depth++;
      if (!inString && c === ')') depth--;
    }
    assert(depth === 0 && !inString, 'Unbalanced CHECK constraint');
    const expression = ddl.slice(start, end - 1).trim();
    const id = expression.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
    assert(id && columns.some(c => c.name === id[1]), 'Unsupported CHECK column');
    const scalar = /[a-zA-Z_][a-zA-Z0-9_]*\s*(?:>=|<=|!=|<>|>|<|=)\s*-?\d+/g;
    const inStrings = /^([a-zA-Z_][a-zA-Z0-9_]*)\s+IN\s*\(\s*'(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*\s*\)$/i;
    const inNums = /^([a-zA-Z_][a-zA-Z0-9_]*)\s+IN\s*\(\s*-?\d+(?:\s*,\s*-?\d+)*\s*\)$/i;
    const clauses = expression.split(/\s+AND\s+/i);
    const numeric = clauses.length <= 4 && clauses.every(c => new RegExp('^' + scalar.source + '$', 'i').test(c));
    assert(inStrings.test(expression) || inNums.test(expression) || numeric, 'Unsupported CHECK expression: ' + expression);
    // Reject references to any other table column in the restricted numeric grammar.
    if (numeric) for (const clause of clauses) assert(clause.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/)[1] === id[1], 'Ambiguous CHECK expression');
    found.push(expression);
  }
  return found;
}
function describeTable(db, name, allNames) {
  const meta = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
  assert(meta?.sql && /^\s*CREATE\s+TABLE\b/i.test(meta.sql), 'Unsupported table DDL: ' + name);
  assert(!/\bCOLLATE\s+(?!BINARY\b)/i.test(meta.sql), 'Non-BINARY SQLite collation requires manual migration: ' + name);
  assert(!/\bDEFERRABLE\b/i.test(meta.sql), 'Deferrable SQLite constraints require manual migration: ' + name);
  const rawCols = pragma(db, 'PRAGMA table_xinfo(' + q(name) + ')');
  assert(rawCols.length > 0 && rawCols.length <= MAX_COLUMNS, 'Invalid column count: ' + name);
  const columns = rawCols.map(c => {
    assert(c.hidden === 0, 'Generated or hidden columns are unsupported: ' + name);
    q(c.name);
    return { name:c.name, type:pgType(c.type), notnull:!!c.notnull, primary:c.pk, default:defaultExpression(c.dflt_value) };
  });
  const primary = columns.filter(c=>c.primary > 0).sort((a,b)=>a.primary-b.primary).map(c=>c.name);
  assert(primary.length > 0, 'Primary key required for deterministic verification: ' + name);
  const indexes = [];
  const uniques = [];
  for (const idx of pragma(db, 'PRAGMA index_list(' + q(name) + ')')) {
    assert(!idx.partial, 'Partial indexes require manual migration: ' + name);
    const cols=pragma(db, 'PRAGMA index_xinfo(' + q(idx.name) + ')').filter(c=>c.key === 1);
    assert(cols.length > 0 && cols.every(c=>c.cid >= 0 && columns.some(x=>x.name===c.name)), 'Expression index requires manual migration: ' + name);
    assert(cols.every(c=>!c.coll || c.coll==='BINARY'), 'Unsupported SQLite index collation: ' + name);
    const names = cols.map(c=>({name:c.name,desc:!!c.desc}));
    if (idx.origin === 'pk') continue;
    if (idx.origin === 'u') { uniques.push(names.map(c=>c.name)); continue; }
    assert(idx.origin === 'c', 'Unsupported index origin');
    q(idx.name); indexes.push({name:idx.name,unique:!!idx.unique,columns:names});
  }
  const fks = new Map();
  for (const f of pragma(db, 'PRAGMA foreign_key_list(' + q(name) + ')')) {
    assert(allNames.includes(f.table), 'Missing foreign key target: ' + name + '.' + f.table);
    if (!fks.has(f.id)) fks.set(f.id, {target:f.table,from:[],to:[],onDelete:f.on_delete,onUpdate:f.on_update});
    const fk=fks.get(f.id); q(f.from); q(f.to); fk.from.push(f.from); fk.to.push(f.to);
  }
  return {name,columns,primary,uniques,indexes,fks:[...fks.values()],checks:extractChecks(meta.sql,columns)};
}
function describe(db) {
  const unsupported = db.prepare("SELECT type,name FROM sqlite_master WHERE type IN ('view','trigger') AND name NOT LIKE 'sqlite_%'").all();
  assert(unsupported.length === 0, 'Views and triggers require manual migration');
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name);
  assert(tables.length > 0 && tables.length <= MAX_TABLES, 'Unexpected table count');
  tables.forEach(q);
  assert(!tables.includes('_ox_migration_control'), 'Reserved migration table collision');
  return tables.map(name=>describeTable(db,name,tables));
}
function verifySqlite(db, name) {
  assert(db.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok', 'SQLite integrity_check failure: '+name);
  assert(pragma(db,'PRAGMA foreign_key_check').length === 0, 'SQLite foreign_key_check failure: '+name);
}
function sqlLiteral(value, type) {
  if (value === null) return 'NULL';
  if (type === 'BYTEA') {
    assert(value instanceof Uint8Array, 'Expected BLOB');
    return `decode('${Buffer.from(value).toString('hex')}','hex')`;
  }
  if (type === 'TEXT') {
    assert(typeof value === 'string' && !value.includes('\0'), 'Unsupported NUL in PostgreSQL text');
    const escaped = value.replaceAll('\\','\\\\').replaceAll("'", "''")
      .replace(/[\x01-\x1f]/g,c=>'\\x'+c.charCodeAt(0).toString(16).padStart(2,'0'))
      .replace(/\x7f/g,'\\x7f');
    return "E'" + escaped + "'";
  }
  assert(typeof value === 'number' && Number.isFinite(value), 'Invalid numeric value');
  if (type === 'BIGINT') assert(Number.isSafeInteger(value), 'Unsafe integer: use a lossless importer');
  return String(value);
}
function normalizedCell(value, type) {
  if (value === null) return null;
  if (type === 'BYTEA') return Buffer.from(value).toString('hex');
  if (type === 'DOUBLE PRECISION') return String(Number(value));
  return String(value);
}
function ddlFor(table) {
  const cols=table.columns.map(c=>
    '  '+q(c.name)+' '+c.type+(c.notnull?' NOT NULL':'')+c.default);
  cols.push('  PRIMARY KEY ('+table.primary.map(q).join(', ')+')');
  for(const unique of table.uniques)cols.push('  UNIQUE ('+unique.map(q).join(', ')+')');
  for(const check of table.checks)cols.push('  CHECK ('+check+')');
  return `CREATE TABLE ${q(table.name)} (\n${cols.join(',\n')}\n);\n`;
}
function fkAndIndexSQL(table) {
  const lines=[];
  table.fks.forEach((f,i)=>{
    const behavior = v => {
      const allowed=['NO ACTION','RESTRICT','CASCADE','SET NULL','SET DEFAULT'];
      assert(allowed.includes(v), 'Unsupported foreign-key action: '+v);
      return v;
    };
    const name=`ox_fk_${sha(table.name+'_'+i).slice(0,16)}`;
    lines.push(`ALTER TABLE ${q(table.name)} ADD CONSTRAINT ${q(name)} FOREIGN KEY (${f.from.map(q).join(', ')}) REFERENCES ${q(f.target)} (${f.to.map(q).join(', ')}) ON DELETE ${behavior(f.onDelete)} ON UPDATE ${behavior(f.onUpdate)};`);
  });
  for(const idx of table.indexes) lines.push(`CREATE ${idx.unique?'UNIQUE ':''}INDEX ${q(idx.name)} ON ${q(table.name)} (${idx.columns.map(c=>q(c.name)+(c.desc?' DESC':'')).join(', ')});`);
  return lines.join('\n');
}
function readRows(db, table) {
  return db.prepare('SELECT * FROM '+q(table.name)+' ORDER BY '+table.primary.map(q).join(', ')).iterate();
}
async function copyTable(db, table, omitRows, write) {
  const hasher=createHash('sha256');
  let rows=0;
  const cols=table.columns.map(c=>c.name);
  if (!omitRows) {
    let batch=[];
    const flush=async()=>{
      if(batch.length){
        await write(`INSERT INTO ${q(table.name)} (${cols.map(q).join(', ')}) VALUES\n${batch.join(',\n')};\n`);
        batch=[];
      }
    };
    for (const row of readRows(db,table)) {
      const values=table.columns.map(c=>row[c.name]);
      const normalized=values.map((v,i)=>normalizedCell(v,table.columns[i].type));
      hasher.update(JSON.stringify(normalized)+'\n');
      batch.push('('+values.map((v,i)=>sqlLiteral(v,table.columns[i].type)).join(', ')+')');
      rows++;
      if (batch.length===50) await flush();
    }
    await flush();
  }
  return {rows, sha256:hasher.digest('hex')};
}
function pgSchema(role, id) {return role==='studio'?'ox_studio':'ox_p_'+id.replaceAll('-','');}
function pgRoleSuffix(item) {return item.projectId===null?'studio':item.projectId.replaceAll('-','');}
export function tenantAccessPlan(databases) {
  const lines=[
    '-- OPTIONAL: apply only after successful PostgreSQL data migration and verification.',
    '-- Requires CREATE ROLE privileges. Roles have NOLOGIN; grant membership deliberately.',
    'BEGIN;'
  ];
  const roleMap=[];
  for(const db of databases){
    const schema=q(db.schema), suffix=pgRoleSuffix(db);
    const reader='ox_ro_'+suffix,writer='ox_rw_'+suffix;
    roleMap.push({schema:db.schema,reader,writer});
    lines.push(`CREATE ROLE ${q(reader)} NOLOGIN;`);
    lines.push(`CREATE ROLE ${q(writer)} NOLOGIN;`);
    lines.push(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;`);
    lines.push(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC;`);
    lines.push(`GRANT USAGE ON SCHEMA ${schema} TO ${q(reader)}, ${q(writer)};`);
    lines.push(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${q(reader)};`);
    lines.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${q(writer)};`);
  }
  lines.push('COMMIT;');
  return {sql:lines.join('\n')+'\n',roles:roleMap};
}
async function renderDatabaseToFile(db, role, id, file) {
  verifySqlite(db,role+':'+(id||'studio'));
  const tables=describe(db);
  const schema=pgSchema(role,id);
  const sqlHash=createHash('sha256');
  const handle=await open(file,'wx',0o600);
  const write=async chunk=>{
    const bytes=Buffer.from(chunk,'utf8');
    sqlHash.update(bytes);
    await handle.writeFile(bytes);
  };
  const report=[];
  try {
    await write(`-- OSMANX PostgreSQL cold migration; private data; schema ${schema}\n`);
    await write("BEGIN;\nSET LOCAL lock_timeout = '10s';\nSET LOCAL statement_timeout = '10min';\n");
    await write(`CREATE SCHEMA ${q(schema)};\nREVOKE ALL ON SCHEMA ${q(schema)} FROM PUBLIC;\nSET LOCAL search_path = ${q(schema)}, pg_catalog;\n`);
    for(const table of tables)await write('\n'+ddlFor(table));
    for(const table of tables){
      await write('\n');
      const copied=await copyTable(db,table,table.name==='sessions',write);
      report.push({name:table.name,rows:copied.rows,sha256:copied.sha256,columns:table.columns.map(c=>({name:c.name,type:c.type})),primary:table.primary,sessionRowsExcluded:table.name==='sessions'});
    }
    for(const table of tables)await write('\n'+fkAndIndexSQL(table)+'\n');
    // Actual target hashes are recomputed by pg:verify-target, not trusted from metadata.
    await write('\nCREATE TABLE "_ox_migration_control" ("table_name" TEXT PRIMARY KEY, "rows_expected" BIGINT NOT NULL, "sha256_expected" TEXT NOT NULL);\n');
    for(const t of report)await write(`INSERT INTO "_ox_migration_control" VALUES (E'${t.name}', ${t.rows}, E'${t.sha256}');\n`);
    await write('COMMIT;\n');
    await handle.sync();
  }finally{await handle.close();}
  return {schema,sqlSha256:sqlHash.digest('hex'),tables:report};
}
async function assertSourceLayout(dataDir) {
  const studio=join(dataDir,'studio.sqlite');
  await regularFile(studio);
  const db=new DatabaseSync(studio,{readOnly:true});
  let projects;
  try {
    verifySqlite(db,'studio');
    projects=db.prepare('SELECT id,type FROM projects ORDER BY id').all();
  } finally {db.close();}
  const expected=new Set(projects.map(p=>{
    assert(UUID.test(p.id) && ['crm','site'].includes(p.type), 'Unsupported project identity');
    return p.id+'.sqlite';
  }));
  const projectDir=join(dataDir,'projects');
  const existing=existsSync(projectDir) ? await readdir(projectDir) : [];
  for(const name of existing){
    if (!name.endsWith('.sqlite')) continue;
    assert(expected.has(name), 'Orphan project database: '+name);
    await regularFile(join(projectDir,name));
  }
  for(const name of expected)assert(existing.includes(name),'Uninitialized project database: '+name+' (open the project once before migration)');
  return [{role:'studio',id:null,source:studio}, ...projects.map(p=>({role:p.type,id:p.id,source:join(projectDir,p.id+'.sqlite')}))];
}
export async function planMigration(dataDir) {
  const sources=await assertSourceLayout(resolve(dataDir));
  const summary=[];
  for(const item of sources){
    const db=new DatabaseSync(item.source,{readOnly:true});
    try{verifySqlite(db,item.role); const tables=describe(db);
      summary.push({role:item.role,id:item.id,schema:pgSchema(item.role,item.id),tables:tables.length,
        rows:tables.reduce((n,t)=>n+db.prepare('SELECT COUNT(*) n FROM '+q(t.name)).get().n,0)});
    }finally{db.close();}
  }
  return summary;
}
export async function exportMigration(dataDir, dest, {allowSensitive=false}={}) {
  assert(allowSensitive, 'Sensitive records require explicit --allow-sensitive acknowledgment');
  const data=resolve(dataDir), out=resolve(dest);
  const rel=relative(data,out);
  assert(rel.startsWith('..'+sep) || rel==='..' || isAbsolute(rel), 'Migration destination must be outside the live data directory');
  assert(!existsSync(out), 'Destination already exists: refusing overwrite');
  const unlock=acquireLock(data,'maintenance');
  let tempRoot,stage;
  try{
    const sources=await assertSourceLayout(data);
    tempRoot=await mkdtemp(join(dirname(out),'.ox-pg-snap-'));
    stage=join(dirname(out),'.'+basename(out)+'.staging-'+randomUUID());
    await mkdir(stage,{recursive:false,mode:0o700});
    const report=[];
    for(const item of sources){
      const snapshot=join(tempRoot,randomUUID()+'.sqlite');
      const sourceDb=new DatabaseSync(item.source,{readOnly:true});
      try{await backup(sourceDb,snapshot);}finally{sourceDb.close();}
      await chmod(snapshot,0o600);
      const db=new DatabaseSync(snapshot,{readOnly:true});
      const name=checkFileName(item.role==='studio'?'studio.sql':'project-'+item.id.replaceAll('-','')+'.sql');
      let rendered;
      try{rendered=await renderDatabaseToFile(db,item.role,item.id,join(stage,name));}finally{db.close();}
      report.push({role:item.role,projectId:item.id,sqlFile:name,sqlSha256:rendered.sqlSha256,schema:rendered.schema,tables:rendered.tables});
    }
    const acl=tenantAccessPlan(report);
    await writeFile(join(stage,'access.sql'),acl.sql,{mode:0o600,flag:'wx'});
    const manifest={format:'osmanx-pg-offline-v1',version:1,createdAt:new Date().toISOString(),
      source:'OSMANX APP FACTORY R13-accessible-source',target:'PostgreSQL 15+',
      sensitive:true,sessionPolicy:'rows-omitted; users must log in again',targetVerified:false,
      access:{file:'access.sql',sha256:sha(acl.sql),applied:false,roles:acl.roles},databases:report};
    await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
    await verifyMigration(stage);
    await rename(stage,out);stage=null;
    return {path:out,databases:report.length,tables:report.reduce((n,d)=>n+d.tables.length,0)};
  }finally{
    if(stage)await rm(stage,{recursive:true,force:true});
    if(tempRoot)await rm(tempRoot,{recursive:true,force:true});
    unlock();
  }
}
export async function verifyMigration(directory) {
  const root=resolve(directory);
  const rootInfo=await lstat(root);
  assert(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'Migration directory cannot be a symlink');
  await regularFile(join(root,'manifest.json'));
  const parsed=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
  assert(parsed.format==='osmanx-pg-offline-v1' && parsed.version===1, 'Unknown migration format');
  assert(Array.isArray(parsed.databases) && parsed.databases.length>0, 'Empty manifest');
  assert(parsed.access?.file==='access.sql' && SHA.test(parsed.access.sha256), 'Missing tenant access plan');
  await regularFile(join(root,parsed.access.file));
  assert(await sha256RegularFile(join(root,parsed.access.file))===parsed.access.sha256,'Tenant access SQL checksum mismatch');
  const used=new Set();
  for(const entry of parsed.databases){
    checkFileName(entry.sqlFile);q(entry.schema);
    assert(!used.has(entry.schema),'Duplicate PostgreSQL schema');used.add(entry.schema);
    assert(SHA.test(entry.sqlSha256) && Array.isArray(entry.tables), 'Malformed manifest entry');
    const file=join(root,entry.sqlFile);await regularFile(file);
    assert(await sha256RegularFile(file)===entry.sqlSha256,'SQL checksum mismatch: '+entry.sqlFile);
    for(const t of entry.tables){q(t.name);assert(Number.isSafeInteger(t.rows) && t.rows>=0 && SHA.test(t.sha256),'Malformed table summary');}
  }
  return parsed;
}
function verificationQuery(entry,table) {
  const columns=table.columns.map(c=>{
    const col=q(c.name);
    if(c.type==='BYTEA')return `encode(${col},'hex')`;
    if(c.type==='DOUBLE PRECISION')return `${col}::text`;
    return `${col}::text`;
  });
  const query=`SELECT json_build_array(${columns.join(', ')})::text FROM ${q(entry.schema)}.${q(table.name)} ORDER BY ${table.primary.map(q).join(', ')}`;
  return query;
}
export function pgVerificationQueries(manifest) {
  return manifest.databases.flatMap(entry=>entry.tables.map(t=>({schema:entry.schema,table:t.name,
    sql:verificationQuery(entry,t),expectedRows:t.rows,expectedSha256:t.sha256,columns:t.columns})));
}
export async function verifyPostgres(directory, {psql='psql'}={}) {
  const manifest=await verifyMigration(directory);
  const outcomes=[];
  for(const expected of pgVerificationQueries(manifest)){
    const args=['-X','--no-align','--tuples-only','--set=ON_ERROR_STOP=1','--command',expected.sql];
    const child=spawn(psql,args,{stdio:['ignore','pipe','pipe'],env:process.env});
    const exit=new Promise((ok,fail)=>{child.once('error',fail);child.once('close',ok);});
    const hash=createHash('sha256');let count=0,stderr='';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data',buf=>{stderr=(stderr+buf).slice(-2000);});
    try{
      for await(const line of createInterface({input:child.stdout,crlfDelay:Infinity})){
        const vals=JSON.parse(line);
        assert(Array.isArray(vals) && vals.length===expected.columns.length,'Invalid PostgreSQL verification row');
        const normalized=vals.map((v,i)=>v===null?null:expected.columns[i].type==='DOUBLE PRECISION'?String(Number(v)):String(v));
        hash.update(JSON.stringify(normalized)+'\n');count++;
      }
    }catch(e){child.kill();throw e;}
    const code=await exit;
    assert(code===0,'psql verification failed for '+expected.schema+'.'+expected.table+': '+stderr);
    const digest=hash.digest('hex');
    assert(count===expected.expectedRows && digest===expected.expectedSha256,
      'PostgreSQL data mismatch: '+expected.schema+'.'+expected.table);
    outcomes.push({schema:expected.schema,table:expected.table,rows:count,hashVerified:true});
  }
  return {ok:true,tables:outcomes.length,results:outcomes};
}
