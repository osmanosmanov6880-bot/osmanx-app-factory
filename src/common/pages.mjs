import { randomUUID } from 'node:crypto';
import { bad } from './http.mjs';

// Strict, versioned contract between Studio, CRM runtime and portable ZIP exports.
// A page never stores executable JavaScript, SQL, HTML, URLs or arbitrary API targets.
export const PAGE_SCHEMA_VERSION=4;
export const PAGE_BLOCK_TYPES=['hero','text','metric','button','form','table','divider'];
export const PAGE_ENTITIES={
  clients:{module:'clients',required:'full_name',fields:['full_name','phone','email','source','notes'],defaults:['full_name','phone','email','source']},
  tasks:{module:'tasks',required:'title',fields:['title','description','priority','due_at'],defaults:['title','description','priority']}
};
export const PAGE_METRICS={
  clients_total:{module:'clients',roles:['admin','manager','staff']},
  visits_total:{module:'clients',roles:['admin','manager','staff']},
  open_tasks:{module:'tasks',roles:['admin','manager','staff']},
  repeat_share:{module:'analytics',roles:['admin','manager']},
  paid_minor:{module:'payments',roles:['admin','manager']}
};
export const PAGE_ACTIONS={
  'navigate:dashboard':{module:'auth'},'navigate:clients':{module:'clients'},
  'navigate:visits':{module:'clients'},'navigate:tasks':{module:'tasks'},
  'navigate:payments':{module:'payments',roles:['admin','manager']},
  'navigate:analytics':{module:'analytics',roles:['admin','manager']},
  'create:clients':{module:'clients'},'create:tasks':{module:'tasks'},
  'create:visits':{module:'clients'},'create:payments':{module:'payments',roles:['admin','manager']},
  'notice':{module:'auth'}
};
const isRecord=o=>o!==null&&typeof o==='object'&&!Array.isArray(o);
function str(input,field,max,{required=true}={}){
  if(typeof input!=='string')bad(400,`Поле «${field}» должно быть строкой`);
  const v=input.trim();
  if((required&&!v)||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v))bad(400,`Некорректное поле «${field}» (максимум ${max} символов)`);
  return v;
}
function choice(value,values,label){if(typeof value!=='string'||!values.includes(value))bad(400,`Недопустимое значение «${label}»`);return value;}
function available(module,modules){return modules.includes(module);}
function entity(value,modules,customEntities=[]){
  if(typeof value==='string' && value.startsWith('custom:')){
    const found=customEntities.find(e=>'custom:'+e.slug===value);
    if(!found)bad(400,'Пользовательская сущность не существует');
    return value;
  }
  const name=choice(value,Object.keys(PAGE_ENTITIES),'сущность');
  if(!available(PAGE_ENTITIES[name].module,modules))bad(400,`Модуль ${name} не подключён`);
  return name;
}
function fieldSet(value,name,label,customEntities=[],form=false){
  const custom=name.startsWith('custom:')?customEntities.find(e=>e.slug===name.slice(7)):null;
  const spec=custom?{
    fields:custom.fields.map(f=>f.key),
    requiredFields:form?custom.fields.filter(f=>f.required).map(f=>f.key):[]
  }: {fields:PAGE_ENTITIES[name].fields,requiredFields:[PAGE_ENTITIES[name].required]};
  if(!Array.isArray(value)||value.length<1||value.length>spec.fields.length||value.some(f=>!spec.fields.includes(f))||new Set(value).size!==value.length||spec.requiredFields.some(f=>!value.includes(f)))
    bad(400,`Некорректные поля «${label}»: добавьте все обязательные поля`);
  return value.slice();
}

