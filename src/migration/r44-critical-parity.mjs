// R4.4: read-only financial, automation and custom-entity parity for signed
// synthetic CRM snapshots. No payment execution, no primary writes or cutover.
import {createHmac} from 'node:crypto';
import {quoteIdent} from './pg-kit.mjs';

const CRITICAL=new Set(['payments','automations','automation_runs','custom_entity_schema']);
const ALWAYS=['payments','automations','automation_runs','custom_entity_schema','clients','users','tasks'];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG=/^[a-z][a-z0-9_]{1,31}$/;
const ENUMS={
  currency:new Set(['RUB','EUR','USD']),
  method:new Set(['cash','bank_transfer','terminal','other']),
  status:new Set(['pending','paid','refunded','cancelled']),
  event:new Set(['client_created','visit_created','entity_created']),
  priority:new Set(['low','medium','high']),
  type:new Set(['text','longtext','integer','number','boolean','date','select','reference'])
};
function requireThat(ok,code){if(!ok)throw Error('R4.4 critical parity refused: '+code);}
function safeInt(value,max=Number.MAX_SAFE_INTEGER){
  const raw=String(value);
  requireThat(/^-?\d+$/.test(raw),'unsafe integer');
  const number=Number(raw);
  requireThat(Number.isSafeInteger(number)&&Math.abs(number)<=max,'integer out of range');
  return number;
}
function normalized(v,type){
  if(v===null)return null;
  if(type==='BYTEA'){
    requireThat(v instanceof Uint8Array,'invalid BYTEA cell');
    return Buffer.from(v).toString('hex');
  }
  if(type==='BIGINT')return String(safeInt(v));
  if(type==='DOUBLE PRECISION'){
    const n=Number(v);requireThat(Number.isFinite(n),'invalid numeric cell');return String(n);
  }
  requireThat(type==='TEXT'&&typeof v==='string','invalid text cell');
  return v;
}
function tableRows(db,table){
  const cols=table.columns.map(c=>quoteIdent(c.name)).join(',');
  const order=table.primary.map(quoteIdent).join(',');
  const rows=db.prepare('SELECT '+cols+' FROM '+quoteIdent(table.name)+' ORDER BY '+order).all();
  requireThat(rows.length<=10000,'SQLite table limit: '+table.name);
  return rows;
}
function digest(rows,table,secret){
  const h=createHmac('sha256',secret).update('OSMANX-R44-TABLE-PARITY-v1\0'+table.name+'\0');
  const seen=new Set();
  for(const row of rows){
    const id=JSON.stringify(table.primary.map(c=>row[c]));
    requireThat(!seen.has(id),'duplicate signed row key');seen.add(id);
    h.update(JSON.stringify(table.columns.map(c=>normalized(row[c.name],c.type)))+'\n');
  }
  return h.digest('hex');
}
function requireIds(rows,name){return new Set(rows.map(r=>{requireThat(typeof r.id==='string'&&UUID.test(r.id),'invalid '+name+' record ID');return r.id;}));}
function inspectPayments(rows,clients,users,secret){
  const idem=new Set(),aggregates=new Map();
  for(const p of rows){
    requireThat(typeof p.id==='string'&&UUID.test(p.id),'invalid payment ID');
    const minor=safeInt(p.amount_minor,999999999999);
    requireThat(minor>0,'invalid payment amount');
    for(const key of ['currency','method','status'])
      requireThat(ENUMS[key].has(p[key]),'invalid payment '+key);
    requireThat(p.client_id===null||clients.has(p.client_id),'payment references unknown client');
    requireThat(p.created_by===null||users.has(p.created_by),'payment references unknown employee');
    if(p.idem_key!==null){
      requireThat(typeof p.idem_key==='string'&&p.idem_key.length>0,'invalid idempotency key');
      requireThat(!idem.has(p.idem_key),'duplicate payment idempotency key');idem.add(p.idem_key);
    }
    requireThat(p.request_fingerprint===null||typeof p.request_fingerprint==='string',
      'invalid payment fingerprint');
    const key=p.currency+':'+p.status;
    const prev=aggregates.get(key)||{count:0,minor:0n};
    prev.count++;prev.minor+=BigInt(minor);aggregates.set(key,prev);
  }
  const groupList=[...aggregates].sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>[k,v.count,String(v.minor)]);
  const aggregateHmac=createHmac('sha256',secret)
    .update('OSMANX-R44-PAYMENT-TOTALS-v1\0').update(JSON.stringify(groupList)).digest('hex');
  return {records:rows.length,currencyStatusGroups:aggregates.size,
    financialTotalsHmac:aggregateHmac,idempotencyKeysVerified:true,
    amountBoundsVerified:true,foreignReferencesVerified:true};
}
function inspectAutomations(rules,runs,tasks,users,slugs){
  const ruleIds=new Set(),dedupe=new Set();
  for(const r of rules){
    requireThat(typeof r.id==='string'&&UUID.test(r.id),'invalid automation ID');
    requireThat(!ruleIds.has(r.id),'duplicate automation ID');ruleIds.add(r.id);
    requireThat(ENUMS.event.has(r.event),'invalid automation event');
    requireThat(ENUMS.priority.has(r.priority),'invalid automation priority');
    requireThat([0,1].includes(safeInt(r.enabled,1)),'invalid automation enabled flag');
    requireThat(safeInt(r.due_days,365)>=0,'invalid automation due date');
    requireThat(r.created_by===null||users.has(r.created_by),'automation references missing user');
    if(r.event==='entity_created'){
      requireThat(typeof r.entity_slug==='string'&&slugs.has(r.entity_slug),
        'automation references missing custom entity');
    }
  }
  for(const r of runs){
    requireThat(ruleIds.has(r.automation_id),'automation run references missing rule');
    requireThat(tasks.has(r.task_id),'automation run references missing task');
    requireThat(typeof r.event_key==='string'&&r.event_key.length>0,'invalid automation event key');
    const key=JSON.stringify([r.automation_id,r.event_key]);
    requireThat(!dedupe.has(key),'duplicate automation execution key');dedupe.add(key);
  }
  return {rules:rules.length,runs:runs.length,idempotencyVerified:true,
    taskReferencesVerified:true,customEventReferencesVerified:true};
}
function inspectCustomEntities(meta,captures,users){
  const slugs=new Set(),schema=[];
  for(const record of meta){
    requireThat(typeof record.slug==='string'&&SLUG.test(record.slug),'invalid entity slug');
    requireThat(!slugs.has(record.slug),'duplicate entity slug');slugs.add(record.slug);
    let definition;
    try{definition=JSON.parse(record.definition_json);}
    catch{throw Error('R4.4 critical parity refused: malformed custom entity definition');}
    requireThat(definition?.slug===record.slug&&Array.isArray(definition.fields)&&
      definition.fields.length>=1&&definition.fields.length<=24,'custom entity definition mismatch');
    const seen=new Set();
    for(const field of definition.fields){
      requireThat(SLUG.test(field.key)&&ENUMS.type.has(field.type)&&!seen.has(field.key),
        'invalid custom field');seen.add(field.key);
      if(field.type==='select')
        requireThat(Array.isArray(field.options)&&field.options.length>0,'custom select options missing');
      if(field.type==='reference')
        requireThat(typeof field.target==='string'&&SLUG.test(field.target),'invalid custom reference target');
    }
    schema.push(definition);
  }
  const records=new Map(),definitions=new Map(schema.map(d=>[d.slug,d]));
  for(const def of schema){
    const name='custom_'+def.slug,capture=captures.get(name);
    requireThat(capture,'custom table missing: '+name);
    const names=new Set(capture.table.columns.map(c=>c.name));
    for(const col of ['id','version','created_at','updated_at','archived_at','created_by',...def.fields.map(f=>f.key)])
      requireThat(names.has(col),'custom table column missing: '+name);
    const rows=capture.postgresRows;
    const ids=requireIds(rows,name);records.set(def.slug,ids);
    for(const row of rows){
      requireThat(safeInt(row.version)>=1,'invalid custom record version');
      requireThat(row.created_by===null||users.has(row.created_by),'custom row references unknown user');
      for(const field of def.fields){
        const v=row[field.key];
        if(v===null||v===undefined){
          requireThat(!field.required,'required custom field missing');
          continue;
        }
        if(field.type==='integer'||field.type==='boolean'){
          const n=safeInt(v);
          if(field.type==='boolean')requireThat(n===0||n===1,'invalid custom boolean');
        } else if(field.type==='number'){
          requireThat(Number.isFinite(Number(v)),'invalid custom numeric field');
        } else if(field.type==='select'){
          requireThat(field.options.includes(v),'invalid custom select value');
        } else if(field.type==='reference'){
          requireThat(typeof v==='string'&&UUID.test(v),'invalid custom reference ID');
        } else {
          requireThat(typeof v==='string','invalid custom text/date field');
        }
      }
    }
  }
  for(const def of schema)for(const field of def.fields){
    if(field.type!=='reference')continue;
    requireThat(definitions.has(field.target),'unknown target custom entity');
    const ids=records.get(field.target),rows=captures.get('custom_'+def.slug).postgresRows;
    for(const r of rows)if(r[field.key]!==null&&r[field.key]!==undefined)
      requireThat(ids.has(r[field.key]),'dangling custom entity reference');
  }
  return {entities:schema.length,records:[...schema].reduce((n,d)=>n+captures.get('custom_'+d.slug).postgresRows.length,0),
    relationsVerified:true,fieldTypesVerified:true};
}
export function assessR44CriticalParity(db,captures,{secret}={}){
  requireThat(db&&typeof db.prepare==='function','SQLite shadow handle required');
  requireThat(Buffer.isBuffer(secret)&&secret.length>=32,'external secret required');
  requireThat(Array.isArray(captures)&&captures.length>0&&captures.length<=60,'invalid signed capture');
  const byName=new Map();
  for(const c of captures){
    requireThat(c?.table?.name&&Array.isArray(c.table.columns)&&Array.isArray(c.table.primary)
      &&Array.isArray(c.postgresRows),'invalid critical table capture');
    requireThat(!byName.has(c.table.name),'duplicate capture');
    byName.set(c.table.name,c);
  }
  for(const name of ALWAYS)requireThat(byName.has(name),'required CRM table missing: '+name);
  const critical=[...byName].filter(([name])=>CRITICAL.has(name)||name.startsWith('custom_'))
    .sort(([a],[b])=>a.localeCompare(b));
  const summary=[];
  for(const [name,c] of critical){
    const sqlite=tableRows(db,c.table);
    requireThat(c.postgresRows.length<=10000,'PostgreSQL critical table too large');
    // PostgreSQL rows are fetched from a single REPEATABLE READ snapshot.
    const pgRows=[...c.postgresRows].sort((a,b)=>{
      const pa=JSON.stringify(c.table.primary.map(k=>a[k]));
      const pb=JSON.stringify(c.table.primary.map(k=>b[k]));
      return pa<pb?-1:pa>pb?1:0;
    });
    const sourceHash=digest(sqlite,c.table,secret),targetHash=digest(pgRows,c.table,secret);
    requireThat(sqlite.length===pgRows.length&&sourceHash===targetHash,
      'unsupported critical table drift: '+name);
    summary.push({table:name,rows:sqlite.length,parityVerified:true});
  }
  const rows=name=>byName.get(name).postgresRows;
  const clientIds=requireIds(rows('clients'),'clients');
  const userIds=requireIds(rows('users'),'users');
  const taskIds=requireIds(rows('tasks'),'tasks');
  const meta=rows('custom_entity_schema');
  const custom=inspectCustomEntities(meta,byName,userIds);
  const slugs=new Set(meta.map(x=>x.slug));
  const financial=inspectPayments(rows('payments'),clientIds,userIds,secret);
  const automations=inspectAutomations(rows('automations'),rows('automation_runs'),taskIds,userIds,slugs);
  return {format:'osmanx-r44-critical-parity-v1',syntheticOnly:true,
    paymentWritesPermitted:false,automationExecutionPermitted:false,
    primaryRuntime:'sqlite',criticalTables:summary,financial,automations,custom,
    ok:true,productionCutoverAllowed:false};
}
