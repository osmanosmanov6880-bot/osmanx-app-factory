import { createHash } from 'node:crypto';
import { bodyJson,bad,json,ok,routePath,staticFile,protectOrigin } from '../common/http.mjs';
import { id,now,hashPassword,verifyPassword,issueSession,revokeSession,sessionFromRequest,requireUser,
  checkLoginThrottle,cookie,shortText,validateEmail,enumValue,checkId,nullableId,optionalIso,audit,requireSetupToken } from '../common/security.mjs';
import { readAnalytics } from './analytics.mjs';
import { withTransaction } from '../common/db.mjs';
import { fireAutomations,automationRoutes } from './automations.mjs';
import { handleEntityRequest } from './entities.mjs';
import { planClientImport,clientsToCsv } from './client_csv.mjs';

const sourceValues=['unknown','walkin','social','referral','website','other'];
const taskStatus=['todo','doing','done','cancelled'];
const paymentMethods=['cash','bank_transfer','terminal','other'];
const currencies=['RUB','EUR','USD'];
const privilegedRoles=['admin','manager'];

function clientFields(data,existing={}) {
  const name=shortText(data.full_name??existing.full_name,'Имя клиента',120);
  const phone=shortText(data.phone??existing.phone??'','Телефон',35,false);
  const email=(data.email??existing.email??'') ? validateEmail(data.email??existing.email) : '';
  const source=enumValue(data.source??existing.source??'unknown',sourceValues,'источник');
  const notes=shortText(data.notes??existing.notes??'','Примечание',1500,false);
  return {full_name:name,phone,email,source,notes};
}
function taskFields(data,existing={}) {
  const title=shortText(data.title??existing.title,'Название задачи',180);
  const description=shortText(data.description??existing.description??'','Описание',1500,false);
  const priority=enumValue(data.priority??existing.priority??'medium',['low','medium','high'],'приоритет');
  const status=enumValue(data.status??existing.status??'todo',taskStatus,'статус');
  const due_at=optionalIso(data.due_at===undefined ? existing.due_at : data.due_at,'срок');
  const client_id=nullableId(data.client_id===undefined?existing.client_id:data.client_id);
  const assigned_to=nullableId(data.assigned_to===undefined?existing.assigned_to:data.assigned_to);
  return {title,description,priority,status,due_at,client_id,assigned_to};
}
function mustExist(db,table,key) {
  const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(checkId(key));
  if (!row) bad(404,'Запись не найдена');
  return row;
}
function checkRelated(db,fields) {
  if(fields.client_id) {
    const c=mustExist(db,'clients',fields.client_id);
    if(c.archived_at) bad(409,'Клиент в архиве');
  }
  if(fields.assigned_to) {
    const u=mustExist(db,'users',fields.assigned_to);
    if(!u.active) bad(409,'Сотрудник неактивен');
  }
}
function publicUser(u){return {id:u.id,email:u.email,name:u.name,role:u.role};}
function sessionJson(req,res,db,cookieName){
  const user=sessionFromRequest(req,db,cookieName);
  ok(res,{initialized:!!db.prepare('SELECT id FROM users LIMIT 1').get(),authenticated:!!user,user:user?publicUser(user):null,csrf:user?.csrf||null});
}
export async function handleCrmRequest(req,res,{db,config,base='',staticRoot,cookieName='ox_crm',deploymentIdentity=null}) {
  const {path,query}=routePath(req,base);
  if(path==='/' || path==='/index.html') return staticFile(res,`${staticRoot}/index.html`,'.html');
  if(path==='/assets/app.css') return staticFile(res,`${staticRoot}/app.css`,'.css');
  if(path==='/assets/app.js') return staticFile(res,`${staticRoot}/app.js`,'.js');
  if(path==='/assets/pages.js') return staticFile(res,`${staticRoot}/pages.js`,'.js');
  if(path==='/assets/entities.js') return staticFile(res,`${staticRoot}/entities.js`,'.js');
  if(!path.startsWith('/api/')) bad(404,'Маршрут не найден');
  if(!['GET','HEAD'].includes(req.method)) protectOrigin(req);
  const has=m=>config.modules.includes(m);
  const requireModule=m=>{if(!has(m)) bad(404,'Модуль не подключён');};
  const requireRole=(roles=null)=>requireUser(req,db,cookieName,roles);
  if(path==='/api/health' && req.method==='GET') return ok(res,{service:'osmanx-business-crm',version:'1.3.0',status:'ready',paymentMode:'manual_ledger_only',...(deploymentIdentity?{deployment:deploymentIdentity}:{})});
  if(path==='/api/config' && req.method==='GET') return ok(res,{config:{
    id:config.id,name:config.name,type:config.type,industry:config.industry,
    modules:config.modules,settings:config.settings,entityCount:(config.entities||[]).length,paymentMode:'manual_ledger_only',base,requiresSetupToken:!base&&!!process.env.SETUP_TOKEN
  }});
  if(path==='/api/session' && req.method==='GET') return sessionJson(req,res,db,cookieName);
  if(path==='/api/setup' && req.method==='POST') {
    const data=await bodyJson(req);
    if(db.prepare('SELECT id FROM users LIMIT 1').get()) bad(409,'Первичная настройка уже завершена');
    if(!base) requireSetupToken(data.setup_token);
    const email=validateEmail(data.email),name=shortText(data.name,'Имя',80),pass=hashPassword(data.password),uid=id();
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)').run(uid,email,name,pass,'admin',now());
    audit(db,uid,'bootstrap','users',uid);
    const s=issueSession(db,uid);
    return json(res,{ok:true,user:{id:uid,name,email,role:'admin'},csrf:s.csrf},201,{'Set-Cookie':cookie(s.token,cookieName,base+'/')});
  }
  if(path==='/api/login' && req.method==='POST') {
    checkLoginThrottle(req,'crm-'+config.id);
    const data=await bodyJson(req);
    const email=validateEmail(data.email);
    const row=db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
    if(!row || !verifyPassword(String(data.password||''),row.password_hash)) bad(401,'Неверная почта или пароль');
    const s=issueSession(db,row.id);
    return json(res,{ok:true,user:publicUser(row),csrf:s.csrf},200,{'Set-Cookie':cookie(s.token,cookieName,base+'/')});
  }
  if(path==='/api/logout' && req.method==='POST') {
    const user=requireRole();revokeSession(db,user);
    return json(res,{ok:true},200,{'Set-Cookie':cookie('',cookieName,base+'/',0)});
  }
  const user=requireRole();
  if(path.startsWith('/api/automations')) return await automationRoutes(req,res,{db,path,user,hasTasks:has('tasks'),entities:config.entities||[]});
  if(path.startsWith('/api/entities')) {
    const handled=await handleEntityRequest(req,res,{path,query,db,config,user});
    if(handled!==false)return;
  }
  if(path==='/api/pages' && req.method==='GET') {
    return ok(res,{pages:(config.pages||[]).filter(page=>page.published)});
  }
  if(path==='/api/page-metrics' && req.method==='GET') {
    const metrics={};
    const count=sql=>db.prepare(sql).get().n;
    if(has('clients')) {
      metrics.clients_total=count('SELECT COUNT(*) n FROM clients WHERE archived_at IS NULL');
      metrics.visits_total=count('SELECT COUNT(*) n FROM visits');
    }
    if(has('tasks'))metrics.open_tasks=count("SELECT COUNT(*) n FROM tasks WHERE status IN ('todo','doing')");
    if(privilegedRoles.includes(user.role) && has('analytics') && has('clients')){
      const visited=count('SELECT COUNT(DISTINCT client_id) n FROM visits');
      const repeats=count('SELECT COUNT(*) n FROM (SELECT client_id FROM visits GROUP BY client_id HAVING COUNT(*) >= 2)');
      metrics.repeat_share=visited?Math.round(repeats/visited*1000)/10:0;
    }
    if(privilegedRoles.includes(user.role) && has('payments')){
      metrics.paid_minor=db.prepare("SELECT COALESCE(SUM(amount_minor),0) n FROM payments WHERE status='paid' AND currency=?").get(config.settings.currency).n;
    }
    return ok(res,{metrics,currency:config.settings.currency,notes:{paid_minor:'Учётный журнал, не банковская выручка',repeat_share:'Доля гостей с двумя и более визитами среди посетивших'}});
  }
  // R1.1: CSV onboarding. Imports are admin/manager-only, atomic and intentionally
  // do NOT emit new-client automation events (avoids mass unintended tasks).
  if(path==='/api/clients/export' && req.method==='GET'){
    requireModule('clients');requireRole(['admin','manager']);
    const rows=db.prepare(`SELECT full_name,phone,email,source,notes FROM clients WHERE archived_at IS NULL ORDER BY created_at,id LIMIT 5000`).all();
    const csv=clientsToCsv(rows);
    res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="osmanx-clients.csv"','Cache-Control':'no-store','Content-Length':Buffer.byteLength(csv)});
    return res.end(csv);
  }
  if((path==='/api/clients/import-preview'||path==='/api/clients/import')&&req.method==='POST'){
    requireModule('clients');requireRole(['admin','manager']);
    const input=await bodyJson(req);const plan=planClientImport(db,input.csv,clientFields);
    if(path.endsWith('import-preview'))return ok(res,{summary:{total:plan.total,ready:plan.ready,duplicates:plan.duplicates,invalid:plan.invalid},examples:plan.examples,errors:plan.errors,note:'Предпросмотр не изменяет базу. Импорт не запускает автоматизации.'});
    if(input.confirm!==true)bad(400,'Подтвердите импорт');
    if(plan.invalid)bad(400,'Исправьте ошибки в CSV перед импортом');
    withTransaction(db,()=>{
      const insert=db.prepare('INSERT INTO clients(id,full_name,phone,email,source,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)');
      for(const client of plan.records){const cid=id(),stamp=now();insert.run(cid,client.full_name,client.phone,client.email,client.source,client.notes,stamp,stamp);}
      audit(db,user.id,'clients_csv_import','clients',null,{created:plan.ready,duplicates:plan.duplicates});
    });
    return json(res,{ok:true,created:plan.ready,duplicates:plan.duplicates,total:plan.total},201);
  }
  if(path==='/api/clients' && req.method==='GET') {
    requireModule('clients');
    const q=String(query.get('q')||'').trim().slice(0,100);
    const rows=db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM visits v WHERE v.client_id=c.id) visit_count,
      (SELECT MAX(occurred_at) FROM visits v WHERE v.client_id=c.id) last_visit_at
      FROM clients c WHERE c.archived_at IS NULL AND (c.full_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)
      ORDER BY c.created_at DESC LIMIT 200`).all(...Array(3).fill(`%${q}%`));
    return ok(res,{clients:rows,limit:200});
  }
  if(path==='/api/clients' && req.method==='POST') {
    requireModule('clients');const b=clientFields(await bodyJson(req));const cid=id(),date=now();
    withTransaction(db,()=>{
      db.prepare(`INSERT INTO clients(id,full_name,phone,email,source,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(cid,b.full_name,b.phone,b.email,b.source,b.notes,date,date);
      audit(db,user.id,'create','clients',cid);
      if(has('tasks'))fireAutomations(db,{event:'client_created',eventId:cid,clientId:cid,userId:user.id});
    });
    return json(res,{ok:true,client:mustExist(db,'clients',cid)},201);
  }
  const clientMatch=path.match(/^\/api\/clients\/([0-9a-f-]{36})$/);
  if(clientMatch && ['PATCH','DELETE'].includes(req.method)) {
    requireModule('clients');const old=mustExist(db,'clients',clientMatch[1]);
    if(req.method==='DELETE') {
      db.prepare('UPDATE clients SET archived_at=?,updated_at=? WHERE id=?').run(now(),now(),old.id);
      audit(db,user.id,'archive','clients',old.id);return ok(res,{archived:true});
    }
    if(old.archived_at) bad(409,'Клиент в архиве');
    const b=clientFields(await bodyJson(req),old);
    db.prepare('UPDATE clients SET full_name=?,phone=?,email=?,source=?,notes=?,updated_at=? WHERE id=?')
      .run(b.full_name,b.phone,b.email,b.source,b.notes,now(),old.id);
    audit(db,user.id,'update','clients',old.id);
    return ok(res,{client:mustExist(db,'clients',old.id)});
  }
  if(path==='/api/visits' && req.method==='GET') {
    requireModule('clients');let rows;
    const clientId=query.get('clientId');
    if(clientId) rows=db.prepare('SELECT * FROM visits WHERE client_id=? ORDER BY occurred_at DESC LIMIT 200').all(checkId(clientId));
    else rows=db.prepare('SELECT v.*,c.full_name client_name FROM visits v JOIN clients c ON c.id=v.client_id ORDER BY v.occurred_at DESC LIMIT 100').all();
    return ok(res,{visits:rows});
  }
  if(path==='/api/visits' && req.method==='POST') {
    requireModule('clients');const data=await bodyJson(req);
    const client=mustExist(db,'clients',checkId(data.client_id));
    if(client.archived_at) bad(409,'Клиент в архиве');
    const occurred_at=optionalIso(data.occurred_at||now(),'время визита');
    const note=shortText(data.note??'','Примечание',600,false),vid=id();
    withTransaction(db,()=>{
      db.prepare('INSERT INTO visits(id,client_id,occurred_at,note,created_by,created_at) VALUES(?,?,?,?,?,?)')
        .run(vid,client.id,occurred_at,note,user.id,now());
      audit(db,user.id,'create','visits',vid,{client_id:client.id});
      if(has('tasks'))fireAutomations(db,{event:'visit_created',eventId:vid,clientId:client.id,userId:user.id});
    });
    return json(res,{ok:true,visit:mustExist(db,'visits',vid)},201);
  }
  if(path==='/api/tasks' && req.method==='GET') {
    requireModule('tasks');
    const status=query.get('status');
    let rows;
    const sql=`SELECT t.*,c.full_name client_name,u.name assignee_name FROM tasks t
      LEFT JOIN clients c ON c.id=t.client_id LEFT JOIN users u ON u.id=t.assigned_to`;
    if(status) rows=db.prepare(sql+' WHERE t.status=? ORDER BY t.created_at DESC LIMIT 200').all(enumValue(status,taskStatus,'статус'));
    else rows=db.prepare(sql+' ORDER BY t.created_at DESC LIMIT 200').all();
    return ok(res,{tasks:rows});
  }
  if(path==='/api/tasks' && req.method==='POST') {
    requireModule('tasks');const b=taskFields(await bodyJson(req));checkRelated(db,b);
    const tid=id(),stamp=now();
    db.prepare(`INSERT INTO tasks(id,title,description,status,priority,due_at,client_id,assigned_to,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(tid,b.title,b.description,b.status,b.priority,b.due_at,b.client_id,b.assigned_to,user.id,stamp,stamp);
    audit(db,user.id,'create','tasks',tid);
    return json(res,{ok:true,task:mustExist(db,'tasks',tid)},201);
  }
  const taskMatch=path.match(/^\/api\/tasks\/([0-9a-f-]{36})$/);
  if(taskMatch && req.method==='PATCH') {
    requireModule('tasks');const old=mustExist(db,'tasks',taskMatch[1]);
    const b=taskFields(await bodyJson(req),old);checkRelated(db,b);
    db.prepare(`UPDATE tasks SET title=?,description=?,status=?,priority=?,due_at=?,client_id=?,assigned_to=?,updated_at=? WHERE id=?`)
      .run(b.title,b.description,b.status,b.priority,b.due_at,b.client_id,b.assigned_to,now(),old.id);
    audit(db,user.id,'update','tasks',old.id,{status:b.status});
    return ok(res,{task:mustExist(db,'tasks',old.id)});
  }
  if(path==='/api/payments' && req.method==='GET') {
    requireModule('payments');requireRole(['admin','manager']);
    const rows=db.prepare(`SELECT p.*,c.full_name client_name FROM payments p LEFT JOIN clients c ON c.id=p.client_id
      ORDER BY p.created_at DESC LIMIT 200`).all();
    return ok(res,{payments:rows,paymentMode:'manual_ledger_only'});
  }
  if(path==='/api/payments' && req.method==='POST') {
    requireModule('payments');requireRole(['admin','manager']);const data=await bodyJson(req);
    const amount=data.amount_minor;
    if(!Number.isSafeInteger(amount) || amount<=0 || amount>999999999999) bad(400,'Сумма должна быть положительным целым числом в копейках/центах');
    const currency=enumValue(data.currency||config.settings.currency,currencies,'валюта');
    const method=enumValue(data.method,paymentMethods,'метод');
    const status=enumValue(data.status||'pending',['pending','paid'],'статус');
    const client_id=nullableId(data.client_id);
    if(client_id) mustExist(db,'clients',client_id);
    const external_reference=shortText(data.external_reference??'','Номер операции',120,false);
    const note=shortText(data.note??'','Комментарий',600,false);
    const fingerprint=createHash('sha256').update(JSON.stringify({client_id,amount,currency,method,status,external_reference,note})).digest('hex');
    const key=req.headers['idempotency-key'];
    if(key && (typeof key!=='string'||key.length>120||!/^[a-zA-Z0-9_-]+$/.test(key))) bad(400,'Некорректный Idempotency-Key');
    if(key) {
      const prev=db.prepare('SELECT * FROM payments WHERE idem_key=?').get(key);
      if(prev) {
        if(prev.request_fingerprint!==fingerprint) bad(409,'Этот ключ идемпотентности уже использован для другой операции');
        return ok(res,{payment:prev,replayed:true});
      }
    }
    const pid=id(),stamp=now();
    db.prepare(`INSERT INTO payments(id,client_id,amount_minor,currency,method,status,external_reference,note,idem_key,request_fingerprint,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(pid,client_id,amount,currency,method,status,external_reference,note,key||null,fingerprint,user.id,stamp,stamp);
    audit(db,user.id,'create','payments',pid,{status,amount_minor:amount,currency});
    return json(res,{ok:true,payment:mustExist(db,'payments',pid),paymentMode:'manual_ledger_only'},201);
  }
  const payMatch=path.match(/^\/api\/payments\/([0-9a-f-]{36})$/);
  if(payMatch && req.method==='PATCH') {
    requireModule('payments');requireRole(['admin','manager']);
    const old=mustExist(db,'payments',payMatch[1]);const data=await bodyJson(req);
    const status=enumValue(data.status,['pending','paid','cancelled','refunded'],'статус');
    const allowed={pending:['paid','cancelled'],paid:['refunded'],refunded:[],cancelled:[]};
    if(!allowed[old.status].includes(status)) bad(409,'Недопустимый переход статуса');
    db.prepare('UPDATE payments SET status=?,updated_at=? WHERE id=?').run(status,now(),old.id);
    audit(db,user.id,'update_status','payments',old.id,{from:old.status,to:status});
    return ok(res,{payment:mustExist(db,'payments',old.id),warning:status==='refunded'?'Статус учёта изменён. Реальный возврат не выполнялся.':null});
  }
  if(path==='/api/analytics' && req.method==='GET') {
    requireModule('analytics');requireRole(['admin','manager']);
    const currency=enumValue(query.get('currency')||config.settings.currency,currencies,'валюта');
    return ok(res,{analytics:readAnalytics(db,currency)});
  }
  if(path==='/api/users' && req.method==='GET') {
    const rows=db.prepare('SELECT id,email,name,role,active,created_at FROM users ORDER BY created_at ASC').all();
    return ok(res,{users:rows});
  }
  if(path==='/api/users' && req.method==='POST') {
    requireRole(['admin']);const data=await bodyJson(req);
    const uid=id(),email=validateEmail(data.email),name=shortText(data.name,'Имя',80),role=enumValue(data.role,['manager','staff'],'роль');
    const pass=hashPassword(data.password);
    if(db.prepare('SELECT id FROM users WHERE email=?').get(email)) bad(409,'Этот email уже занят');
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)')
      .run(uid,email,name,pass,role,now());
    audit(db,user.id,'create','users',uid,{role});
    return json(res,{ok:true,user:{id:uid,email,name,role}},201);
  }
  if(path==='/api/audit' && req.method==='GET') {
    requireRole(['admin']);
    return ok(res,{entries:db.prepare('SELECT id,user_id,action,entity,entity_id,created_at FROM audit_log ORDER BY created_at DESC LIMIT 100').all()});
  }
  bad(404,'Маршрут не найден');
}
