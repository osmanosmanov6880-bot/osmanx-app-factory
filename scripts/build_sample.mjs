import { writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStarterPage, normalizePage } from '../src/common/pages.mjs';
import { normalizeEntity } from '../src/common/entities.mjs';
import { exportProject } from '../src/studio/export.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const id=()=>randomUUID();
const modules=['auth','clients','analytics','tasks','payments'];
const starter=makeStarterPage(modules);
const page2=normalizePage({
  title:'Анкета гостя',slug:'guest-desk',description:'Карточки посетителей и задачи команды',published:true,blocks:[
    {id:id(),type:'hero',eyebrow:'РАБОТА С ГОСТЯМИ',title:'Превращайте визиты в отношения.',subtitle:'Сохраняйте контакт гостя, чтобы лучше понимать сервис и возвращаемость.'},
    {id:id(),type:'form',title:'Новый гость',entity:'clients',fields:['full_name','phone','email','source','notes'],submitLabel:'Сохранить гостя'},
    {id:id(),type:'table',title:'Последние гости',entity:'clients',columns:['full_name','phone','email','source']},
    {id:id(),type:'metric',label:'Зарегистрировано визитов',metric:'visits_total'},
    {id:id(),type:'button',label:'Задачи команды',action:'navigate:tasks',style:'secondary'}
  ]},modules);
const suppliers=normalizeEntity({slug:'suppliers',title:'Поставщики',description:'Контрагенты и контакты',access:{read:['admin','manager','staff'],write:['admin','manager']},fields:[
 {key:'company',label:'Компания',type:'text',required:true},
 {key:'phone',label:'Телефон',type:'text',required:false},
 {key:'active',label:'Активен',type:'boolean',required:true}
]});
const orders=normalizeEntity({slug:'orders',title:'Закупки',description:'Заказы у поставщиков',access:{read:['admin','manager','staff'],write:['admin','manager']},fields:[
 {key:'title',label:'Название закупки',type:'text',required:true},
 {key:'supplier',label:'Поставщик',type:'reference',target:'suppliers',required:true},
 {key:'status',label:'Статус',type:'select',options:['Новая','В работе','Получено'],required:true},
 {key:'quantity',label:'Количество',type:'integer',required:false},
 {key:'due_date',label:'Плановая дата',type:'date',required:false}
]},null,[suppliers]);
const entities=[suppliers,orders];
const page3=normalizePage({title:'Закупки и поставщики',slug:'purchases',description:'Настраиваемая страница закупок с настоящими таблицами',published:true,blocks:[
 {id:id(),type:'hero',eyebrow:'ЗАКУПКИ РЕСТОРАНА',title:'Все закупки под контролем.',subtitle:'Свяжите поставщиков и заказы. Всё хранится в вашей базе данных.'},
 {id:id(),type:'form',title:'Добавить поставщика',entity:'custom:suppliers',fields:['company','phone','active'],submitLabel:'Сохранить поставщика'},
 {id:id(),type:'form',title:'Создать закупку',entity:'custom:orders',fields:['title','supplier','status','quantity','due_date'],submitLabel:'Сохранить закупку'},
 {id:id(),type:'table',title:'Реестр закупок',entity:'custom:orders',columns:['title','supplier','status','quantity','due_date']},
 {id:id(),type:'button',label:'Открыть все закупки',action:'navigate:custom:orders',style:'secondary'}
]},modules,entities);
const stamp=new Date().toISOString();
const project={id:id(),name:'OSMANX · Restaurant CRM',type:'crm',industry:'restaurant',modules,
 settings:{accent:'#386f61',primaryAction:'new_client',currency:'RUB'},
 createdAt:stamp,updatedAt:stamp,entities:entities.map(e=>({...e,id:id(),revision:1,createdAt:stamp,updatedAt:stamp})),pages:[starter,page2,page3].map((p,i)=>({...p,id:id(),position:i,revision:1,createdAt:stamp,updatedAt:stamp}))};
const target=process.argv[2]||resolve(root,'../OSMANX_RESTAURANT_CRM_R04_STANDALONE.zip');
const release={id:id(),sequence:1,notes:'Первая демонстрационная версия',createdAt:stamp,snapshotSha256:createHash('sha256').update(JSON.stringify(project)).digest('hex')};
const buffer=await exportProject(project,root,release);
await writeFile(target,buffer);
console.log('Wrote '+target+' ('+buffer.length+' bytes), pages: '+project.pages.length+', entities: '+project.entities.length);
