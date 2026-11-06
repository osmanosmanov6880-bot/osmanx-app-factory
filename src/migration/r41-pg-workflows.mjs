// R4.1: synthetic-only CRM workflow API. Primary CRM continues on SQLite.
// The owner uses the Studio session; employees use their existing per-workspace CRM session.
// All PostgreSQL operations pass through the signed per-tenant NOLOGIN-role adapter.
import {randomUUID} from 'node:crypto';
import {bodyJson, bad, json, ok, protectOrigin} from '../common/http.mjs';
import {checkId, enumValue, nullableId, optionalIso, requireUser, shortText} from '../common/security.mjs';
import {writePgPreviewAudit} from './r42-pg-audit.mjs';
const auditEnabled=()=>process.env.OX_R42_PG_RECONCILIATION==='YES';

const STATUSES=['todo','doing','done','cancelled'];
const PRIORITIES=['low','medium','high'];
const TASK_FIELDS=['title','description','status','priority','dueAt','clientId','assignedTo'];
const WRITE_METHODS=new Set(['POST','PATCH']);

function object(input,allowed){
  if(!input || typeof input!=='object' || Array.isArray(input) ||
    Object.keys(input).some(k=>!allowed.includes(k)))bad(400,'Неизвестные или недопустимые поля');
  return input;
}
function limit(raw){if(!/^(?:[1-9]|[1-4][0-9]|50)$/.test(raw??'25'))bad(400,'Лимит: от 1 до 50');return Number(raw??'25');}
function dateToken(value){
  if(typeof value!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value)) || new Date(value).toISOString()!==value)bad(400,'Укажите точную версию updatedAt');
  return value;
}
function nextVersion(previous){
  const tick=Date.parse(previous);
  return new Date(Math.max(Date.now(),Number.isFinite(tick)?tick+1:0)).toISOString();
}
function taskInput(data,partial=false){
  object(data,partial?[...TASK_FIELDS,'expectedUpdatedAt']:TASK_FIELDS);
  if(!partial && !Object.hasOwn(data,'title'))bad(400,'Название задачи обязательно');
  const result={};
  if(Object.hasOwn(data,'title')){
    if(typeof data.title!=='string')bad(400,'Название должно быть строкой');
    result.title=shortText(data.title,'Задача',180);
  }
  if(Object.hasOwn(data,'description')){
    if(typeof data.description!=='string')bad(400,'Описание должно быть строкой');
    result.description=shortText(data.description,'Описание',1500,false);
  }
  if(Object.hasOwn(data,'status'))result.status=enumValue(data.status,STATUSES,'статус');
  if(Object.hasOwn(data,'priority'))result.priority=enumValue(data.priority,PRIORITIES,'приоритет');
  if(Object.hasOwn(data,'dueAt'))result.dueAt=optionalIso(data.dueAt,'срок');
  if(Object.hasOwn(data,'clientId'))result.clientId=nullableId(data.clientId);
  if(Object.hasOwn(data,'assignedTo'))result.assignedTo=nullableId(data.assignedTo);
  if(partial){
    if(!Object.hasOwn(data,'expectedUpdatedAt'))bad(428,'Обязательна версия задачи');
    result.expectedUpdatedAt=dateToken(data.expectedUpdatedAt);
    if(Object.keys(result).length===1)bad(400,'Не указаны изменения');
  }
  return result;
}
function visitInput(data){
  object(data,['clientId','occurredAt','note']);
  if(!Object.hasOwn(data,'clientId'))bad(400,'Укажите клиента');
  if(Object.hasOwn(data,'note') && typeof data.note!=='string')bad(400,'Примечание должно быть строкой');
  return {clientId:checkId(data.clientId),occurredAt:optionalIso(data.occurredAt??new Date().toISOString(),'время визита'),
    note:shortText(data.note??'','Примечание',600,false)};
}
function mapTask(t){return {id:t.id,title:t.title,description:t.description,status:t.status,priority:t.priority,
  dueAt:t.due_at,clientId:t.client_id,assignedTo:t.assigned_to,createdBy:t.created_by,
  createdAt:t.created_at,updatedAt:t.updated_at};}
function mapVisit(v){return {id:v.id,clientId:v.client_id,occurredAt:v.occurred_at,note:v.note,
  createdBy:v.created_by,createdAt:v.created_at};}
