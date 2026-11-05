import { id,now,shortText,enumValue,checkId,audit } from '../common/security.mjs';
import { bad,ok,json,bodyJson } from '../common/http.mjs';

const events=['client_created','visit_created','entity_created'];
const priorities=['low','medium','high'];
const MAX_RULES=60;
const actionLabel='create_task';
export function initializeAutomations(db){
  db.exec(`CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, event TEXT NOT NULL CHECK(event IN ('client_created','visit_created','entity_created')),
    task_title TEXT NOT NULL, priority TEXT NOT NULL CHECK(priority IN ('low','medium','high')),
    enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL,
    entity_slug TEXT, condition_field TEXT, condition_value TEXT, due_days INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    event_key TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), created_at TEXT NOT NULL,
    UNIQUE(automation_id,event_key)
  );`);
  // Older R0.9 tables have a restrictive SQLite CHECK(event) constraint.
  // Rebuild the rule definition table offline without touching tasks or existing runs.
  const oldSql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='automations'").get()?.sql||'';
  if(oldSql && !oldSql.includes("'entity_created'")){
    db.exec(`PRAGMA foreign_keys=OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE automations_next (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, event TEXT NOT NULL CHECK(event IN ('client_created','visit_created','entity_created')),
        task_title TEXT NOT NULL, priority TEXT NOT NULL CHECK(priority IN ('low','medium','high')),
        enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT REFERENCES users(id), created_at TEXT NOT NULL,
        entity_slug TEXT, condition_field TEXT, condition_value TEXT, due_days INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO automations_next (id,name,event,task_title,priority,enabled,created_by,created_at)
        SELECT id,name,event,task_title,priority,enabled,created_by,created_at FROM automations;
      DROP TABLE automations;
      ALTER TABLE automations_next RENAME TO automations;
      COMMIT;
      PRAGMA foreign_keys=ON;`);
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Automation migration foreign-key verification failed');
  }
  // Add-only column migration for installations that already support extended events.
  const found=new Set(db.prepare('PRAGMA table_info(automations)').all().map(r=>r.name));
  for(const [field,sql] of [
    ['entity_slug','TEXT'],['condition_field','TEXT'],['condition_value','TEXT'],['due_days','INTEGER NOT NULL DEFAULT 0']
  ])if(!found.has(field))db.exec(`ALTER TABLE automations ADD COLUMN ${field} ${sql}`);
}
function fields(input,entities=[]){
  const name=shortText(input.name,'Название правила',100);
  const event=enumValue(input.event,events,'Событие');
  const task_title=shortText(input.task_title,'Название задачи',180);
  const priority=enumValue(input.priority||'medium',priorities,'Приоритет');
  const due_days=input.due_days===undefined?0:input.due_days;
  if(!Number.isInteger(due_days)||due_days<0||due_days>365)bad(400,'Срок задачи: 0–365 дней');
  let entity_slug=null,condition_field=null,condition_value=null;
  if(event==='entity_created'){
    const ent=entities.find(e=>e.slug===input.entity_slug);
    if(!ent)bad(400,'Выберите существующую таблицу данных');
    entity_slug=ent.slug;
    if(input.condition_field){
      const field=ent.fields.find(f=>f.key===input.condition_field);
      if(!field||!['text','select','boolean','integer'].includes(field.type))bad(400,'Недопустимое поле условия');
      condition_field=field.key;
      condition_value=shortText(String(input.condition_value??''),'Значение условия',120,false);
      if(!condition_value)bad(400,'Введите значение условия');
      if(field.type==='select'&&!field.options.includes(condition_value))bad(400,'Значение не входит в список');
      if(field.type==='boolean'&&!['true','false'].includes(condition_value))bad(400,'Логическое значение должно быть true или false');
      if(field.type==='integer'&&(!/^-?\d+$/.test(condition_value)||!Number.isSafeInteger(Number(condition_value))))bad(400,'Укажите целое число');
    }
  } else if(input.entity_slug||input.condition_field||input.condition_value){
    bad(400,'Фильтры таблиц доступны только для событий таблицы');
  }
  return {name,event,task_title,priority,entity_slug,condition_field,condition_value,due_days};
}
// The factory stores declarative presets, never operational rules, event logs or customer records.
export function normalizeAutomationPreset(input,entities=[],modules=['auth','clients','tasks']){
  if(!modules.includes('tasks'))bad(400,'Для сценария подключите модуль задач');
  const rule=fields(input,entities);
  if(['client_created','visit_created'].includes(rule.event)&&!modules.includes('clients'))bad(400,'Для события подключите модуль клиентов');
  if(input.enabled!==undefined&&typeof input.enabled!=='boolean')bad(400,'enabled должно быть true или false');
  return {...rule,enabled:input.enabled===undefined?true:input.enabled};
}
export function simulatePreset(rule,{event,entitySlug=null,recordValues={}}={}){
  if(!recordValues||typeof recordValues!=='object'||Array.isArray(recordValues))bad(400,'Поля примера должны быть объектом');
  if(Object.keys(recordValues).length>30)bad(400,'Слишком много полей примера');
  const matchesEvent=event===rule.event;
  const matchesEntity=rule.event!=='entity_created'||entitySlug===rule.entity_slug;
  const observed=recordValues[rule.condition_field];
  const v=(typeof observed==='number'&&['true','false'].includes(rule.condition_value))?String(Boolean(observed)):String(observed??'');
  const matchesCondition=!rule.condition_field||v===rule.condition_value;
  const wouldRun=rule.enabled&&matchesEvent&&matchesEntity&&matchesCondition;
  return {wouldRun,reason:!rule.enabled?'Правило отключено':!matchesEvent?'Другое событие':!matchesEntity?'Другая таблица':!matchesCondition?'Условие не совпало':'Условие выполнено',
    taskTitle:wouldRun?(taskTitle(rule.task_title,recordValues).trim()||rule.name):null,priority:rule.priority,dueDays:rule.due_days};
}
function taskTitle(template,values={}){
  // Only current validated record fields can be interpolated. No JS or expression evaluation.
  return template.replace(/\{\{([a-z][a-z0-9_]{1,31})\}\}/g,(_,key)=>
    Object.hasOwn(values,key)?String(values[key]??'').slice(0,80):'').slice(0,180);
}
export function fireAutomations(db,{event,eventId,clientId=null,userId,entitySlug=null,recordValues={}}){
  // Called inside the same transaction that writes the originating record.
  const rules=db.prepare('SELECT * FROM automations WHERE event=? AND enabled=1 ORDER BY created_at,id').all(event);
  for(const rule of rules){
    if(rule.event==='entity_created'&&rule.entity_slug!==entitySlug)continue;
    if(rule.condition_field){
      const observed=recordValues[rule.condition_field];
      const value=(typeof observed==='number' && ['true','false'].includes(rule.condition_value))?String(Boolean(observed)):String(observed??'');
      if(value!==rule.condition_value)continue;
    }
    if(db.prepare('SELECT 1 FROM automation_runs WHERE automation_id=? AND event_key=?').get(rule.id,eventId))continue;
    const taskId=id(),stamp=now();
    const title=taskTitle(rule.task_title,recordValues).trim()||rule.name;
    const due=rule.due_days?new Date(Date.now()+rule.due_days*86400000).toISOString():null;
    db.prepare(`INSERT INTO tasks(id,title,description,status,priority,due_at,client_id,assigned_to,created_by,created_at,updated_at)
      VALUES(?,?,?,'todo',?,?,?,NULL,?,?,?)`).run(taskId,title,`Автоматизация: ${rule.name}${entitySlug?' · '+entitySlug:''}`,rule.priority,due,clientId,userId,stamp,stamp);
    db.prepare('INSERT INTO automation_runs(id,automation_id,event_key,task_id,created_at) VALUES(?,?,?,?,?)')
      .run(id(),rule.id,eventId,taskId,stamp);
    audit(db,userId,'automation_task','tasks',taskId,{automation:rule.id,event,entitySlug});
  }
}
export async function automationRoutes(req,res,{db,path,user,hasTasks,entities=[]}){
  if(!path.startsWith('/api/automations'))return false;
  if(!hasTasks)bad(404,'Для автоматизаций требуется модуль задач');
  if(!['admin','manager'].includes(user.role))bad(403,'Нет доступа к автоматизациям');
  if(path==='/api/automations' && req.method==='GET'){
    const rules=db.prepare('SELECT * FROM automations ORDER BY created_at DESC,id DESC').all();
    return ok(res,{automations:rules,capabilities:{events,action:actionLabel,entities:entities.map(e=>({slug:e.slug,title:e.title,fields:e.fields.filter(f=>['select','text','boolean','integer'].includes(f.type))}))}});
  }
  if(path==='/api/automations' && req.method==='POST'){
    const b=fields(await bodyJson(req),entities);
    if(db.prepare('SELECT COUNT(*) n FROM automations').get().n>=MAX_RULES)bad(409,`Максимум ${MAX_RULES} правил`);
    const ruleId=id();
    db.prepare(`INSERT INTO automations(id,name,event,task_title,priority,enabled,created_by,created_at,entity_slug,condition_field,condition_value,due_days)
      VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`)
      .run(ruleId,b.name,b.event,b.task_title,b.priority,user.id,now(),b.entity_slug,b.condition_field,b.condition_value,b.due_days);
    audit(db,user.id,'automation_create','automations',ruleId,{event:b.event,entity:b.entity_slug});
    return json(res,{ok:true,automation:db.prepare('SELECT * FROM automations WHERE id=?').get(ruleId)},201);
  }
  if(path==='/api/automations/runs' && req.method==='GET'){
    const runs=db.prepare('SELECT r.*,a.name automation_name FROM automation_runs r JOIN automations a ON a.id=r.automation_id ORDER BY r.created_at DESC LIMIT 100').all();
    return ok(res,{runs});
  }
  const match=path.match(/^\/api\/automations\/([0-9a-f-]{36})$/);
  if(match){
    const ruleId=checkId(match[1]);
    const current=db.prepare('SELECT * FROM automations WHERE id=?').get(ruleId);
    if(!current)bad(404,'Правило не найдено');
    if(req.method==='PATCH'){
      const input=await bodyJson(req);
      if(typeof input.enabled!=='boolean')bad(400,'Укажите enabled: true или false');
      db.prepare('UPDATE automations SET enabled=? WHERE id=?').run(Number(input.enabled),ruleId);
      audit(db,user.id,'automation_toggle','automations',ruleId,{enabled:input.enabled});
      return ok(res,{automation:db.prepare('SELECT * FROM automations WHERE id=?').get(ruleId)});
    }
    if(req.method==='DELETE'){
      // Audit entries remain after deleting a rule, but detailed run rows are removed.
      db.prepare('DELETE FROM automations WHERE id=?').run(ruleId);
      audit(db,user.id,'automation_delete','automations',ruleId);
      return ok(res,{deleted:true});
    }
  }
  bad(405,'Недопустимое действие автоматизации');
}
