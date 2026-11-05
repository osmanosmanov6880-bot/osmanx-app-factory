import { withTransaction } from '../common/db.mjs';
import { bad, json, ok, bodyJson } from '../common/http.mjs';
import { id, now, checkId, audit } from '../common/security.mjs';
import { normalizeEntity, sqlName, sqlColumn } from '../common/entities.mjs';
import { fireAutomations } from './automations.mjs';

const types={text:'TEXT',longtext:'TEXT',integer:'INTEGER',number:'REAL',boolean:'INTEGER',date:'TEXT',select:'TEXT',reference:'TEXT'};
const normalizedCache=new WeakMap();

// Idempotent, additive SQLite migration. Never DROP TABLE, DROP COLUMN or overwrite existing records.
export function syncEntitySchema(db,entities=[]){
  if(!Array.isArray(entities)||entities.length>12)bad(400,'Не более 12 пользовательских сущностей');
  const signature=JSON.stringify(entities);
  if(normalizedCache.get(db)?.signature===signature)return normalizedCache.get(db).entities;
  const validated=entities.map((e,i)=>normalizeEntity(e,null,entities.filter((_,j)=>i!==j)));
  if(new Set(validated.map(e=>e.slug)).size!==validated.length)bad(400,'Повторяющиеся коды сущностей');
  db.exec(`CREATE TABLE IF NOT EXISTS custom_entity_schema (
    slug TEXT PRIMARY KEY, definition_json TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  withTransaction(db,()=>{
    // Pass 1: create all base tables so foreign keys may reference any other entity.
    for(const ent of validated){
      db.exec(`CREATE TABLE IF NOT EXISTS ${sqlName(ent.slug)} (
        id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT,
        created_by TEXT REFERENCES users(id)
      )`);
    }
    // Pass 2: add typed columns and indexes. Existing types are immutable.
    for(const ent of validated){
      const existing=db.prepare('SELECT definition_json FROM custom_entity_schema WHERE slug=?').get(ent.slug);
      if(existing)normalizeEntity(ent,JSON.parse(existing.definition_json),validated);
      const known=new Set(db.prepare(`PRAGMA table_info(${sqlName(ent.slug)})`).all().map(c=>c.name));
      for(const field of ent.fields){
        if(!known.has(field.key)){
          const fk=field.type==='reference'?` REFERENCES ${sqlName(field.target)}(id) ON DELETE RESTRICT`:'';
          db.exec(`ALTER TABLE ${sqlName(ent.slug)} ADD COLUMN ${sqlColumn(field.key)} ${types[field.type]}${fk}`);
        }
        if(field.type==='reference'){
          db.exec(`CREATE INDEX IF NOT EXISTS "idx_ce_${ent.slug}_${field.key}" ON ${sqlName(ent.slug)} (${sqlColumn(field.key)})`);
        }
      }
      const statement=db.prepare(`INSERT INTO custom_entity_schema(slug,definition_json,updated_at) VALUES(?,?,?)
         ON CONFLICT(slug) DO UPDATE SET definition_json=excluded.definition_json,updated_at=excluded.updated_at`);
      statement.run(ent.slug,JSON.stringify(ent),now());
    }
  });
  normalizedCache.set(db,{signature,entities:validated});
  return validated;
}
function valueFor(db,ent,field,value,all){
  if(value===null||value===undefined||value===''){
    if(field.required)bad(400,`Обязательное поле «${field.label}»`);
    return null;
  }
  switch(field.type){
    case 'text': case 'longtext':{
      const max=field.type==='text'?240:4000;
      if(typeof value!=='string'||value.trim().length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))bad(400,`Некорректный текст в поле «${field.label}»`);
      if(field.required&&!value.trim())bad(400,`Заполните поле «${field.label}»`);
      return value.trim();
    }
    case 'integer':
      if(!Number.isSafeInteger(value)||Math.abs(value)>1000000000000)bad(400,`Поле «${field.label}»: требуется целое число`);
      return value;
    case 'number':
      if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e12)bad(400,`Поле «${field.label}»: требуется число`);
      return value;
    case 'boolean':
      if(typeof value!=='boolean')bad(400,`Поле «${field.label}»: true/false`);
      return Number(value);
    case 'date':{
      if(typeof value!=='string'||!/^(\d{4})-(\d{2})-(\d{2})$/.test(value)||Number.isNaN(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)bad(400,`Поле «${field.label}»: дата YYYY-MM-DD`);
      return value;
    }
    case 'select':
      if(typeof value!=='string'||!field.options.includes(value))bad(400,`Недопустимый вариант поля «${field.label}»`);
      return value;
    case 'reference':{
      checkId(value);
      const target=all.find(e=>e.slug===field.target);
      if(!target)bad(400,'Связанная сущность недоступна');
      if(!db.prepare(`SELECT id FROM ${sqlName(target.slug)} WHERE id=? AND archived_at IS NULL`).get(value))bad(400,`Связанная запись поля «${field.label}» отсутствует`);
      return value;
    }
  }
}
function parseValues(db,ent,values,all,old=null){
  if(!values||typeof values!=='object'||Array.isArray(values))bad(400,'Передайте объект values');
  const keys=new Set(ent.fields.map(f=>f.key));
  if(Object.keys(values).some(k=>!keys.has(k)))bad(400,'Неизвестное поле или попытка изменить служебные данные');
  const result={};
  for(const f of ent.fields){
    const v=Object.prototype.hasOwnProperty.call(values,f.key)?values[f.key]:(old?(f.type==='boolean'&&old[f.key]!==null?!!old[f.key]:old[f.key]):undefined);
    result[f.key]=valueFor(db,ent,f,v,all);
  }
  return result;
}
function publicRow(row,ent){
  const out={id:row.id,version:row.version,created_at:row.created_at,updated_at:row.updated_at};
  for(const field of ent.fields)out[field.key]=field.type==='boolean'&&row[field.key]!==null?!!row[field.key]:row[field.key];
  return out;
}
function entityAllowed(ent,user,scope){if(!ent.access[scope].includes(user.role))bad(403,`Нет прав на ${scope==='read'?'просмотр':'изменение'} данных`);}
function entityFor(config,slug){const e=(config.entities||[]).find(x=>x.slug===slug);if(!e)bad(404,'Сущность не найдена');return e;}
function getRow(db,ent,rowId){return db.prepare(`SELECT * FROM ${sqlName(ent.slug)} WHERE id=? AND archived_at IS NULL`).get(checkId(rowId));}
export async function handleEntityRequest(req,res,{path,query,db,config,user}){
  const entities=config.entities||[];
  if(path==='/api/entities' && req.method==='GET')return ok(res,{entities:entities.filter(e=>e.access.read.includes(user.role))});
  const match=path.match(/^\/api\/entities\/([a-z][a-z0-9_]{1,31})\/rows(?:\/([0-9a-f-]{36}))?$/);
  if(!match) return false;
  const ent=entityFor(config,match[1]); entityAllowed(ent,user,'read');
  syncEntitySchema(db,entities);
  const rowId=match[2],table=sqlName(ent.slug);
  if(!rowId&&req.method==='GET'){
    const limit=Math.min(100,Math.max(1,Number(query.get('limit'))||25));
    const offset=Math.min(100000,Math.max(0,Number(query.get('offset'))||0));
    const search=String(query.get('q')||'').trim().slice(0,80);
    const columns=ent.fields.filter(f=>['text','longtext','select'].includes(f.type)).map(f=>sqlColumn(f.key));
    const where=search&&columns.length?` AND (${columns.map(c=>`${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`:'';
    const term=search.replace(/[\\%_]/g,x=>'\\'+x);
    const params=where?Array(columns.length).fill(`%${term}%`):[];
    const total=db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE archived_at IS NULL${where}`).get(...params).n;
    const rows=db.prepare(`SELECT * FROM ${table} WHERE archived_at IS NULL${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params,Math.floor(limit),Math.floor(offset));
    return ok(res,{entity:ent,rows:rows.map(r=>publicRow(r,ent)),total,limit:Math.floor(limit),offset:Math.floor(offset)});
  }
  if(!rowId&&req.method==='POST'){
    entityAllowed(ent,user,'write');const payload=await bodyJson(req);
    const values=parseValues(db,ent,payload.values,entities);const cols=ent.fields.map(f=>f.key);
    const uid=id(),stamp=now();
    withTransaction(db,()=>{
      db.prepare(`INSERT INTO ${table} (id,version,created_at,updated_at,created_by,${cols.map(sqlColumn).join(',')}) VALUES (?,?,?,?,?,${cols.map(()=>'?').join(',')})`)
        .run(uid,1,stamp,stamp,user.id,...cols.map(k=>values[k]));
      audit(db,user.id,'create',`custom:${ent.slug}`,uid);
      if(config.modules.includes('tasks'))fireAutomations(db,{event:'entity_created',eventId:uid,userId:user.id,entitySlug:ent.slug,recordValues:values});
    });
    return json(res,{ok:true,row:publicRow(getRow(db,ent,uid),ent)},201);
  }
  if(rowId && req.method==='GET'){
    const row=getRow(db,ent,rowId);if(!row)bad(404,'Запись не найдена');return ok(res,{row:publicRow(row,ent)});
  }
  if(rowId && (req.method==='PATCH'||req.method==='DELETE')){
    entityAllowed(ent,user,'write');const payload=await bodyJson(req);
    if(!Number.isSafeInteger(payload.version)||payload.version<1)bad(400,'Укажите версию записи');
    const old=getRow(db,ent,rowId);if(!old)bad(404,'Запись не найдена');
    if(old.version!==payload.version)bad(409,'Запись изменена другим пользователем. Перезагрузите данные.');
    if(req.method==='DELETE'){
      withTransaction(db,()=>{
        const r=db.prepare(`UPDATE ${table} SET archived_at=?,updated_at=?,version=version+1 WHERE id=? AND version=? AND archived_at IS NULL`).run(now(),now(),rowId,payload.version);
        if(r.changes!==1)bad(409,'Запись уже изменена');
        audit(db,user.id,'archive',`custom:${ent.slug}`,rowId);
      });
      return ok(res,{archived:true,id:rowId});
    }
    const values=parseValues(db,ent,payload.values,entities,old);const cols=ent.fields.map(f=>f.key);
    withTransaction(db,()=>{
      const r=db.prepare(`UPDATE ${table} SET ${cols.map(k=>sqlColumn(k)+'=?').join(',')},updated_at=?,version=version+1 WHERE id=? AND version=? AND archived_at IS NULL`)
        .run(...cols.map(k=>values[k]),now(),rowId,payload.version);
      if(r.changes!==1)bad(409,'Запись уже изменена');
      audit(db,user.id,'update',`custom:${ent.slug}`,rowId);
    });
    return ok(res,{row:publicRow(getRow(db,ent,rowId),ent)});
  }
  bad(405,'Метод не поддерживается');
}
