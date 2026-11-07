// R5.3 opt-in SYNTHETIC SQLite change capture.
// AFTER triggers append within the same SQLite transaction as business writes.
// Rollback of a client/task/payment write also rolls back its change event.
// Does not capture sessions (force re-login), and rejects unsupported tables.
import {createHash} from 'node:crypto';
const VERSION='osmanx-r53-transaction-capture-v1';
const ID=/^[a-z][a-z0-9_]{0,63}$/;
const CORE=new Set(['users','clients','visits','tasks','payments','audit_log',
  'automations','automation_runs','custom_entity_schema']);
const EXCLUDED=new Set(['sessions','ox_r53_events','ox_r53_meta']);
const MAX_COLUMNS=48,MAX_TABLES=32,MAX_BATCH=250,MAX_EVENT=16000;
function deny(ok,reason){if(!ok)throw Error('R5.3 SQLite journal refused: '+reason);}
function qi(v){deny(typeof v==='string'&&ID.test(v),'unsafe SQLite identifier');return '"'+v+'"';}
function tables(db){
  const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(x=>x.name).filter(x=>!EXCLUDED.has(x));
  deny(names.length>=6&&names.length<=MAX_TABLES,'CRM table inventory outside capture scope');
  const result=[];
  for(const table of names){
    deny(ID.test(table)&&
      (CORE.has(table)||/^custom_[a-z][a-z0-9_]{1,31}$/.test(table)),
      'unknown durable business table must not be silently excluded: '+table);
    const columns=db.prepare('PRAGMA table_info('+qi(table)+')').all();
    deny(columns.length>0&&columns.length<=MAX_COLUMNS,
      'invalid or too wide table for JSON capture');
    const primary=columns.filter(x=>x.pk>0).sort((a,b)=>a.pk-b.pk);
    deny(primary.length===1&&primary[0].type.toUpperCase()==='TEXT'&&
      (primary[0].name==='id'||(table==='custom_entity_schema'&&primary[0].name==='slug')),
      'single TEXT primary key required');
    deny(columns.every(c=>ID.test(c.name)&&
      ['TEXT','INTEGER','REAL'].includes(c.type.toUpperCase())),
      'unsupported binary or noncanonical column type');
    result.push({table,key:primary[0].name,
      columns:columns.map(c=>({name:c.name,type:c.type.toUpperCase()}))});
  }
  return result;
}
export function inspectR53Schema(db){
  deny(db&&typeof db.prepare==='function','open SQLite connection required');
  const list=tables(db);
  const digest=createHash('sha256').update(JSON.stringify(list)).digest('hex');
  return {format:VERSION,digest,tables:list};
}
export function installR53Capture(db,{syntheticOnly=false}={}){
  deny(syntheticOnly===true,'installation permitted only on isolated synthetic SQLite');
  deny(db.isTransaction===false,'cannot install capture inside an active business transaction');
  const schema=inspectR53Schema(db);
  db.exec('BEGIN IMMEDIATE');
  try{
    db.exec("CREATE TABLE IF NOT EXISTS ox_r53_meta ("+
      "key TEXT PRIMARY KEY, value TEXT NOT NULL);"+
      "CREATE TABLE IF NOT EXISTS ox_r53_events ("+
      "seq INTEGER PRIMARY KEY AUTOINCREMENT,"+
      "table_name TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),"+
      "record_key TEXT NOT NULL, after_json TEXT,"+
      "committed_hint TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));");
    const hash=db.prepare("SELECT value FROM ox_r53_meta WHERE key='schema'").get()?.value;
    deny(!hash||hash===schema.digest,'schema changed after capture installation');
    if(!hash)db.prepare("INSERT INTO ox_r53_meta(key,value) VALUES('schema',?)")
      .run(schema.digest);
    for(const item of schema.tables){
      const table=qi(item.table),key=qi(item.key);
      const json=item.columns.flatMap(c=>["'"+c.name+"'",'NEW.'+qi(c.name)]).join(',');
      for(const [name,op,values] of [
        ['insert','upsert','NEW.'+key+',json_object('+json+')'],
        ['update','upsert','NEW.'+key+',json_object('+json+')'],
        ['delete','delete','OLD.'+key+',NULL']
      ]){
        const trigger=qi('ox_r53_'+item.table+'_'+name);
        db.exec('CREATE TRIGGER IF NOT EXISTS '+trigger+' AFTER '+name.toUpperCase()+
          ' ON '+table+' BEGIN '+
          'INSERT INTO ox_r53_events(table_name,operation,record_key,after_json)'+
          " VALUES ('"+item.table+"','"+op+"',"+values+'); END;');
      }
    }
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  return {format:VERSION,installed:true,schemaDigest:schema.digest,
    trackedTables:schema.tables.length,ephemeralSessionsExcluded:true,
    syntheticOnly:true,productionCutoverAllowed:false};
}
export function readR53Committed(db,{afterSequence=0,limit=MAX_BATCH,
  syntheticOnly=false}={}){
  deny(syntheticOnly===true,'change extraction must be a synthetic fixture');
  deny(Number.isSafeInteger(afterSequence)&&afterSequence>=0&&
    Number.isSafeInteger(limit)&&limit>=1&&limit<=MAX_BATCH,
    'invalid committed change cursor');
  const schema=inspectR53Schema(db);
  const stored=db.prepare("SELECT value FROM ox_r53_meta WHERE key='schema'").get();
  deny(stored?.value===schema.digest,'journal schema drift or missing installation');
  const items=new Map(schema.tables.map(t=>[t.table,t]));
  deny(db.isTransaction===false,'cannot read journal within another write transaction');
  db.exec('BEGIN IMMEDIATE');
  try{
    const rows=db.prepare('SELECT seq,table_name,operation,record_key,after_json '+
      'FROM ox_r53_events WHERE seq>? ORDER BY seq LIMIT ?')
      .all(afterSequence,limit+1);
    deny(rows.length<=limit,'journal capture limit exceeded: split into smaller batches');
    let expected=afterSequence+1,bytes=0;
    const events=rows.map(r=>{
      deny(r.seq===expected++&&items.has(r.table_name)&&
        ['upsert','delete'].includes(r.operation)&&
        typeof r.record_key==='string'&&r.record_key.length>0&&r.record_key.length<=256,
        'missing, reordered or invalid committed journal entry');
      const spec=items.get(r.table_name);
      let after=null;
      if(r.operation==='upsert'){
        try{after=JSON.parse(r.after_json);}catch{throw Error('R5.3 SQLite journal refused: malformed after image');}
        deny(after&&typeof after==='object'&&!Array.isArray(after)&&
          Object.keys(after).length===spec.columns.length&&
          spec.columns.every(c=>Object.hasOwn(after,c.name)&&
            (after[c.name]===null||['string','number'].includes(typeof after[c.name])))&&
          after[spec.key]===r.record_key,'noncanonical captured row');
      }else deny(r.after_json===null,'delete must not have an after image');
      const event={seq:r.seq,table:r.table_name,operation:r.operation,
        recordKey:r.record_key,after};
      bytes+=Buffer.byteLength(JSON.stringify(event));
      deny(bytes<=1024*1024&&bytes<=rows.length*MAX_EVENT,
        'encrypted batch payload too large');
      return event;
    });
    db.exec('COMMIT');
    return {format:VERSION,from:afterSequence+1,
      through:expected-1,events,schemaDigest:schema.digest,
      trackedTables:schema.tables.length,
      syntheticOnly:true,productionCutoverAllowed:false};
  }catch(e){db.exec('ROLLBACK');throw e;}
}
