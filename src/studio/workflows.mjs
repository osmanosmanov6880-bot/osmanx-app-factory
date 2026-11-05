import { bad } from '../common/http.mjs';
import { id, now, shortText } from '../common/security.mjs';
import { normalizeAutomationPreset, simulatePreset } from '../crm/automations.mjs';

export const MAX_WORKFLOWS=30;
export function listWorkflows(db,projectId){
  return db.prepare('SELECT * FROM project_workflows WHERE project_id=? ORDER BY created_at,id').all(projectId).map(r=>({
    id:r.id,...JSON.parse(r.definition_json),revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at
  }));
}
export function createWorkflow(db,project,input){
  if(project.type!=='crm')bad(400,'Сценарии доступны только для CRM');
  if(listWorkflows(db,project.id).length>=MAX_WORKFLOWS)bad(409,'Максимум 30 сценариев в проекте');
  const rule=normalizeAutomationPreset(input,project.entities,project.modules);
  const uid=id(),stamp=now();
  db.prepare('INSERT INTO project_workflows(id,project_id,definition_json,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)')
    .run(uid,project.id,JSON.stringify(rule),stamp,stamp);
  return listWorkflows(db,project.id).find(w=>w.id===uid);
}
export function updateWorkflow(db,project,workflowId,input){
  const current=listWorkflows(db,project.id).find(x=>x.id===workflowId);
  if(!current)bad(404,'Сценарий не найден');
  if(input.revision!==current.revision)bad(409,'Сценарий изменён в другой вкладке. Обновите список');
  const rule=normalizeAutomationPreset(input,project.entities,project.modules);
  const result=db.prepare('UPDATE project_workflows SET definition_json=?,revision=revision+1,updated_at=? WHERE id=? AND project_id=? AND revision=?')
    .run(JSON.stringify(rule),now(),workflowId,project.id,current.revision);
  if(result.changes!==1)bad(409,'Сценарий обновлён другим пользователем');
  return listWorkflows(db,project.id).find(x=>x.id===workflowId);
}
export function deleteWorkflow(db,projectId,workflowId){
  const change=db.prepare('DELETE FROM project_workflows WHERE id=? AND project_id=?').run(workflowId,projectId).changes;
  if(!change)bad(404,'Сценарий не найден');
}
export function previewWorkflow(project,input){
  const rule=normalizeAutomationPreset(input.rule,project.entities,project.modules);
  const sample=input.sample||{};
  // A preview evaluates only input sample values, without opening customer databases.
  return simulatePreset(rule,{event:sample.event||rule.event,entitySlug:sample.entitySlug??rule.entity_slug,recordValues:sample.recordValues||{}});
}