function block(input,modules,customEntities=[]){
  if(!isRecord(input))bad(400,'Блок должен быть объектом');
  const type=choice(input.type,PAGE_BLOCK_TYPES,'тип блока');
  const blockId=str(input.id,'id блока',64);
  if(!/^[a-zA-Z0-9_-]{8,64}$/.test(blockId))bad(400,'Некорректный id блока');
  const layout=choice(input.layout??(type==='metric'?'half':'wide'),['wide','half','third'],'ширина блока');
  if(type==='divider'&&layout!=='wide')bad(400,'Разделитель должен занимать всю ширину');
  if(['hero','form','table'].includes(type)&&layout==='third')bad(400,'Этот блок слишком узкий для одной трети страницы');
  const common={id:blockId,type,layout};
  switch(type){
    case 'hero':return {...common,eyebrow:str(input.eyebrow??'','Надпись',40,{required:false}),title:str(input.title,'Заголовок',110),subtitle:str(input.subtitle??'','Подзаголовок',320,{required:false})};
    case 'text':return {...common,title:str(input.title,'Заголовок',110),body:str(input.body??'','Текст',1500,{required:false})};
    case 'metric':{
      const metric=choice(input.metric,[...Object.keys(PAGE_METRICS),'entity_count'],'метрика');
      if(metric==='entity_count'){
        const source=entity(input.entity,modules,customEntities);
        if(!source.startsWith('custom:'))bad(400,'Счётчик записей выбирается из пользовательских таблиц');
        return {...common,metric,entity:source,label:str(input.label,'Название показателя',80)};
      }
      if(!available(PAGE_METRICS[metric].module,modules))bad(400,'Метрика недоступна без модуля');
      return {...common,metric,label:str(input.label,'Название показателя',80)};
    }
    case 'button':{
      let action;
      if(typeof input.action==='string' && /^(create|navigate):custom:[a-z][a-z0-9_]{1,31}$/.test(input.action)){
        const slug=input.action.split(':')[2];
        if(!customEntities.some(e=>e.slug===slug))bad(400,'Действие ссылается на неизвестную сущность');
        action=input.action;
      } else if(typeof input.action==='string' && /^navigate:page:[a-z][a-z0-9-]{1,47}$/.test(input.action)){
        if(input.action.endsWith('-'))bad(400,'Некорректная ссылка на страницу');
        action=input.action;
      } else {
        action=choice(input.action,Object.keys(PAGE_ACTIONS),'действие');
        if(!available(PAGE_ACTIONS[action].module,modules))bad(400,'Действие недоступно без модуля');
      }
      const roles=input.roles===undefined?['admin','manager','staff']:input.roles;
      if(!Array.isArray(roles)||roles.length<1||roles.length>3||new Set(roles).size!==roles.length||roles.some(r=>!['admin','manager','staff'].includes(r)))
        bad(400,'Выберите допустимые роли для кнопки');
      const confirm=input.confirm===undefined?false:input.confirm;
      if(typeof confirm!=='boolean')bad(400,'Некорректное подтверждение действия');
      const confirmText=str(input.confirmText??'','Текст подтверждения',180,{required:false});
      const message=str(input.message??'','Текст уведомления',180,{required:false});
      if(action==='notice'&&!message)bad(400,'Укажите текст уведомления для кнопки');
      return {...common,label:str(input.label,'Текст кнопки',80),action,style:choice(input.style??'primary',['primary','secondary'],'стиль'),roles,confirm,confirmText,message:action==='notice'?message:''};
    }
    case 'form':{
      const source=entity(input.entity,modules,customEntities);
      return {...common,title:str(input.title,'Заголовок формы',110),entity:source,fields:fieldSet(input.fields,source,'формы',customEntities,true),submitLabel:str(input.submitLabel,'Текст отправки',80),successText:str(input.successText??'Запись добавлена','Уведомление после отправки',120)};
    }
    case 'table':{
      const source=entity(input.entity,modules,customEntities);
      const limit=input.limit===undefined?10:input.limit;
      if(![5,10,20].includes(limit))bad(400,'Количество строк таблицы: 5, 10 или 20');
      return {...common,title:str(input.title,'Название таблицы',110),entity:source,columns:fieldSet(input.columns,source,'таблицы',customEntities,false),limit};
    }
    case 'divider':return common;
  }
}
export function normalizePage(input,modules,customEntities=[]){
  if(!isRecord(input))bad(400,'Ожидается конфигурация страницы');
  const title=str(input.title,'Название страницы',80);
  const slug=str(input.slug,'URL страницы',48);
  if(!/^[a-z][a-z0-9-]{1,47}$/.test(slug)||slug.endsWith('-')||['dashboard','clients','visits','tasks','payments','analytics','team','settings'].includes(slug))bad(400,'URL страницы: латиница, цифры, дефис; не используйте системное название');
  const description=str(input.description??'','Описание страницы',240,{required:false});
  if(typeof input.published!=='boolean')bad(400,'Статус публикации должен быть логическим значением');
  const blocks=input.blocks;
  if(!Array.isArray(blocks)||blocks.length>30)bad(400,'Страница может содержать не более 30 блоков');
  const result=blocks.map(b=>block(b,modules,customEntities));
  if(new Set(result.map(b=>b.id)).size!==result.length)bad(400,'Повторяющиеся идентификаторы блоков');
  return {schemaVersion:PAGE_SCHEMA_VERSION,title,slug,description,published:input.published,blocks:result};
}
export function pageFromRow(row){return row&&{id:row.id,title:row.title,slug:row.slug,description:row.description,published:!!row.published,
  schemaVersion:PAGE_SCHEMA_VERSION,blocks:JSON.parse(row.blocks_json),position:row.position,revision:row.revision,
  createdAt:row.created_at,updatedAt:row.updated_at};}
export function listPages(db,projectId){return db.prepare('SELECT * FROM project_pages WHERE project_id=? ORDER BY position ASC,created_at ASC').all(projectId).map(pageFromRow);}
export function makeStarterPage(modules){
  const b=(type,data)=>({id:randomUUID(),type,...data});
  const blocks=[b('hero',{eyebrow:'ГОСТЕВОЙ СЕРВИС',title:'Гости — в центре внимания.',subtitle:'Персональная страница для команды ресторана. Настройте каждый блок в редакторе OSMANX.'})];
  if(modules.includes('clients'))blocks.push(b('metric',{label:'Гостей в базе',metric:'clients_total'}));
  if(modules.includes('tasks'))blocks.push(b('metric',{label:'Открытых задач',metric:'open_tasks'}));
  if(modules.includes('clients'))blocks.push(b('button',{label:'+ Добавить гостя',action:'create:clients',style:'primary'}));
  if(modules.includes('clients'))blocks.push(b('table',{title:'Гости ресторана',entity:'clients',columns:['full_name','phone','source']}));
  else if(modules.includes('tasks'))blocks.push(b('table',{title:'Поручения',entity:'tasks',columns:['title','priority','due_at']}));
  return normalizePage({title:'Контроль сервиса',slug:'service',description:'Рабочая страница с данными ресторана',published:true,blocks},modules);
}
