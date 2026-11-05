import { bad } from '../common/http.mjs';
import { id, now, shortText } from '../common/security.mjs';
import { withTransaction } from '../common/db.mjs';
import { hashJson } from './releases.mjs';
import { normalizeEntity } from '../common/entities.mjs';
import { normalizePage } from '../common/pages.mjs';
import { normalizeSitePage } from '../site/model.mjs';
import { normalizeAutomationPreset } from '../crm/automations.mjs';

export const TEMPLATE_FORMAT = 'osmanx-factory-template';
export const TEMPLATE_VERSION = 1;
const MAX_TEMPLATES = 60;
const MAX_SNAPSHOT_BYTES = 120 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Never serialize owner IDs, customer records, database files, password hashes or sessions.
export function snapshotFromProject(project) {
  return {
    type: project.type,
    industry: project.industry,
    name: project.name,
    modules: structuredClone(project.modules),
    settings: structuredClone(project.settings),
    entities: (project.entities || []).map(({slug,title,description,access,fields}) =>
      ({slug,title,description,access:structuredClone(access),fields:structuredClone(fields)})),
    pages: (project.pages || []).map(({title,slug,description,published,blocks}) =>
      ({title,slug,description,published,blocks:structuredClone(blocks)})),
    automationPresets: (project.automationPresets || []).map(({name,event,task_title,priority,enabled,entity_slug,condition_field,condition_value,due_days}) =>
      ({name,event,task_title,priority,enabled,entity_slug,condition_field,condition_value,due_days}))
  };
}

export function validateSnapshot(input, normalizeProject, {maxBytes=MAX_SNAPSHOT_BYTES}={}) {
  if (!record(input)) bad(400, 'Invalid template data');
  if (!Array.isArray(input.entities) || input.entities.length > 12) bad(400, 'Invalid template entities');
  if (!Array.isArray(input.pages) || input.pages.length > 20) bad(400, 'Invalid template pages');
  if(input.automationPresets!==undefined && (!Array.isArray(input.automationPresets)||input.automationPresets.length>30))bad(400,'Invalid automation presets');
  const project = normalizeProject(input);
  if (project.type === 'site' && input.entities.length) bad(400, 'Websites cannot contain CRM entities');
  const entities = [];
  for (const entry of input.entities) {
    entities.push(normalizeEntity(entry, null, entities));
  }
  const pages = input.pages.map(page => project.type === 'site'
    ? normalizeSitePage(page, project.modules)
    : normalizePage(page, project.modules, entities));
  const pageSlugs = pages.map(p => p.slug);
  if (pageSlugs.length !== new Set(pageSlugs).size) bad(400, 'Duplicate template page URL');
  if (project.type === 'site' && !pageSlugs.includes('home')) bad(400, 'A website needs a home page');
  if(project.type==='site' && (input.automationPresets||[]).length)bad(400,'Website cannot have CRM workflows');
  const automationPresets=(input.automationPresets||[]).map(w=>normalizeAutomationPreset(w,entities,project.modules));
  const snapshot = { ...project, entities, pages, automationPresets };
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > maxBytes)
    bad(413, 'Template exceeds 120 KB configuration limit');
  return snapshot;
}

