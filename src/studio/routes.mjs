import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bodyJson, bad, json, ok, routePath, staticFile, protectOrigin } from '../common/http.mjs';
import { id, now, hashPassword, verifyPassword, issueSession, revokeSession, sessionFromRequest, requireUser, checkLoginThrottle, cookie, shortText, validateEmail, enumValue, checkId, requireSetupToken } from '../common/security.mjs';
import { projectFromRow } from './db.mjs';
import { exportProject } from './export.mjs';
import { deploymentPreflight, exportDeploymentBundle } from './deployment.mjs';
import { createRelease, listReleases, releaseFromDb } from './releases.mjs';
import { normalizePage, listPages, makeStarterPage } from '../common/pages.mjs';
import { normalizeSitePage, makeSitePages, siteSettings } from '../site/model.mjs';
import { normalizeEntity, listEntities } from '../common/entities.mjs';
import { saveProjectTemplate, listTemplates, instantiateTemplate, getPortableTemplate, importPortableTemplate, deleteTemplate, createProjectFromSnapshot, snapshotFromProject } from './templates.mjs';
import { projectDiagnostics } from './diagnostics.mjs';
import { industryCatalog,hasIndustry,createIndustryPack } from './industries.mjs';
import { listWorkflows,createWorkflow,updateWorkflow,deleteWorkflow,previewWorkflow } from './workflows.mjs';
import { withTransaction } from '../common/db.mjs';
import { fleetStatus, pinFleetIdentity, importFleetSnapshot, fleetOverview } from './fleet.mjs';

