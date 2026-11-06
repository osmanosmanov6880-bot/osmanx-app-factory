// R4.3: disposable SQLite shadow replay of signed, audited PostgreSQL Preview changes.
// NO writes to the live primary. NO production cutover or bidirectional replication.
import {createHash,createHmac} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {lstatSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {quoteIdent} from './pg-kit.mjs';
import {verifyTrustedMigration} from './pg-trust.mjs';
import {r43AfterImageHmac,r43AuditVersion} from './r42-pg-audit.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MUTABLE=new Set(['clients','tasks','visits']);
const REPLAY_ORDER=['clients','tasks','visits','audit_log'];
function ensure(ok,message){if(!ok)throw Error('R4.3 shadow replay denied: '+message);}
function normalized(v,type){
  if(v===null)return null;
  if(type==='BYTEA'){
    ensure(v instanceof Uint8Array,'invalid BYTEA value');return Buffer.from(v).toString('hex');
  }
  if(type==='DOUBLE PRECISION'){
    const n=Number(v);ensure(Number.isFinite(n),'invalid floating point');return String(n);
  }
  if(type==='BIGINT'){
    const n=String(v);ensure(/^-?\d+$/.test(n),'invalid bigint');
    if(typeof v==='number')ensure(Number.isSafeInteger(v),'unsafe integer');
    ensure(BigInt(n)<=BigInt(Number.MAX_SAFE_INTEGER)&&BigInt(n)>=BigInt(Number.MIN_SAFE_INTEGER),
      'value cannot be safely represented in SQLite');return n;
  }
  ensure(type==='TEXT'&&typeof v==='string'&&!v.includes('\0'),'invalid text');
  return v;
}
function sqliteValue(v,type){
  if(v===null)return null;
  const normalizedValue=normalized(v,type);
  if(type==='BIGINT')return Number(normalizedValue);
  if(type==='DOUBLE PRECISION')return Number(normalizedValue);
  if(type==='BYTEA')return Buffer.from(normalizedValue,'hex');
  return normalizedValue;
}
function checkedTable(t){
  ensure(t&&typeof t.name==='string'&&Array.isArray(t.primary)&&t.primary.length>0,'invalid signed table');
  quoteIdent(t.name);
  ensure(Array.isArray(t.columns)&&t.columns.length>0&&t.columns.length<=100,'invalid signed columns');
  const names=new Set();
  for(const c of t.columns){
    ensure(c&&typeof c.name==='string'&&['TEXT','BIGINT','DOUBLE PRECISION','BYTEA'].includes(c.type),
      'invalid signed column');
    quoteIdent(c.name);ensure(!names.has(c.name),'duplicate signed column');names.add(c.name);
  }
  for(const p of t.primary)ensure(names.has(p),'unknown signed primary key');
  return t;
}
function rowCells(row,table){
  ensure(row&&typeof row==='object','invalid row');
  return table.columns.map(c=>normalized(row[c.name],c.type));
}
function rowKey(row,table){
  const cols=table.columns;
  return JSON.stringify(table.primary.map(key=>normalized(row[key],cols.find(c=>c.name===key).type)));
}
function rowHash(row,table){return createHash('sha256').update(JSON.stringify(rowCells(row,table))).digest('hex');}
function mapRows(rows,table){
  const mapped=new Map();
  for(const row of rows){
    const key=rowKey(row,table);
    ensure(!mapped.has(key),'duplicate row key');
    mapped.set(key,{row,hash:rowHash(row,table)});
  }
  return mapped;
}
function sqlRows(db,table,maxRows){
  const count=db.prepare('SELECT COUNT(*) AS n FROM '+quoteIdent(table.name)).get().n;
  ensure(Number.isSafeInteger(count)&&count>=0&&count<=maxRows,'SQLite row limit exceeded: '+table.name);
  const cols=table.columns.map(c=>quoteIdent(c.name)).join(',');
  const order=table.primary.map(quoteIdent).join(',');
  return db.prepare('SELECT '+cols+' FROM '+quoteIdent(table.name)+' ORDER BY '+order).all();
}
function sourceHash(rows,table){
  const digest=createHash('sha256');
  for(const row of rows)digest.update(JSON.stringify(rowCells(row,table))+'\n');
  return digest.digest('hex');
}
function compareRecords(source,target,table){
  const a=mapRows(source,table),b=mapRows(target,table);
  const missing=[],added=[],changed=[];
  for(const [key,r] of a){
    if(!b.has(key))missing.push(r.row);
    else if(b.get(key).hash!==r.hash)changed.push(b.get(key).row);
  }
  for(const [key,r] of b)if(!a.has(key))added.push(r.row);
  return {missing,added,changed};
}
function inventory(db,manifestNames){
  const actual=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(x=>x.name);
  const expected=[...manifestNames].sort();
  ensure(JSON.stringify(actual)===JSON.stringify(expected),'SQLite inventory differs from signed bundle');
}
function validateAudit(events,original,secret){
  const base=mapRows(original,{name:'audit_log',columns:[{name:'id',type:'TEXT'}],primary:['id']});
  const signatures=new Set(),creations=new Set(),latest=new Map();
  for(const entry of events){
    if(base.has(JSON.stringify([entry.id])))continue;
    ensure(UUID.test(entry.id)&&UUID.test(entry.entity_id||''),'new audit entry IDs invalid');
    ensure(['pg-preview.create','pg-preview.update'].includes(entry.action) && MUTABLE.has(entry.entity),
      'untrusted audit action');
    let metadata;
    try{metadata=JSON.parse(entry.metadata_json);}catch{throw Error('R4.3 shadow replay denied: audit metadata invalid');}
    ensure(metadata?.surface==='postgresql-preview'&&['employee','studio-owner'].includes(metadata.actorKind)
      &&metadata.auditVersion==='r43-after-image-v1'&&/^[a-f0-9]{64}$/.test(metadata.afterImageHmac||''),
      'audit origin or cryptographic after-image not verified');
    const version=r43AuditVersion(entry.entity,{
      updated_at:metadata.afterImageVersion,created_at:metadata.afterImageVersion
    });
    const id=entry.entity+':'+entry.entity_id;
    const earlier=latest.get(id);
    ensure(!earlier||earlier.version!==version||earlier.hash===metadata.afterImageHmac,
      'ambiguous same-version audit after-images');
    if(!earlier||version>earlier.version)
      latest.set(id,{version,hash:metadata.afterImageHmac});
    signatures.add(id+':'+entry.action+':'+metadata.afterImageHmac);
    if(entry.action==='pg-preview.create')creations.add(id);
  }
  return {signatures,creations,latest,size:signatures.size};
}
function preparePlan(db,captures,secret){
  const byName=new Map();
  for(const c of captures){
    const table=checkedTable(c.table);
    ensure(!byName.has(table.name)&&Array.isArray(c.postgresRows),'duplicate/invalid captured table');
    byName.set(table.name,c);
  }
  ensure(byName.has('audit_log'),'PostgreSQL mutation audit required');
  const origAudit=sqlRows(db,byName.get('audit_log').table,10000);
  const coverage=validateAudit(byName.get('audit_log').postgresRows,origAudit,secret);
  const plan=[],counts=[],observed=new Set();
  for(const c of captures){
    const table=c.table,name=table.name;
    const source=sqlRows(db,table,10000);
    const delta=compareRecords(source,c.postgresRows,table);
    ensure(delta.missing.length===0,'PostgreSQL removed source records in '+name);
    if(name==='audit_log'){
      ensure(delta.changed.length===0,'PostgreSQL audit history edited');
      for(const row of delta.added)plan.push({name,kind:'insert',table,row});
      counts.push({table:name,insert:delta.added.length,update:0});
      continue;
    }
    if(!MUTABLE.has(name)){
      ensure(delta.added.length===0&&delta.changed.length===0,'unsupported PostgreSQL mutation in '+name);
      counts.push({table:name,insert:0,update:0});
      continue;
    }
    for(const row of c.postgresRows){
      const id=name+':'+row.id;
      observed.add(id);
      const last=coverage.latest.get(id);
      if(last){
        ensure(last.version===r43AuditVersion(name,row)&&
          last.hash===r43AfterImageHmac(secret,name,row),
          'latest signed after-image does not match PostgreSQL row');
      }
    }
    for(const row of delta.added){
      const expected=r43AfterImageHmac(secret,name,row);
      const signature=name+':'+row.id+':';
      ensure(coverage.creations.has(signature.slice(0,-1))&&
        (coverage.signatures.has(signature+'pg-preview.create:'+expected)||
         coverage.signatures.has(signature+'pg-preview.update:'+expected)),
        'new '+name+' record has no matching signed after-image');
      plan.push({name,kind:'insert',table,row});
    }
    for(const row of delta.changed){
      const expected=r43AfterImageHmac(secret,name,row);
      ensure(coverage.signatures.has(name+':'+row.id+':pg-preview.update:'+expected),
        'updated '+name+' record has no matching signed after-image');
      plan.push({name,kind:'update',table,row});
    }
    counts.push({table:name,insert:delta.added.length,update:delta.changed.length});
  }
  for(const id of coverage.latest.keys())
    ensure(observed.has(id),'signed audit event targets a missing PostgreSQL row');
  plan.sort((a,b)=>REPLAY_ORDER.indexOf(a.name)-REPLAY_ORDER.indexOf(b.name));
  return {plan,counts,auditEventCount:coverage.size};
}
function executeChanges(db,plan,{faultAfterTable=null}={}){
  let last=null,inserted=0,updated=0;
  for(const item of plan){
    const {table,row,kind,name}=item;
    if(last!==null&&name!==last&&faultAfterTable===last)
      throw Error('R4.3 injected shadow failure after '+last);
    const columns=table.columns.map(c=>c.name),keys=table.primary;
    const args=table.columns.map(c=>sqliteValue(row[c.name],c.type));
    if(kind==='insert'){
      const statement='INSERT INTO '+quoteIdent(name)+' ('+columns.map(quoteIdent).join(',')+
        ') VALUES ('+columns.map(()=>'?').join(',')+')';
      db.prepare(statement).run(...args);inserted++;
    }else{
      const remaining=columns.filter(c=>!keys.includes(c));
      ensure(remaining.length>0,'no mutable columns');
      const stmt='UPDATE '+quoteIdent(name)+' SET '+remaining.map(c=>quoteIdent(c)+'=?').join(',')+
        ' WHERE '+keys.map(c=>quoteIdent(c)+'=?').join(' AND ');
      const val=remaining.map(c=>sqliteValue(row[c],table.columns.find(x=>x.name===c).type));
      const pk=keys.map(c=>sqliteValue(row[c],table.columns.find(x=>x.name===c).type));
      ensure(db.prepare(stmt).run(...val,...pk).changes===1,'shadow update failed');updated++;
    }
    last=name;
  }
  if(faultAfterTable!==null&&last===faultAfterTable)throw Error('R4.3 injected shadow failure after '+last);
  return {inserted,updated};
}
// Deterministic, transaction-safe replay into a shadow ONLY. Exported for
// isolated crash/retry unit tests; the server does not pass failure options.
export function applyR43ShadowPatch(db,captures,{faultAfterTable=null,secret}={}){
  ensure(Buffer.isBuffer(secret)&&secret.length>=32,'external after-image key required');
  ensure(db&&typeof db.prepare==='function','shadow SQLite handle required');
  ensure(Array.isArray(captures)&&captures.length>0&&captures.length<=60,'invalid table capture');
  ensure(faultAfterTable===null||REPLAY_ORDER.includes(faultAfterTable),'unknown synthetic fault injection');
  const {plan,counts,auditEventCount}=preparePlan(db,captures,secret);
  db.exec('BEGIN IMMEDIATE');
  try{
    const changes=executeChanges(db,plan,{faultAfterTable});
    const fk=db.prepare('PRAGMA foreign_key_check').all();
    ensure(fk.length===0,'shadow foreign-key integrity failed');
    for(const c of captures){
      const rows=sqlRows(db,c.table,10000);
      const delta=compareRecords(rows,c.postgresRows,c.table);
      ensure(delta.added.length===0&&delta.changed.length===0&&delta.missing.length===0,
        'shadow diverges from captured PostgreSQL '+c.table.name);
    }
    db.exec('COMMIT');
    return {...changes,auditEventCount,tables:counts,shadowVerified:true};
  }catch(e){db.exec('ROLLBACK');throw e;}
}
async function capturePgSnapshot(adapter,actorId,projectId,entry,maxRows){
  return adapter.transaction({actorId,projectId,mode:'read',snapshot:true},async scope=>{
    const names=(await scope.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1',[entry.schema]))
      .rows.map(x=>x.tablename).filter(x=>x!=='_ox_migration_control').sort();
    ensure(JSON.stringify(names)===JSON.stringify(entry.tables.map(t=>t.name).sort()),
      'PostgreSQL inventory differs from signed bundle');
    const result=[];
    for(const table of entry.tables.filter(t=>!t.sessionRowsExcluded).map(checkedTable)){
      const count=(await scope.query('SELECT COUNT(*)::bigint AS n FROM '+quoteIdent(table.name))).rows?.[0]?.n;
      const total=Number(count);
      ensure(Number.isSafeInteger(total)&&total>=0&&total<=maxRows,'PostgreSQL row limit exceeded: '+table.name);
      const order=table.primary.map(quoteIdent).join(',');
      const columns=table.columns.map(c=>quoteIdent(c.name)).join(',');
      const rows=[];
      for(let i=0;i<total;i+=250){
        const slice=await scope.query('SELECT '+columns+' FROM '+quoteIdent(table.name)+
          ' ORDER BY '+order+' LIMIT $1 OFFSET $2',[Math.min(250,total-i),i]);
        ensure(slice.rows.length===Math.min(250,total-i),'unstable PostgreSQL snapshot');
        rows.push(...slice.rows);
      }
      result.push({table,postgresRows:rows});
    }
    return result;
  });
}
function baselineCheck(db,entry,maxRows){
  inventory(db,entry.tables.map(t=>t.name));
  for(const table of entry.tables.filter(t=>!t.sessionRowsExcluded).map(checkedTable)){
    const rows=sqlRows(db,table,maxRows);
    ensure(rows.length===table.rows&&sourceHash(rows,table)===table.sha256,
      'source changed since signed export: '+table.name);
  }
}
function fingerprint(captures,secret){
  const h=createHmac('sha256',secret).update('OSMANX-R43-SHADOW-CHECKPOINT\0');
  for(const c of [...captures].sort((a,b)=>a.table.name.localeCompare(b.table.name))){
    h.update(c.table.name+'\0');
    const index=mapRows(c.postgresRows,c.table);
    for(const [key,item] of [...index].sort(([a],[b])=>a<b?-1:a>b?1:0))
      h.update(key+'\0'+item.hash+'\n');
  }
  return h.digest('hex');
}
// Creates a disposable copy, validates the signed source baseline, captures a
// tenant REPEATABLE READ snapshot, replays only audited Preview mutations,
// verifies all tables and repeats idempotently, then deletes sensitive shadow.
export async function runR43ShadowReplay({
  sqlitePath,adapter,bundleDir,trustedPublicKey,actorId,projectId,secret,maxRowsPerTable=5000
}={}){
  ensure(typeof projectId==='string'&&UUID.test(projectId),'invalid project ID');
  ensure(typeof actorId==='string'&&actorId.length>0,'actor ID required');
  ensure(Buffer.isBuffer(secret)&&secret.length>=32,'external HMAC key required');
  ensure(adapter&&typeof adapter.transaction==='function','signed PG adapter required');
  ensure(typeof sqlitePath==='string'&&sqlitePath.length>0,'SQLite source path required');
  const sourceInfo=lstatSync(sqlitePath);
  ensure(sourceInfo.isFile()&&!sourceInfo.isSymbolicLink()&&sourceInfo.size<=128*1024*1024,
    'source SQLite file is not a bounded regular file');
  ensure(Number.isSafeInteger(maxRowsPerTable)&&maxRowsPerTable>=1&&maxRowsPerTable<=10000,'invalid limit');
  const {manifest,manifestSha256,keyFingerprint}=await verifyTrustedMigration(bundleDir,trustedPublicKey);
  const entry=manifest.databases.find(d=>d.projectId===projectId);
  ensure(entry?.role==='crm'&&entry.schema==='ox_p_'+projectId.replaceAll('-',''),'signed CRM tenant absent');
  const directory=await mkdtemp(join(tmpdir(),'ox-r43-shadow-'));
  const shadow=join(directory,'offline-shadow.sqlite');
  const startedAt=new Date().toISOString();
  let db;
  try{
    const source=new DatabaseSync(sqlitePath,{readOnly:true});
    try{await backup(source,shadow);}finally{source.close();}
    ensure(lstatSync(shadow).size<=128*1024*1024,'shadow snapshot exceeds size limit');
    db=new DatabaseSync(shadow,{enableForeignKeyConstraints:true});
    db.exec('PRAGMA foreign_keys=ON');
    baselineCheck(db,entry,maxRowsPerTable);
    const captures=await capturePgSnapshot(adapter,actorId,projectId,entry,maxRowsPerTable);
    const initial=applyR43ShadowPatch(db,captures,{secret});
    const retry=applyR43ShadowPatch(db,captures,{secret});
    ensure(retry.inserted===0&&retry.updated===0,'shadow replay is not idempotent');
    const token=createHmac('sha256',secret).update('r43-tenant:').update(projectId).digest('hex').slice(0,20);
    return {format:'osmanx-r43-shadow-replay-v1',syntheticOnly:true,readOnlySource:true,
      signedManifestVerified:true,manifestSha256,keyFingerprint,tenantToken:token,
      startedAt,finishedAt:new Date().toISOString(),postgresSnapshotRepeatableRead:true,
      sourceBaselineVerified:true,auditCoverageVerified:true,
      firstPass:{inserted:initial.inserted,updated:initial.updated,auditEventCount:initial.auditEventCount},
      idempotentRetryVerified:true,retryPass:{inserted:retry.inserted,updated:retry.updated},
      tableCount:captures.length,shadowAligned:true,
      checkpointHmac:fingerprint(captures,secret),
      shadowDestroyedOnExit:true,primarySqliteModified:false,productionCutoverAllowed:false};
  }finally{
    try{db?.close();}finally{await rm(directory,{recursive:true,force:true});}
  }
}
