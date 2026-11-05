import { randomUUID } from 'node:crypto';
import { normalizeEntity } from '../common/entities.mjs';
import { normalizePage,makeStarterPage } from '../common/pages.mjs';

// Industry packs are declarative. Never contain real customer, payment or medical records.
const baseAccess={read:['admin','manager','staff'],write:['admin','manager','staff']};
const f=(key,label,type='text',required=false,extra={})=>({key,label,type,required,...extra});
const e=(slug,title,description,fields,access=baseAccess)=>({slug,title,description,access,fields});
const choice=(key,label,options,required=true)=>f(key,label,'select',required,{options});
const ref=(key,label,target,required=true)=>f(key,label,'reference',required,{target});
const text=(key,label,required=true)=>f(key,label,'text',required);
const number=(key,label)=>f(key,label,'number',false);
const date=(key,label)=>f(key,label,'date',false);
const catalog={
  restaurant:{label:'Ресторан или кофейня',description:'Гости, визиты, задачи и контроль сервиса',entities:[]},
  dental:{label:'Стоматология',description:'Пациенты, записи и оказанные услуги — без медицинских карт',entities:[
    e('patients','Пациенты','Контакты и запись на приём; не храните диагнозы и медкарты',[text('full_name','ФИО'),text('phone','Телефон'),f('consent','Согласие на связь','boolean',false)]),
    e('appointments','Записи на приём','Расписание и статусы визитов',[ref('patient','Пациент','patients'),date('date','Дата приёма'),text('doctor','Специалист'),choice('status','Статус',['Запланирована','Подтверждена','Завершена','Отменена'])]),
    e('services','Оказанные услуги','Учёт услуг, без медицинской документации',[ref('appointment','Запись','appointments'),text('service','Услуга'),number('price','Стоимость'),choice('status','Оплата',['Ожидается','Учтена','Отменена'])])
  ]},
  auto:{label:'Автосервис',description:'Автомобили, заказ-наряды и запчасти',entities:[
    e('vehicles','Автомобили','Автомобили клиентов',[text('plate','Госномер'),text('make','Марка'),text('model','Модель'),text('owner_phone','Телефон владельца',false)]),
    e('repairs','Заказ-наряды','История обслуживания и статусы работ',[ref('vehicle','Автомобиль','vehicles'),text('work','Вид работ'),choice('status','Статус',['Новый','В работе','Готово','Выдано']),date('due_date','Плановая дата'),number('amount','Стоимость')]),
    e('parts','Запчасти','Каталог и доступное количество',[text('name','Наименование'),text('sku','Артикул'),f('quantity','Остаток','integer',false),number('price','Цена')])
  ]},
  beauty:{label:'Салон красоты',description:'Мастера, бронирования и перечень услуг',entities:[
    e('specialists','Специалисты','Команда салона',[text('name','Имя'),text('specialty','Направление')]),
    e('bookings','Бронирования','Запись клиентов',[ref('specialist','Мастер','specialists'),text('client_name','Клиент'),date('date','Дата'),choice('status','Статус',['Новая','Подтверждена','Завершена','Отмена'])]),
    e('services','Услуги салона','Услуги, длительность и цена',[text('name','Услуга'),f('duration','Минут','integer',false),number('price','Стоимость')])
  ]},
  retail:{label:'Магазин одежды',description:'Поставщики, ассортимент и заказы',entities:[
    e('suppliers','Поставщики','Партнёры по закупкам',[text('name','Компания'),text('contact','Контакт'),text('phone','Телефон',false)]),
    e('products','Товары','Ассортимент и наличие',[text('name','Название'),text('sku','Артикул'),f('stock','Остаток','integer',false),number('price','Цена'),ref('supplier','Поставщик','suppliers',false)]),
    e('orders','Заказы','Заказы и статусы выполнения',[ref('product','Товар','products'),f('quantity','Количество','integer',true),choice('status','Статус',['Новый','Собирается','Выдан','Отменён']),date('date','Дата заказа')])
  ]}
};
export function industryCatalog(){return Object.entries(catalog).map(([id,v])=>({id,label:v.label,description:v.description,entities:v.entities.map(e=>e.title)}));}
export function hasIndustry(industry){return Object.hasOwn(catalog,industry);}
export function industryName(industry){return catalog[industry]?.label||'CRM';}
function blocksFor(industry,modules,entities){
  const def=catalog[industry];
  if(!def)throw Error('Unknown industry');
  if(industry==='restaurant')return [makeStarterPage(modules)];
  const b=(type,data)=>({id:randomUUID(),type,...data});
  const blocks=[b('hero',{eyebrow:'РАБОЧЕЕ ПРОСТРАНСТВО',title:`${def.label} · управление`,subtitle:def.description})];
  if(modules.includes('clients'))blocks.push(b('metric',{metric:'clients_total',label:'Клиентов в общей базе'}));
  if(modules.includes('tasks'))blocks.push(b('metric',{metric:'open_tasks',label:'Открытых задач'}));
  if(entities.length)blocks.push(b('metric',{metric:'entity_count',entity:'custom:'+entities[0].slug,label:entities[0].title+' · всего',layout:'half'}));
  blocks.push(b('button',{label:`+ Добавить: ${entities[0].title.toLowerCase()}`,action:`create:custom:${entities[0].slug}`,style:'primary'}));
  blocks.push(b('table',{title:entities[0].title,entity:`custom:${entities[0].slug}`,columns:entities[0].fields.filter(f=>f.type!=='reference').slice(0,3).map(f=>f.key)}));
  return [normalizePage({title:'Контроль работы',slug:'workspace',description:`Стартовая страница: ${def.label}`,published:true,blocks},modules,entities)];
}
export function createIndustryPack(industry,modules){
  const def=catalog[industry];if(!def)throw Error('Unknown industry');
  // Normalize against full pack so references may point to later entities.
  const entities=def.entities.map(item=>normalizeEntity(item,null,def.entities.filter(x=>x.slug!==item.slug)));
  return {entities,pages:blocksFor(industry,modules,entities)};
}