const blueprint=JSON.parse(readFileSync(fileURLToPath(new URL('../../blueprints/restaurant-crm.json',import.meta.url)),'utf8'));
const siteBlueprint=JSON.parse(readFileSync(fileURLToPath(new URL('../../blueprints/company-site.json',import.meta.url)),'utf8'));
const cookieName='ox_studio';
const modules=blueprint.supportedModules;
const actions=blueprint.actions;
export function normalizeProject(input, existing = null) {
  const type=enumValue(input.type || existing?.type || 'crm',['crm','site'],'тип');
  if(existing && type!==existing.type)bad(400,'Тип существующего проекта изменить нельзя');
  if(type==='site'){
    const industry=enumValue(input.industry||existing?.industry||'business',['business'],'отрасль сайта');
    const name=shortText(input.name??existing?.name??siteBlueprint.defaults.name,'Название',80);
    const selected=input.modules??existing?.modules??siteBlueprint.defaults.modules;
    if(!Array.isArray(selected)||new Set(selected).size!==selected.length||selected.some(m=>!siteBlueprint.supportedModules.includes(m))||!selected.includes('auth')||!selected.includes('cms'))bad(400,'Для сайта обязательны auth и cms');
    return {type,industry,name,modules:selected,settings:siteSettings(input.settings||{},existing?.settings||siteBlueprint.defaults.settings)};
  }
  const industry=enumValue(input.industry || existing?.industry || 'restaurant',industryCatalog().map(x=>x.id),'отрасль');
  const name=shortText(input.name??existing?.name??blueprint.defaults.name,'Название',80);
  const selected=input.modules??existing?.modules??blueprint.defaults.modules;
  if (!Array.isArray(selected) || selected.length<1 || selected.length>modules.length || selected.some(m=>!modules.includes(m)) || new Set(selected).size!==selected.length || !selected.includes('auth')) bad(400,'Недопустимый набор модулей: auth обязателен');
  if (selected.includes('analytics') && !selected.includes('clients')) bad(400,'Для аналитики необходим модуль clients');
  const before=existing?.settings||blueprint.defaults.settings;
  const settings = { ...before, ...(input.settings || {}) };
  if (!/^#[0-9a-fA-F]{6}$/.test(settings.accent)) bad(400,'Цвет должен быть в формате #RRGGBB');
  enumValue(settings.primaryAction,actions,'главное действие');
  enumValue(settings.currency,['RUB','EUR','USD'],'валюта');
  if (settings.primaryAction==='new_client' && !selected.includes('clients')) settings.primaryAction='navigate_overview';
  if (settings.primaryAction==='new_task' && !selected.includes('tasks')) settings.primaryAction='navigate_overview';
  if (settings.primaryAction==='new_payment' && !selected.includes('payments')) settings.primaryAction='navigate_overview';
  return {type,industry,name,modules:selected,settings:{accent:settings.accent.toLowerCase(),primaryAction:settings.primaryAction,currency:settings.currency}};
}
export function getProject(db, projectId) {
  checkId(projectId);
  const project=projectFromRow(db.prepare('SELECT * FROM projects WHERE id=?').get(projectId));
  return project?{...project,pages:listPages(db,projectId),entities:listEntities(db,projectId),automationPresets:listWorkflows(db,projectId)}:null;
}
export async function handleStudioRequest(req,res,{db,root}) {
  const {path}=routePath(req);
  if(path==='/') return staticFile(res,`${root}/public/studio/index.html`,'.html');
  if(path==='/assets/studio/app.css') return staticFile(res,`${root}/public/studio/app.css`,'.css');
  if(path==='/assets/studio/app.js') return staticFile(res,`${root}/public/studio/app.js`,'.js');
  if(path==='/assets/studio/editor.js') return staticFile(res,`${root}/public/studio/editor.js`,'.js');
  if(path==='/assets/studio/entities.js') return staticFile(res,`${root}/public/studio/entities.js`,'.js');
  if(path==='/assets/studio/templates.js') return staticFile(res,`${root}/public/studio/templates.js`,'.js');
  if(path==='/assets/studio/workflows.js') return staticFile(res,`${root}/public/studio/workflows.js`,'.js');
  if(path==='/assets/studio/workbench.js') return staticFile(res,`${root}/public/studio/workbench.js`,'.js');
  if(path==='/assets/studio/deploy.js') return staticFile(res,`${root}/public/studio/deploy.js`,'.js');
  const media=path.match(/^\/assets\/studio\/media\/([a-z0-9-]+\.(?:jpg|png))$/);
  if(media) return staticFile(res,`${root}/public/studio/media/${media[1]}`,'.'+media[1].split('.').pop());
  if (!path.startsWith('/api/studio/')) bad(404,'Маршрут не найден');
  if (!['GET','HEAD'].includes(req.method)) protectOrigin(req);
  if(path==='/api/studio/session' && req.method==='GET') {
    const user=sessionFromRequest(req,db,cookieName);
    return ok(res,{initialized:!!db.prepare('SELECT id FROM users LIMIT 1').get(), authenticated:!!user,
      user:user?{id:user.id,name:user.name,email:user.email,role:user.role}:null, csrf:user?.csrf || null,requiresSetupToken:!!process.env.SETUP_TOKEN});
  }
  if(path==='/api/studio/setup' && req.method==='POST') {
    const data=await bodyJson(req);
    if (db.prepare('SELECT id FROM users LIMIT 1').get()) bad(409,'Администратор уже создан');
    requireSetupToken(data.setup_token);
    const email=validateEmail(data.email), name=shortText(data.name,'Имя',80);
    const hash=hashPassword(data.password), userId=id();
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)')
      .run(userId,email,name,hash,'owner',now());
    const session=issueSession(db,userId);
    return json(res,{ok:true,csrf:session.csrf,user:{id:userId,email,name,role:'owner'}},201,{'Set-Cookie':cookie(session.token,cookieName)});
  }
  if(path==='/api/studio/login' && req.method==='POST') {
    checkLoginThrottle(req,'studio');
    const data=await bodyJson(req);
    const email=validateEmail(data.email);
    const row=db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
    if (!row || !verifyPassword(String(data.password||''),row.password_hash)) bad(401,'Неверная почта или пароль');
    const session=issueSession(db,row.id);
    return json(res,{ok:true,csrf:session.csrf,user:{id:row.id,email:row.email,name:row.name,role:row.role}},200,{'Set-Cookie':cookie(session.token,cookieName)});
  }
  if(path==='/api/studio/logout' && req.method==='POST') {
    const user=requireUser(req,db,cookieName);
    revokeSession(db,user);
    return json(res,{ok:true},200,{'Set-Cookie':cookie('',cookieName,'/',0)});
  }
  const user=requireUser(req,db,cookieName);
  if(path==='/api/studio/blueprints' && req.method==='GET') return ok(res,{blueprints:[blueprint,siteBlueprint],industries:industryCatalog()});
  if(path==='/api/studio/industries' && req.method==='GET')return ok(res,{industries:industryCatalog()});
  if(path==='/api/studio/projects' && req.method==='GET') {
    const list=db.prepare('SELECT * FROM projects WHERE owner_id=? ORDER BY created_at DESC').all(user.id).map(projectFromRow);
    return ok(res,{projects:list});
  }
  if(path==='/api/studio/projects' && req.method==='POST') {
    const input=normalizeProject(await bodyJson(req));
    const projectId=id(), stamp=now();
    const pack=input.type==='crm'?createIndustryPack(input.industry,input.modules):null;
    const starters=input.type==='site'?makeSitePages(input.name,input.modules):pack.pages;
    withTransaction(db,()=>{
      db.prepare('INSERT INTO projects(id,owner_id,name,type,industry,modules_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(projectId,user.id,input.name,input.type,input.industry,JSON.stringify(input.modules),JSON.stringify(input.settings),stamp,stamp);
      for(const entity of pack?.entities||[]){
        db.prepare('INSERT INTO project_entities(id,project_id,slug,definition_json,revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?)')
          .run(id(),projectId,entity.slug,JSON.stringify(entity),stamp,stamp);
      }
      starters.forEach((starter,pos)=>db.prepare('INSERT INTO project_pages(id,project_id,title,slug,description,published,blocks_json,position,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id(),projectId,starter.title,starter.slug,starter.description,Number(starter.published),JSON.stringify(starter.blocks),pos,1,stamp,stamp));
    });
    return json(res,{ok:true,project:getProject(db,projectId)},201);
  }
  // R0.8: owner-only template library, portable manifests, and no-data cloning.
  if(path==='/api/studio/templates' && req.method==='GET')
    return ok(res,{templates:listTemplates(db,user.id)});
  if(path==='/api/studio/templates' && req.method==='POST'){
    const input=await bodyJson(req);
    const sourceId=checkId(input.projectId);
    if(!db.prepare('SELECT id FROM projects WHERE id=? AND owner_id=?').get(sourceId,user.id))bad(404,'Project not found');
    const template=saveProjectTemplate(db,user.id,getProject(db,sourceId),input.name,input.description,normalizeProject);
    return json(res,{ok:true,template},201);
  }
  if(path==='/api/studio/templates/import' && req.method==='POST'){
    const manifest=await bodyJson(req);
    const template=importPortableTemplate(db,user.id,manifest,normalizeProject);
    return json(res,{ok:true,template},201);
  }
  const templateMatch=path.match(/^\/api\/studio\/templates\/([0-9a-f-]{36})(?:\/(download|projects))?$/);
  if(templateMatch){
    const templateId=checkId(templateMatch[1]),action=templateMatch[2];
    if(action==='download' && req.method==='GET'){
      const manifest=getPortableTemplate(db,user.id,templateId);
      return json(res,manifest,200,{'Content-Disposition':`attachment; filename="osmanx-template-${templateId.slice(0,8)}.json"`});
    }
    if(action==='projects' && req.method==='POST'){
      const input=await bodyJson(req);
      const projectId=instantiateTemplate(db,user.id,templateId,input.name,normalizeProject);
      return json(res,{ok:true,project:getProject(db,projectId)},201);
    }
    if(!action && req.method==='DELETE'){
      deleteTemplate(db,user.id,templateId);
      return ok(res,{deleted:templateId});
    }
    bad(405,'Unsupported template operation');
  }
  // One owner-scoped request powers the unified visual project workspace.
  const workbenchMatch=path.match(/^\/api\/studio\/projects\/([0-9a-f-]{36})\/workbench$/);
  if(workbenchMatch && req.method==='GET'){
    const projectId=checkId(workbenchMatch[1]);
    if(!db.prepare('SELECT 1 FROM projects WHERE id=? AND owner_id=?').get(projectId,user.id))bad(404,'Проект не найден');
    const project=getProject(db,projectId);
    return ok(res,{project,diagnostics:projectDiagnostics(project,normalizeProject),releases:listReleases(db,projectId)});
  }
  const cloneMatch=path.match(/^\/api\/studio\/projects\/([0-9a-f-]{36})\/(clone|diagnostics)$/);
  if(cloneMatch){
    const sourceId=checkId(cloneMatch[1]);
    if(!db.prepare('SELECT id FROM projects WHERE owner_id=? AND id=?').get(user.id,sourceId))bad(404,'Project not found');
    const project=getProject(db,sourceId);
    if(cloneMatch[2]==='diagnostics' && req.method==='GET')return ok(res,projectDiagnostics(project,normalizeProject));
    if(cloneMatch[2]==='clone' && req.method==='POST'){
      const input=await bodyJson(req);
      const projectId=createProjectFromSnapshot(db,user.id,snapshotFromProject(project),input.name||`${project.name} (copy)`,normalizeProject);
      return json(res,{ok:true,project:getProject(db,projectId)},201);
    }
    bad(405,'Unsupported project operation');
  }
  // Immutable, incrementing, per-project releases. Exports always come from the saved snapshot.
  const releaseMatch=path.match(/^\/api\/studio\/projects\/([0-9a-f-]{36})\/releases(?:\/([0-9a-f-]{36})(?:\/(export))?)?$/);
  if(releaseMatch) {
    const projectId=releaseMatch[1];
    const project=getProject(db,projectId);
    if(!project||!db.prepare('SELECT 1 FROM projects WHERE id=? AND owner_id=?').get(projectId,user.id))bad(404,'Project not found');
    if(!releaseMatch[2] && req.method==='GET')return ok(res,{releases:listReleases(db,projectId)});
    if(!releaseMatch[2] && req.method==='POST'){
      const data=await bodyJson(req);
      const release=createRelease(db,project,user.id,data.notes||'');
      return json(res,{ok:true,release},201);
    }
    if(releaseMatch[2] && releaseMatch[3]==='export' && req.method==='GET'){
      const {release,project:snapshot}=releaseFromDb(db,projectId,releaseMatch[2]);
      if(!projectDiagnostics(snapshot,normalizeProject).summary.exportReady)bad(409,'Исправьте ошибки проверки проекта перед экспортом');
      const buffer=await exportProject(snapshot,root,release);
      res.writeHead(200,{'Content-Type':'application/zip',
        'Content-Disposition':`attachment; filename="osmanx-${projectId.slice(0,8)}-v${release.sequence}.zip"`,
        'Cache-Control':'no-store','Content-Length':buffer.length});
      return res.end(buffer);
    }
    bad(405,'Method not supported');
  }
  // Reusable workflow presets are project config (not live CRM tasks or runtime rule rows).
  const wfMatch=path.match(/^\/api\/studio\/projects\/([0-9a-f-]{36})\/(workflows|workflow-preview)(?:\/([0-9a-f-]{36}))?$/);
  if(wfMatch){
    const projectId=checkId(wfMatch[1]);
    if(!db.prepare('SELECT 1 FROM projects WHERE id=? AND owner_id=?').get(projectId,user.id))bad(404,'Проект не найден');
    const project=getProject(db,projectId);
    if(project.type!=='crm')bad(404,'Сценарии доступны только для CRM');
    if(wfMatch[2]==='workflow-preview' && req.method==='POST')return ok(res,previewWorkflow(project,await bodyJson(req)));
    if(wfMatch[2]!=='workflows')bad(405,'Метод не поддерживается');
    if(!wfMatch[3] && req.method==='GET')return ok(res,{workflows:project.automationPresets});
    if(!wfMatch[3] && req.method==='POST')return json(res,{ok:true,workflow:createWorkflow(db,project,await bodyJson(req))},201);
    if(wfMatch[3] && req.method==='PATCH')return ok(res,{workflow:updateWorkflow(db,project,wfMatch[3],await bodyJson(req))});
    if(wfMatch[3] && req.method==='DELETE'){
      deleteWorkflow(db,projectId,wfMatch[3]);return ok(res,{deleted:true});
    }
    bad(405,'Метод не поддерживается');
  }
  // Declarative data model editor. Entity slug/type/required status are immutable after creation.
  const entityMatch=path.match(/^\/api\/studio\/projects\/([0-9a-f-]{36})\/entities(?:\/([0-9a-f-]{36}))?$/);
  if(entityMatch){
    const project=getProject(db,entityMatch[1]);
    if(!project || !db.prepare('SELECT 1 FROM projects WHERE id=? AND owner_id=?').get(project.id,user.id))bad(404,'Проект не найден');
    if(project.type!=='crm')bad(404,'Data Studio доступна только для CRM');
    const entityId=entityMatch[2];
    if(!entityId&&req.method==='GET')return ok(res,{entities:project.entities});
    if(!entityId&&req.method==='POST'){
      if(project.entities.length>=12)bad(409,'Не более 12 сущностей на один проект');
      const ent=normalizeEntity(await bodyJson(req),null,project.entities);
      const stamp=now(),eid=id();
      db.prepare('INSERT INTO project_entities(id,project_id,slug,definition_json,revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?)')
        .run(eid,project.id,ent.slug,JSON.stringify(ent),stamp,stamp);
      return json(res,{ok:true,entity:listEntities(db,project.id).find(e=>e.id===eid)},201);
    }
    if(entityId&&req.method==='PATCH'){
      const current=project.entities.find(e=>e.id===entityId);
      if(!current)bad(404,'Сущность не найдена');
      const payload=await bodyJson(req);
      if(!Number.isSafeInteger(payload.revision)||payload.revision!==current.revision)bad(409,'Схема обновлена в другой вкладке. Обновите редактор.');
      const ent=normalizeEntity(payload,current,project.entities);
      const result=db.prepare('UPDATE project_entities SET definition_json=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?')
        .run(JSON.stringify(ent),now(),entityId,project.id,current.revision);
      if(result.changes!==1)bad(409,'Схема обновлена другим пользователем');
      return ok(res,{entity:listEntities(db,project.id).find(e=>e.id===entityId)});
    }
    bad(405,'Метод не поддерживается; сущности не удаляются, чтобы сохранить данные');
  }
  // Page routes are owned by the factory account, not by CRM employees.
  const pageMatch=path.match(/^\/api\/studio\/projects\/([0-9a-f-]{36})\/pages(?:\/([0-9a-f-]{36}))?$/);
  if(pageMatch){
    const project=getProject(db,pageMatch[1]);
    if(!project || !db.prepare('SELECT 1 FROM projects WHERE id=? AND owner_id=?').get(project.id,user.id))bad(404,'Проект не найден');
    const pageId=pageMatch[2];
    if(!pageId&&req.method==='GET')return ok(res,{pages:project.pages});
    if(!pageId&&req.method==='POST'){
      if(project.pages.length>=20)bad(409,'Не более 20 страниц на проект');
      const page=(project.type==='site'?normalizeSitePage(await bodyJson(req),project.modules):normalizePage(await bodyJson(req),project.modules,project.entities)),pid=id(),stamp=now();
      if(project.pages.some(p=>p.slug===page.slug))bad(409,'Такой URL страницы уже занят');
      db.prepare('INSERT INTO project_pages(id,project_id,title,slug,description,published,blocks_json,position,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(pid,project.id,page.title,page.slug,page.description,Number(page.published),JSON.stringify(page.blocks),project.pages.length,1,stamp,stamp);
      return json(res,{ok:true,page:listPages(db,project.id).find(p=>p.id===pid)},201);
    }
    if(pageId){
      const current=project.pages.find(p=>p.id===pageId);
      if(!current)bad(404,'Страница не найдена');
      if(req.method==='PATCH'){
        const data=await bodyJson(req);
        if(!Number.isSafeInteger(data.revision)||data.revision!==current.revision)bad(409,'Страница изменилась в другой вкладке. Обновите редактор.');
        const page=project.type==='site'?normalizeSitePage(data,project.modules):normalizePage(data,project.modules,project.entities);
        if(project.pages.some(p=>p.id!==current.id&&p.slug===page.slug))bad(409,'Такой URL страницы уже занят');
        const result=db.prepare('UPDATE project_pages SET title=?,slug=?,description=?,published=?,blocks_json=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?')
          .run(page.title,page.slug,page.description,Number(page.published),JSON.stringify(page.blocks),now(),current.id,project.id,current.revision);
        if(result.changes!==1)bad(409,'Страница обновлена в другом сеансе');
        return ok(res,{page:listPages(db,project.id).find(p=>p.id===current.id)});
      }
      if(req.method==='DELETE'){
        if(project.type==='site'&&current.slug==='home')bad(400,'Нельзя удалить главную страницу сайта');
        const data=await bodyJson(req);
        if(data.revision!==current.revision)bad(409,'Страница изменилась. Обновите редактор.');
        const result=db.prepare('DELETE FROM project_pages WHERE id=? AND project_id=? AND revision=?').run(current.id,project.id,current.revision);
        if(result.changes!==1)bad(409,'Страница обновлена в другом сеансе');
        return ok(res,{deleted:current.id});
      }
    }
    bad(405,'Метод не поддерживается');
  }
  if(path==='/api/studio/fleet' && req.method==='GET')return ok(res,{fleet:fleetOverview(db,user.id)});
  // R3.4 owner-scoped offline fleet report import. No auto-callbacks or outbound traffic.
  const fleetRoute=path.match(/^\/api\/studio\/projects\/([0-9a-f-]{36})\/fleet(?:\/(trust|import))?$/);
  if(fleetRoute){
    const projectId=checkId(fleetRoute[1]);
    if(!db.prepare('SELECT 1 FROM projects WHERE id=? AND owner_id=?').get(projectId,user.id))bad(404,'Project not found');
    if(!fleetRoute[2] && req.method==='GET')return ok(res,{fleet:fleetStatus(db,user.id,projectId)});
    if(fleetRoute[2]==='trust' && req.method==='POST'){
      const data=await bodyJson(req);
      return ok(res,{trust:pinFleetIdentity(db,user.id,projectId,data.publicKeyPem,data.rotate===true)});
    }
    if(fleetRoute[2]==='import' && req.method==='POST'){
      const data=await bodyJson(req);
      return ok(res,{fleet:importFleetSnapshot(db,user.id,projectId,data.packet)});
    }
    bad(405,'Method not supported');
  }
  const deployRoute=path.match(/^\/api\/studio\/projects\/([0-9a-f-]{36})\/deployment\/(preflight|export)$/);
  if(deployRoute){
    if(req.method!=='GET')bad(405,'Method not supported');
    const project=getProject(db,deployRoute[1]);
    if(!project || !db.prepare('SELECT id FROM projects WHERE owner_id=? AND id=?').get(user.id,deployRoute[1]))bad(404,'Project not found');
    const query=new URL(req.url,'http://localhost').searchParams;
    const savedReleaseId=query.get('releaseId');
    const selected=savedReleaseId?releaseFromDb(db,project.id,checkId(savedReleaseId)):null;
    const selectedProject=selected?.project || project;
    if(!projectDiagnostics(selectedProject,normalizeProject).summary.exportReady)bad(409,'Project release has export errors');
    const domain=query.get('domain') || '';
    try{
      if(deployRoute[2]==='preflight'){
        const result=await deploymentPreflight({domain,serverIp:query.get('serverIp')||null,checkDns:query.get('dns')!=='0'});
        return ok(res,{deployment:result});
      }
      const buffer=await exportDeploymentBundle(selectedProject,root,domain,selected?.release||null);
      const safeName=domain.toLowerCase().replace(/[^a-z0-9.-]/g,'-').slice(0,100);
      const versionSuffix=selected?'-v'+selected.release.sequence:'';
      res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="osmanx-deploy-${safeName}${versionSuffix}.zip"`,
        'Cache-Control':'no-store','Content-Length':buffer.length});
      return res.end(buffer);
    }catch(err){
      if(err.status)throw err;
      if(/domain|Server IP|IPv4|reserved|top-level/i.test(err.message))bad(400,err.message);
      throw err;
    }
  }
  const match=path.match(/^\/api\/studio\/projects\/([0-9a-f-]{36})(?:\/(export))?$/);
  if(match) {
    const project=getProject(db,match[1]);
    if(!project || !db.prepare('SELECT id FROM projects WHERE owner_id=? AND id=?').get(user.id,match[1])) bad(404,'Проект не найден');
    if(match[2]==='export' && req.method==='GET') {
      if(!projectDiagnostics(project,normalizeProject).summary.exportReady)bad(409,'Исправьте ошибки проверки проекта перед экспортом');
      const buffer=await exportProject(project,root);
      res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="osmanx-${project.id.slice(0,8)}.zip"`,
        'Cache-Control':'no-store','Content-Length':buffer.length});
      return res.end(buffer);
    }
    if(!match[2] && req.method==='GET') return ok(res,{project});
    if(!match[2] && req.method==='PATCH') {
      const input=normalizeProject(await bodyJson(req),project);
      for(const page of project.pages)(project.type==='site'?normalizeSitePage(page,input.modules):normalizePage(page,input.modules,project.entities));
      db.prepare('UPDATE projects SET name=?,modules_json=?,settings_json=?,updated_at=? WHERE id=? AND owner_id=?')
        .run(input.name,JSON.stringify(input.modules),JSON.stringify(input.settings),now(),project.id,user.id);
      return ok(res,{project:getProject(db,project.id)});
    }
  }
  bad(404,'Маршрут не найден');
}