function studioProject(studioDb,projectId){
  checkId(projectId);
  const p=studioDb.prepare(`SELECT p.id,p.owner_id,p.type,p.modules_json FROM projects p
    JOIN users u ON u.id=p.owner_id AND u.active=1 WHERE p.id=?`).get(projectId);
  if(!p || p.type!=='crm')bad(404,'CRM не найдена');
  let modules;try{modules=JSON.parse(p.modules_json);}catch{bad(500,'Неверная конфигурация CRM');}
  if(!Array.isArray(modules))bad(500,'Неверная конфигурация CRM');
  return {...p,modules};
}
function parseRoute(path,workspaceProjectId){
  if(workspaceProjectId){
    const prefix=`/workspace/${workspaceProjectId}/api/pg-preview/`;
    if(!path.startsWith(prefix))return null;
    const match=path.slice(prefix.length).match(/^(tasks|visits)(?:\/(batch|[0-9a-f-]{36}))?$/);
    return match?{projectId:workspaceProjectId,kind:match[1],target:match[2]||null,workspace:true}:null;
  }
  const match=path.match(/^\/api\/studio\/pg-preview\/projects\/([0-9a-f-]{36})\/(tasks|visits)(?:\/(batch|[0-9a-f-]{36}))?$/);
  return match?{projectId:match[1],kind:match[2],target:match[3]||null,workspace:false}:null;
}
function access(req,studioDb,crmDb,route){
  const p=studioProject(studioDb,route.projectId);
  if(!p.modules.includes(route.kind==='tasks'?'tasks':'clients'))bad(404,'Модуль не подключён');
  if(route.workspace){
    if(!crmDb)bad(404,'CRM недоступна');
    const employee=requireUser(req,crmDb,'ox_crm');
    if(!['admin','manager','staff'].includes(employee.role))bad(403,'Нет доступа к CRM');
    return {actorId:p.owner_id,createdBy:employee.id,role:employee.role,staff:employee.role==='staff',projectId:route.projectId};
  }
  const owner=requireUser(req,studioDb,'ox_studio');
  if(owner.id!==p.owner_id)bad(404,'CRM не найдена');
  return {actorId:owner.id,createdBy:null,role:'owner',staff:false,projectId:route.projectId};
}
async function assertActivePgUser(scope,id){
  if(id===null)return;
  const u=await scope.query('SELECT id FROM users WHERE id=$1 AND active=1',[id]);
  if(!u.rows.length)bad(409,'Сотрудник не найден или неактивен в подписанном снимке');
}
async function assertActiveClient(scope,id){
  if(id===null)return;
  const c=await scope.query('SELECT id FROM clients WHERE id=$1 AND archived_at IS NULL',[id]);
  if(!c.rows.length)bad(409,'Клиент отсутствует или в архиве');
}
async function insertVisit(scope,data,ctx){
  const v=visitInput(data);
  await assertActiveClient(scope,v.clientId);
  await assertActivePgUser(scope,ctx.createdBy);
  const id=randomUUID(),now=new Date().toISOString();
  const rows=await scope.query(`INSERT INTO visits(id,client_id,occurred_at,note,created_by,created_at)
    VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[id,v.clientId,v.occurredAt,v.note,ctx.createdBy,now]);
  if(auditEnabled())await writePgPreviewAudit(scope,{actorUserId:ctx.createdBy,action:'create',entity:'visits',entityId:id,afterImage:rows.rows[0]});
  return mapVisit(rows.rows[0]);
}
async function insertTask(scope,data,ctx){
  const t=taskInput(data);
  await assertActiveClient(scope,t.clientId??null);
  await assertActivePgUser(scope,t.assignedTo??null);
  await assertActivePgUser(scope,ctx.createdBy);
  const id=randomUUID(),now=new Date().toISOString();
  const rows=await scope.query(`INSERT INTO tasks(id,title,description,status,priority,due_at,client_id,assigned_to,created_by,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
  [id,t.title,t.description??'',t.status??'todo',t.priority??'medium',t.dueAt??null,t.clientId??null,t.assignedTo??null,ctx.createdBy,now,now]);
  if(auditEnabled())await writePgPreviewAudit(scope,{actorUserId:ctx.createdBy,action:'create',entity:'tasks',entityId:id,afterImage:rows.rows[0]});
  return mapTask(rows.rows[0]);
}
const columns=Object.freeze({title:'title',description:'description',status:'status',priority:'priority',dueAt:'due_at',clientId:'client_id',assignedTo:'assigned_to'});

export async function handleR41PreviewRequest(req,res,{studioDb,runtime,crmDb=null,workspaceProjectId=null}){
  if(!runtime?.adapter)bad(404,'PostgreSQL Preview выключен');
  const url=new URL(req.url,'http://localhost');
  const route=parseRoute(url.pathname,workspaceProjectId);
  if(!route)bad(404,'Маршрут не найден');
  if(WRITE_METHODS.has(req.method))protectOrigin(req);
  const ctx=access(req,studioDb,crmDb,route); // Session, project ownership, modules BEFORE PG connection.
  const transaction=(mode,fn)=>runtime.adapter.transaction({actorId:ctx.actorId,projectId:ctx.projectId,mode},fn);
  const {kind,target}=route;
  if(req.method==='GET' && !target){
    const count=limit(url.searchParams.get('limit')??'25');
    const clientId=url.searchParams.get('clientId');
    if(clientId)checkId(clientId);
    const status=url.searchParams.get('status');
    if(kind==='visits' && status)bad(400,'Фильтр статуса недоступен для визитов');
    if(kind==='tasks' && status)enumValue(status,STATUSES,'статус');
    const rows=await transaction('read',async scope=>{
      const where=[],args=[];
      if(ctx.staff){args.push(ctx.createdBy);where.push(`${kind==='tasks'?'assigned_to':'created_by'}=$${args.length}`);}
      if(clientId){args.push(clientId);where.push(`client_id=$${args.length}`);}
      if(status){args.push(status);where.push(`status=$${args.length}`);}
      args.push(count);
      const sort=kind==='tasks'?'updated_at':'occurred_at';
      const sql=`SELECT * FROM ${kind} ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY ${sort} DESC,id DESC LIMIT $${args.length}`;
      return (await scope.query(sql,args)).rows;
    });
    return ok(res,{source:'postgresql-preview',projectId:ctx.projectId,[kind]:rows.map(kind==='tasks'?mapTask:mapVisit)});
  }
  if(req.method==='POST' && !target){
    if(kind==='tasks' && ctx.staff)bad(403,'Назначение задач доступно менеджеру');
    const input=await bodyJson(req);
    const result=await transaction('write',scope=>kind==='tasks'?insertTask(scope,input,ctx):insertVisit(scope,input,ctx));
    return json(res,{ok:true,[kind==='tasks'?'task':'visit']:result,source:'postgresql-preview'},201);
  }
  if(req.method==='POST' && kind==='visits' && target==='batch'){
    const input=object(await bodyJson(req),['items']);
    if(!Array.isArray(input.items)||input.items.length<1||input.items.length>10)bad(400,'Пакет: от 1 до 10 визитов');
    const visits=await transaction('write',async scope=>{
      const results=[];
      for(const item of input.items)results.push(await insertVisit(scope,item,ctx));
      return results;
    });
    return json(res,{ok:true,visits,source:'postgresql-preview'},201);
  }
  if(req.method==='PATCH' && kind==='tasks' && target && target!=='batch'){
    checkId(target);
    const data=taskInput(await bodyJson(req),true);
    if(ctx.staff){
      if(Object.keys(data).some(k=>!['status','expectedUpdatedAt'].includes(k)) || !['doing','done'].includes(data.status))
        bad(403,'Сотрудник может менять только статус назначенной задачи');
    }
    const updated=await transaction('write',async scope=>{
      const old=(await scope.query('SELECT * FROM tasks WHERE id=$1',[target])).rows[0];
      if(!old || (ctx.staff && old.assigned_to!==ctx.createdBy))bad(404,'Задача не найдена');
      if(old.updated_at!==data.expectedUpdatedAt)bad(409,'Задача изменена другим пользователем');
      await assertActiveClient(scope, data.clientId??null);
      await assertActivePgUser(scope, data.assignedTo??null);
      if(ctx.staff)await assertActivePgUser(scope,ctx.createdBy);
      const changed=Object.keys(data).filter(k=>k!=='expectedUpdatedAt');
      const params=changed.map(k=>data[k]);
      const assignments=changed.map((k,i)=>`"${columns[k]}"=$${i+1}`);
      const now=nextVersion(old.updated_at);
      params.push(now,target,data.expectedUpdatedAt);
      const q=`UPDATE tasks SET ${assignments.join(',')}, updated_at=$${params.length-2}
        WHERE id=$${params.length-1} AND updated_at=$${params.length}${ctx.staff?' AND assigned_to=$'+(params.length+1):''} RETURNING *`;
      if(ctx.staff)params.push(ctx.createdBy);
      const row=(await scope.query(q,params)).rows[0];
      if(!row)bad(409,'Конфликт обновления задачи');
      if(auditEnabled())await writePgPreviewAudit(scope,{actorUserId:ctx.createdBy,action:'update',entity:'tasks',entityId:target,afterImage:row});
      return mapTask(row);
    });
    return ok(res,{task:updated,source:'postgresql-preview'});
  }
  bad(405,'Метод не поддерживается');
}