function publicTemplate(row) {
  return {id:row.id,name:row.name,description:row.description,type:row.type,
    industry:row.industry,sourceProjectId:row.source_project_id,checksum:row.snapshot_sha256,
    createdAt:row.created_at};
}
export function listTemplates(db, ownerId) {
  return db.prepare('SELECT id,name,description,type,industry,source_project_id,snapshot_sha256,created_at FROM project_templates WHERE owner_id=? ORDER BY created_at DESC,id DESC LIMIT 100')
    .all(ownerId).map(publicTemplate);
}
function templateRow(db, ownerId, templateId) {
  const row = db.prepare('SELECT * FROM project_templates WHERE owner_id=? AND id=?').get(ownerId,templateId);
  if (!row) bad(404, 'Template not found');
  const raw = JSON.parse(row.snapshot_json);
  if (hashJson(raw) !== row.snapshot_sha256) bad(409, 'Template checksum verification failed');
  return {row,snapshot:raw};
}
function storeTemplate(db, ownerId, name, description, snapshot, sourceProjectId=null) {
  return withTransaction(db, () => {
    const count=db.prepare('SELECT COUNT(*) AS n FROM project_templates WHERE owner_id=?').get(ownerId).n;
    if(count >= MAX_TEMPLATES)bad(409, 'Template library limit reached');
    const templateId=id(),created=now();
    db.prepare('INSERT INTO project_templates(id,owner_id,name,description,type,industry,source_project_id,snapshot_json,snapshot_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(templateId,ownerId,name,description,snapshot.type,snapshot.industry,sourceProjectId,
        JSON.stringify(snapshot),hashJson(snapshot),created);
    return publicTemplate(db.prepare('SELECT * FROM project_templates WHERE id=?').get(templateId));
  });
}
export function saveProjectTemplate(db,ownerId,project,name,description,normalizeProject){
  const snapshot=validateSnapshot(snapshotFromProject(project),normalizeProject);
  return storeTemplate(db,ownerId,shortText(name??project.name,'Template name',80),
    shortText(description??'','Template description',240,false),snapshot,project.id);
}
export function getPortableTemplate(db,ownerId,templateId){
  const {row,snapshot}=templateRow(db,ownerId,templateId);
  return {format:TEMPLATE_FORMAT,version:TEMPLATE_VERSION,
    name:row.name,description:row.description,snapshot,sha256:row.snapshot_sha256};
}
export function importPortableTemplate(db,ownerId,input,normalizeProject){
  if(!record(input)||input.format!==TEMPLATE_FORMAT||input.version!==TEMPLATE_VERSION||!record(input.snapshot))
    bad(400,'Invalid template manifest');
  if(typeof input.sha256!=='string'||hashJson(input.snapshot)!==input.sha256)
    bad(400,'Template checksum mismatch');
  const snapshot=validateSnapshot(input.snapshot,normalizeProject);
  return storeTemplate(db,ownerId,shortText(input.name,'Template name',80),
    shortText(input.description??'','Template description',240,false),snapshot,null);
}
export function deleteTemplate(db,ownerId,templateId){
  const changes=db.prepare('DELETE FROM project_templates WHERE id=? AND owner_id=?').run(templateId,ownerId).changes;
  if(!changes)bad(404,'Template not found');
}

// Atomic copying of only declarative configuration. No SQLite tenant data are touched.
export function createProjectFromSnapshot(db,ownerId,rawSnapshot,newName,normalizeProject) {
  const snapshot=validateSnapshot(rawSnapshot,normalizeProject,{maxBytes:Infinity});
  const settings=normalizeProject({...snapshot,name:newName??snapshot.name});
  return withTransaction(db,()=>{
    const projectId=id(),stamp=now();
    db.prepare('INSERT INTO projects(id,owner_id,name,type,industry,modules_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(projectId,ownerId,settings.name,settings.type,settings.industry,JSON.stringify(settings.modules),JSON.stringify(settings.settings),stamp,stamp);
    const insertEntity=db.prepare('INSERT INTO project_entities(id,project_id,slug,definition_json,revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?)');
    for(const entity of snapshot.entities)insertEntity.run(id(),projectId,entity.slug,JSON.stringify(entity),stamp,stamp);
    const insertPage=db.prepare('INSERT INTO project_pages(id,project_id,title,slug,description,published,blocks_json,position,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)');
    snapshot.pages.forEach((page,index)=>insertPage.run(id(),projectId,page.title,page.slug,page.description,Number(page.published),JSON.stringify(page.blocks),index,stamp,stamp));
    const insertWorkflow=db.prepare('INSERT INTO project_workflows(id,project_id,definition_json,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)');
    for(const workflow of snapshot.automationPresets)insertWorkflow.run(id(),projectId,JSON.stringify(workflow),stamp,stamp);
    return projectId;
  });
}
export function instantiateTemplate(db,ownerId,templateId,newName,normalizeProject){
  const {snapshot}=templateRow(db,ownerId,templateId);
  return createProjectFromSnapshot(db,ownerId,snapshot,newName,normalizeProject);
}
