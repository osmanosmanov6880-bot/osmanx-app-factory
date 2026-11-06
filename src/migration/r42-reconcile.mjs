// R4.2 signed-tenant, read-only PostgreSQL <-> SQLite drift assessment.
// Both backends are snapshotted independently. This does NOT prove safe cutover.
import {createHash,createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {lstatSync} from 'node:fs';
import {quoteIdent} from './pg-kit.mjs';
import {verifyTrustedMigration} from './pg-trust.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function guard(value,message){if(!value)throw Error('R4.2 reconciliation refused: '+message);}
function boundedNumber(raw,max,label){
  const value=Number(raw);
  guard(Number.isSafeInteger(value)&&value>=0&&value<=max,label+' exceeds supported limit');
  return value;
}
function keyFor(secret,domain,value){
  return createHmac('sha256',secret).update(domain).update(value).digest('hex');
}
function normalize(value,type){
  if(value===null)return null;
  if(type==='BYTEA'){
    guard(value instanceof Uint8Array,'invalid binary cell');
    return Buffer.from(value).toString('hex');
  }
  if(type==='DOUBLE PRECISION'){
    const n=Number(value);guard(Number.isFinite(n),'invalid float cell');return String(n);
  }
  if(type==='BIGINT'){
    const s=String(value);guard(/^-?\d+$/.test(s),'invalid integer cell');
    guard(typeof value!=='number'||Number.isSafeInteger(value),'unsafe source integer');return s;
  }
  guard(type==='TEXT'&&typeof value==='string','unsupported cell type');return value;
}
function checkedTable(table){
  guard(table&&typeof table.name==='string'&&Array.isArray(table.primary)&&table.primary.length>0,'invalid signed table');
  quoteIdent(table.name);
  guard(Array.isArray(table.columns)&&table.columns.length>0&&table.columns.length<=100,'invalid signed columns');
  const names=new Set();
  for(const col of table.columns){
    guard(col&&typeof col.name==='string'&&['TEXT','BIGINT','DOUBLE PRECISION','BYTEA'].includes(col.type),
      'invalid signed column');
    quoteIdent(col.name);guard(!names.has(col.name),'duplicate column');names.add(col.name);
  }
  for(const p of table.primary){quoteIdent(p);guard(names.has(p),'invalid primary key');}
  return table;
}
function indexRows(rows,table,secret){
  const map=new Map(),baseline=createHash('sha256');
  for(const row of rows){
    guard(row&&typeof row==='object','invalid row');
    const cells=table.columns.map(c=>normalize(row[c.name],c.type));
    const pk=JSON.stringify(table.primary.map(p=>cells[table.columns.findIndex(c=>c.name===p)]));
    guard(!map.has(pk),'duplicate primary key');
    baseline.update(JSON.stringify(cells)+'\n');
    map.set(pk,keyFor(secret,'r42-value:',JSON.stringify(cells)));
  }
  return {map,baselineSha256:baseline.digest('hex')};
}
function mapDigest(map,secret){
  const h=createHmac('sha256',secret);h.update('r42-table:');
  for(const [id,hash] of [...map].sort(([a],[b])=>a<b?-1:a>b?1:0))
    h.update(JSON.stringify([id,hash])+'\n');
  return h.digest('hex');
}
export function diffR42Rows(source,target,{secret,sampleLimit=5}={}){
  guard(source instanceof Map&&target instanceof Map,'row indexes required');
  guard(Buffer.isBuffer(secret)&&secret.length>=32,'private HMAC secret required');
  guard(Number.isInteger(sampleLimit)&&sampleLimit>=0&&sampleLimit<=10,'invalid sample limit');
  let missingInPostgres=0,extraInPostgres=0,changed=0;
  const sample=[];
  const mark=(kind,pk)=>{
    if(sample.length<sampleLimit)sample.push({kind,recordToken:keyFor(secret,'r42-key:',pk).slice(0,20)});
  };
  for(const [pk,sha] of source){
    if(!target.has(pk)){missingInPostgres++;mark('missing-in-postgres',pk);}
    else if(target.get(pk)!==sha){changed++;mark('changed',pk);}
  }
  for(const pk of target.keys())if(!source.has(pk)){extraInPostgres++;mark('extra-in-postgres',pk);}
  return {missingInPostgres,extraInPostgres,changed,
    differences:missingInPostgres+extraInPostgres+changed,sample};
}
function readSqlite(db,table,count,pageSize){
  const cols=table.columns.map(c=>quoteIdent(c.name)).join(',');
  const order=table.primary.map(quoteIdent).join(',');
  const stmt=db.prepare('SELECT '+cols+' FROM '+quoteIdent(table.name)+' ORDER BY '+order+' LIMIT ? OFFSET ?');
  const out=[];
  for(let i=0;i<count;i+=pageSize){
    const chunk=stmt.all(Math.min(pageSize,count-i),i);
    guard(chunk.length===Math.min(pageSize,count-i),'SQLite pagination inconsistent');
    out.push(...chunk);
  }
  return out;
}
async function readPostgres(scope,table,count,pageSize){
  const cols=table.columns.map(c=>quoteIdent(c.name)).join(',');
  const order=table.primary.map(quoteIdent).join(',');
  const out=[];
  for(let i=0;i<count;i+=pageSize){
    const chunk=await scope.query('SELECT '+cols+' FROM '+quoteIdent(table.name)+
      ' ORDER BY '+order+' LIMIT $1 OFFSET $2',[Math.min(pageSize,count-i),i]);
    guard(Array.isArray(chunk.rows)&&chunk.rows.length===Math.min(pageSize,count-i),'PostgreSQL pagination inconsistent');
    out.push(...chunk.rows);
  }
  return out;
}
function sameInventory(names,expected){return names.length===expected.length&&names.every((n,i)=>n===expected[i]);}
export async function reconcileSignedTenant({
  sqlitePath,adapter,bundleDir,trustedPublicKey,actorId,projectId,secret,
  maxRowsPerTable=5000,pageSize=200,sampleLimit=5
}={}){
  guard(typeof sqlitePath==='string'&&sqlitePath.length>0,'source path required');
  const file=lstatSync(sqlitePath);
  guard(file.isFile()&&!file.isSymbolicLink(),'SQLite file must be regular and not linked');
  guard(adapter&&typeof adapter.transaction==='function','PG tenant adapter required');
  guard(typeof projectId==='string'&&UUID.test(projectId),'project UUID required');
  guard(typeof actorId==='string'&&actorId.length>0,'actor required');
  guard(Buffer.isBuffer(secret)&&secret.length>=32,'external private HMAC key required');
  guard(Number.isInteger(maxRowsPerTable)&&maxRowsPerTable>=1&&maxRowsPerTable<=10000,'invalid row limit');
  guard(Number.isInteger(pageSize)&&pageSize>=1&&pageSize<=500,'invalid page size');
  guard(Number.isInteger(sampleLimit)&&sampleLimit>=0&&sampleLimit<=10,'invalid sample size');
  const {manifest,manifestSha256,keyFingerprint}=await verifyTrustedMigration(bundleDir,trustedPublicKey);
  const entry=manifest.databases.find(d=>d.projectId===projectId);
  guard(entry&&entry.role==='crm'&&entry.schema==='ox_p_'+projectId.replaceAll('-',''),'unsigned CRM tenant');
  const tables=entry.tables.filter(t=>t.sessionRowsExcluded!==true).map(checkedTable);
  guard(tables.length>0&&tables.length<=60,'invalid signed table inventory');
  const expectedNames=entry.tables.map(t=>t.name).sort();
  const db=new DatabaseSync(sqlitePath,{readOnly:true});
  const startedAt=new Date().toISOString();
  let snapshot;
  try{
    snapshot=await adapter.transaction({actorId,projectId,mode:'read',snapshot:true},async scope=>{
      db.exec('BEGIN');
      try{
        const sqliteNames=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name);
        const pgNames=(await scope.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1',[entry.schema]))
          .rows.map(x=>x.tablename).filter(x=>x!=='_ox_migration_control').sort();
        guard(sameInventory(sqliteNames,expectedNames),'SQLite table inventory differs from signed manifest');
        guard(sameInventory(pgNames,expectedNames),'PostgreSQL table inventory differs from signed manifest');
        const results=[];
        for(const table of tables){
          const sqliteTotal=boundedNumber(db.prepare('SELECT COUNT(*) AS n FROM '+quoteIdent(table.name)).get().n,
            maxRowsPerTable,'SQLite '+table.name);
          const pgCount=await scope.query('SELECT COUNT(*)::bigint AS n FROM '+quoteIdent(table.name));
          guard(pgCount.rows?.length===1,'invalid PostgreSQL table count');
          const pgTotal=boundedNumber(pgCount.rows[0].n,maxRowsPerTable,'PostgreSQL '+table.name);
          const sqlite=indexRows(readSqlite(db,table,sqliteTotal,pageSize),table,secret);
          const postgres=indexRows(await readPostgres(scope,table,pgTotal,pageSize),table,secret);
          const drift=diffR42Rows(sqlite.map,postgres.map,{secret,sampleLimit});
          const sourceBaselineMatch=sqliteTotal===table.rows&&sqlite.baselineSha256===table.sha256;
          results.push({table:table.name,sqliteRows:sqliteTotal,postgresRows:pgTotal,
            sqliteDigest:mapDigest(sqlite.map,secret),postgresDigest:mapDigest(postgres.map,secret),
            sourceBaselineMatch,...drift});
        }
        return results;
      }finally{db.exec('ROLLBACK');}
    });
  }finally{db.close();}
  const totalDifferences=snapshot.reduce((n,t)=>n+t.differences,0);
  const sourceBaselineMismatchTables=snapshot.filter(t=>!t.sourceBaselineMatch).map(t=>t.table);
  return {format:'osmanx-r42-reconciliation-v1',syntheticOnly:true,readOnly:true,
    source:'sqlite',target:'postgresql-preview',manifestSha256,keyFingerprint,
    tenantToken:keyFor(secret,'r42-tenant:',projectId).slice(0,20),
    startedAt,finishedAt:new Date().toISOString(),signedManifestVerified:true,
    independentSnapshots:true,distributedWriteFreezeVerified:false,
    tables:snapshot,tableCount:snapshot.length,totalDifferences,sourceBaselineMismatchTables,
    ok:totalDifferences===0&&sourceBaselineMismatchTables.length===0,
    productionCutoverAllowed:false};
}
export function assessCutoverReadiness(report){
  guard(report?.format==='osmanx-r42-reconciliation-v1','invalid receipt');
  const blockers=[];
  if(!report.signedManifestVerified)blockers.push('signed-migration-not-verified');
  if(report.totalDifferences!==0||!report.ok)blockers.push('sqlite-postgresql-drift');
  if(report.sourceBaselineMismatchTables?.length)blockers.push('sqlite-source-changed-since-export');
  if(!report.independentSnapshots)blockers.push('snapshot-integrity-unverified');
  blockers.push('no-coordinated-write-fence-or-change-stream');
  blockers.push('full-crm-feature-parity-and-restore-drill-not-accepted');
  blockers.push('manual-production-approval-and-rollback-plan-missing');
  return {eligibleForFurtherReview:report.ok===true&&report.signedManifestVerified===true,
    blockers,productionCutoverAllowed:false,primaryRuntime:'sqlite',action:'manual-review-only'};
}
