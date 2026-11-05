import { bad } from './http.mjs';

// A declarative, non-executable schema. Identifiers are validated before any SQL is generated.
export const ENTITY_TYPES = ['text','longtext','integer','number','boolean','date','select','reference'];
export const ENTITY_ROLES = ['admin','manager','staff'];
const RESERVED = new Set(['id','version','created_at','updated_at','archived_at','created_by']);
const SLUG = /^[a-z][a-z0-9_]{1,31}$/;
const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function string(v,label,max,required=true){
  if (typeof v !== 'string' || (required && !v.trim()) || v.trim().length > max || /[\u0000-\u001f]/.test(v)) bad(400,`Некорректное поле «${label}» (не более ${max} символов)`);
  return v.trim();
}
export function safeKey(v,label='Идентификатор'){
  if(typeof v !== 'string' || !SLUG.test(v) || RESERVED.has(v)) bad(400,`${label}: латинские строчные буквы, цифры и _ (2–32 символа), без служебных имён`);
  return v;
}
function roles(v,label){
  if(!Array.isArray(v)||v.length<1||v.length>3||new Set(v).size!==v.length||v.some(r=>!ENTITY_ROLES.includes(r))||!v.includes('admin')) bad(400,`Недопустимые роли: ${label}`);
  return ENTITY_ROLES.filter(r=>v.includes(r));
}
export function normalizeEntity(input, previous=null, others=[]){
  if(!isRecord(input))bad(400,'Ожидается описание сущности');
  const slug=safeKey(input.slug,'Код сущности');
  if(previous && slug!==previous.slug)bad(409,'Код существующей сущности изменять нельзя');
  if(!previous && others.some(e=>e.slug===slug))bad(409,'Сущность с таким кодом уже существует');
  const title=string(input.title,'Название сущности',64);
  const description=string(input.description??'','Описание',240,false);
  const r=roles(input.access?.read??['admin','manager','staff'],'чтение');
  const w=roles(input.access?.write??['admin','manager'],'запись');
  if(w.some(v=>!r.includes(v)))bad(400,'Права записи должны входить в права чтения');
  if(!Array.isArray(input.fields)||input.fields.length<1||input.fields.length>24)bad(400,'Добавьте от 1 до 24 полей');
  const fieldKeys=new Set();
  const fields=input.fields.map(field=>{
    if(!isRecord(field))bad(400,'Некорректное описание поля');
    const key=safeKey(field.key,'Код поля');
    if(fieldKeys.has(key))bad(400,'Коды полей не должны повторяться');fieldKeys.add(key);
    const label=string(field.label,`Название поля ${key}`,64);
    if(!ENTITY_TYPES.includes(field.type))bad(400,`Недопустимый тип поля ${key}`);
    if(typeof field.required!=='boolean')bad(400,`Обязательность поля ${key} должна быть true или false`);
    const f={key,label,type:field.type,required:field.required};
    if(f.type==='select'){
      if(!Array.isArray(field.options)||field.options.length<1||field.options.length>30)bad(400,`Для списка ${key} нужно от 1 до 30 значений`);
      f.options=field.options.map(x=>string(x,`Вариант списка ${key}`,48));
      if(new Set(f.options).size!==f.options.length)bad(400,`Повторяющиеся варианты списка ${key}`);
    }
    if(f.type==='reference'){
      f.target=safeKey(field.target,'Целевая сущность');
      if(!others.some(e=>e.slug===f.target) && f.target!==slug)bad(400,`Связанная сущность «${f.target}» не существует`);
    }
    return f;
  });
  if(previous){
    const before=new Map(previous.fields.map(f=>[f.key,f]));
    for(const old of previous.fields){
      const next=fields.find(f=>f.key===old.key);
      if(!next)bad(409,`Нельзя удалить поле «${old.key}»: данные должны сохраниться`);
      if(next.type!==old.type||next.required!==old.required||next.target!==old.target)bad(409,`Тип, обязательность и связь поля «${old.key}» менять нельзя`);
      if(next.type==='select' && (old.options.length>next.options.length || old.options.some((v,i)=>v!==next.options[i])))bad(409,`Варианты списка «${old.key}» можно только дополнять`);
    }
    for(const field of fields)if(!before.has(field.key) && field.required)bad(409,'Новое поле существующей таблицы должно быть необязательным (чтобы не ломать старые записи)');
  }
  return {slug,title,description,access:{read:r,write:w},fields};
}
export function entityFromRow(row){
  return row&&{id:row.id,revision:row.revision,...JSON.parse(row.definition_json),createdAt:row.created_at,updatedAt:row.updated_at};
}
export function listEntities(db,projectId){
  return db.prepare('SELECT * FROM project_entities WHERE project_id=? ORDER BY created_at ASC').all(projectId).map(entityFromRow);
}
export function sqlName(slug){return `"custom_${safeKey(slug)}"`;}
export function sqlColumn(key){return `"${safeKey(key)}"`;}
