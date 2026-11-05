/**
 * Generate a fresh, data-free standalone CRM archive from an industry pack.
 * Usage: node scripts/build_industry_sample.mjs dental /absolute/output.zip
 */
import { writeFile } from 'node:fs/promises';
import { randomUUID,createHash } from 'node:crypto';
import { normalizePage } from '../src/common/pages.mjs';
import { dirname,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIndustryPack,industryName,hasIndustry } from '../src/studio/industries.mjs';
import { exportProject } from '../src/studio/export.mjs';
import { normalizeAutomationPreset } from '../src/crm/automations.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const industry=process.argv[2]||'dental';
if(!hasIndustry(industry))throw new Error(`Unknown industry: ${industry}`);
const target=process.argv[3]||resolve(root,`../OSMANX_${industry.toUpperCase()}_CRM_R13.zip`);
const modules=['auth','clients','tasks','analytics','payments'];
const pack=createIndustryPack(industry,modules);
const now=new Date().toISOString();
// Reusable editable demo pages. These are code-free actions, not JS handlers:
// opening another published page and showing an in-app notice.
const main=pack.pages[0];
const first=normalizePage({...main,blocks:[...main.blocks,{
  id:randomUUID(),type:'button',label:'Памятка для команды',action:'navigate:page:team-guide',
  style:'secondary',roles:['admin','manager'],confirm:true,
  confirmText:'Открыть инструкцию для команды?'
}]},modules,pack.entities);
const guide=normalizePage({title:'Памятка для команды',slug:'team-guide',
  description:'Образец собственной страницы CRM и действий кнопок без программирования',published:true,blocks:[
    {id:randomUUID(),type:'hero',eyebrow:'ПРИМЕР РАБОЧЕЙ СТРАНИЦЫ',title:'Правила работы команды',subtitle:'Эту страницу и действия можно изменить в мастерской фабрики.'},
    {id:randomUUID(),type:'text',title:'Начните с клиента',body:'Добавьте запись, назначьте ответственному задачу и проверьте автоматические сценарии. Данные из этого шаблона не содержат реальных клиентов.'},
    {id:randomUUID(),type:'button',label:'Понятно, продолжить работу',action:'notice',message:'Готово! Теперь можно открыть остальные разделы CRM.',style:'primary',roles:['admin','manager','staff'],confirm:false}
]},modules,pack.entities);
pack.pages=[first,...pack.pages.slice(1),guide];
// A real, editable starter rule for each industry. Rules contain configuration only.
const starterRules={
  restaurant:{name:'Первый контакт',event:'client_created',task_title:'Позвонить новому гостю',priority:'medium',due_days:1},
  dental:{name:'Подтверждённый приём',event:'entity_created',entity_slug:'appointments',condition_field:'status',condition_value:'Подтверждена',task_title:'Подготовить приём: {{doctor}}',priority:'high',due_days:1},
  auto:{name:'Новый заказ-наряд',event:'entity_created',entity_slug:'repairs',condition_field:'status',condition_value:'Новый',task_title:'Назначить мастера: {{work}}',priority:'high',due_days:1},
  beauty:{name:'Запись подтверждена',event:'entity_created',entity_slug:'bookings',condition_field:'status',condition_value:'Подтверждена',task_title:'Подготовиться к записи: {{client_name}}',priority:'medium',due_days:1},
  retail:{name:'Новый заказ',event:'entity_created',entity_slug:'orders',condition_field:'status',condition_value:'Новый',task_title:'Собрать заказ',priority:'high',due_days:1}
};
const demoRule=normalizeAutomationPreset(starterRules[industry],pack.entities,modules);
const project={
  id:randomUUID(),name:`OSMANX · ${industryName(industry)}`,
  type:'crm',industry,modules,automationPresets:[demoRule],
  settings:{accent:'#C7A476',currency:'RUB',primaryAction:'new_client'},
  createdAt:now,updatedAt:now,
  entities:pack.entities.map(entity=>({...entity,id:randomUUID(),revision:1,createdAt:now,updatedAt:now})),
  pages:pack.pages.map((page,i)=>({...page,id:randomUUID(),revision:1,position:i,createdAt:now,updatedAt:now}))
};
const release={id:randomUUID(),sequence:1,notes:'Демонстрационный шаблон R1.3: сценарий и кнопки без кода; без клиентских данных',createdAt:now,snapshotSha256:createHash('sha256').update(JSON.stringify(project)).digest('hex')};
const zip=await exportProject(project,root,release);
await writeFile(target,zip);
console.log(`${industry} standalone: ${target} ${zip.length} bytes, ${project.entities.length} entities, ${project.pages.length} pages, ${project.automationPresets.length} workflow`);
