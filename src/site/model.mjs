import { randomUUID } from 'node:crypto';
import { bad } from '../common/http.mjs';
import { validateEmail } from '../common/security.mjs';

const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function string(v,label,max,required=true){
  if(typeof v!=='string'||v.trim().length>max||(required&&!v.trim())||/[\u0000-\u001f]/.test(v))bad(400,`Некорректное поле «${label}»`);
  return v.trim();
}
const blockId=v=>{const k=string(v,'ID блока',64);if(!/^[a-zA-Z0-9_-]{8,64}$/.test(k))bad(400,'Некорректный ID блока');return k;};
function safeHref(v){
  const href=string(v,'Ссылка',300);
  if(!(/^(\/(?!\/)[a-zA-Z0-9\-/_#?=&.%]*)$/.test(href)||/^https:\/\/[a-zA-Z0-9.-]+(?::443)?(?:\/[a-zA-Z0-9\-/_#?=&.%]*)?$/.test(href)))bad(400,'Разрешены только внутренние ссылки /... и защищённые HTTPS URL');
  return href;
}
export const SITE_BLOCK_TYPES=['hero','text','features','button','form','divider'];
export function normalizeSitePage(input,modules=['auth','cms','leads']){
  if(!record(input))bad(400,'Некорректная страница');
  const title=string(input.title,'Название страницы',80);
  const slug=string(input.slug,'URL страницы',48);
  if(!/^[a-z][a-z0-9-]{1,47}$/.test(slug)||slug.endsWith('-')||['admin','api','assets','workspace','robots','sitemap','health','favicon'].includes(slug))bad(400,'Недопустимый URL страницы');
  const description=string(input.description??'','Описание страницы',240,false);
  if(typeof input.published!=='boolean')bad(400,'Укажите публикацию страницы');
  if(!Array.isArray(input.blocks)||input.blocks.length>30)bad(400,'Максимум 30 блоков');
  const blocks=input.blocks.map(b=>{
    if(!record(b)||!SITE_BLOCK_TYPES.includes(b.type))bad(400,'Неподдерживаемый блок сайта');
    const layout=b.layout??'wide';
    if(!['wide','half','third'].includes(layout))bad(400,'Недопустимая ширина блока сайта');
    if(b.type==='divider'&&layout!=='wide')bad(400,'Разделитель занимает всю ширину');
    if(['hero','form'].includes(b.type)&&layout==='third')bad(400,'Этот блок сайта слишком узкий для одной трети страницы');
    const head={id:blockId(b.id),type:b.type,layout};
    if(b.type==='hero')return {...head,eyebrow:string(b.eyebrow??'','Надпись',40,false),title:string(b.title,'Заголовок',110),subtitle:string(b.subtitle??'','Подзаголовок',320,false)};
    if(b.type==='text')return {...head,title:string(b.title,'Заголовок блока',110),body:string(b.body??'','Текст блока',1500,false)};
    if(b.type==='button')return {...head,label:string(b.label,'Надпись кнопки',80),href:safeHref(b.href),style:['primary','secondary'].includes(b.style)?b.style:'primary'};
    if(b.type==='features'){
      if(!Array.isArray(b.items)||b.items.length<1||b.items.length>6)bad(400,'От 1 до 6 преимуществ');
      return {...head,title:string(b.title,'Название блока',110),items:b.items.map(i=>{
        if(!record(i))bad(400,'Некорректное преимущество');
        return {title:string(i.title,'Преимущество',80),body:string(i.body??'','Описание',240,false)};
      })};
    }
    if(b.type==='form'){
      if(!modules.includes('leads'))bad(400,'Подключите модуль заявок для формы');
      return {...head,title:string(b.title,'Заголовок формы',110),submitLabel:string(b.submitLabel,'Кнопка формы',80)};
    }
    return head;
  });
  if(new Set(blocks.map(b=>b.id)).size!==blocks.length)bad(400,'Повторяются ID блоков');
  return {title,slug,description,published:input.published,blocks,schemaVersion:2};
}
export const siteBlock=(type,data={})=>({id:randomUUID(),type,...data});
export function makeSitePages(name='Новая компания',modules=['auth','cms','leads']){
  const pages=[
    {title:'Главная',slug:'home',description:'Официальный сайт компании — услуги, преимущества и форма связи',published:true,blocks:[
      siteBlock('hero',{eyebrow:'КАЧЕСТВО И ДОВЕРИЕ',title:'Решения, которые работают на ваш бизнес.',subtitle:'Профессиональный подход, понятные процессы и внимание к каждой задаче. Замените этот демонстрационный текст данными компании.'}),
      siteBlock('text',{title:'01 / О компании',body:'Покажите ваше главное преимущество простыми словами. Этот блок можно редактировать, перетаскивать и менять его ширину.',layout:'half'}),
      siteBlock('text',{title:'02 / Наш подход',body:'Добавьте понятное объяснение того, что получит клиент и как вы работаете. На телефоне блоки располагаются друг под другом.',layout:'half'}),
      siteBlock('button',{label:'Обсудить задачу',href:'/contacts',style:'primary'}),
      siteBlock('features',{title:'Наш подход',items:[{title:'Прозрачность',body:'Объясняем решения понятным языком.'},{title:'Внимание к деталям',body:'Учитываем контекст и реальные задачи клиента.'},{title:'Ответственность',body:'Фиксируем этапы, сроки и ожидаемый результат.'}]})
    ]},
    {title:'Услуги',slug:'services',description:'Основные направления деятельности компании',published:true,blocks:[
      siteBlock('hero',{eyebrow:'НАПРАВЛЕНИЯ',title:'Услуги компании',subtitle:'Редактируйте разделы и преимущества в конструкторе OSMANX.'}),
      siteBlock('text',{title:'Индивидуальная работа',body:'Опишите здесь действительные услуги и условия вашей компании. Не публикуйте неподтверждённые обещания.'}),
      siteBlock('button',{label:'Запросить консультацию',href:'/contacts',style:'primary'})
    ]},
    {title:'Контакты',slug:'contacts',description:'Связь с компанией, отправка обращения',published:true,blocks:[
      siteBlock('hero',{eyebrow:'НА СВЯЗИ',title:'Давайте обсудим вашу задачу.',subtitle:'Заполните форму — обращение появится в защищённой административной панели.'}),
      modules.includes('leads')?siteBlock('form',{title:'Написать нам',submitLabel:'Отправить обращение'}):siteBlock('text',{title:'Контактная информация',body:'Укажите здесь номер телефона и адрес электронной почты компании.'})
    ]}
  ];
  return pages.map(p=>normalizeSitePage(p,modules));
}
export function siteSettings(input,existing={}){
  if(!record(input))bad(400,'Ожидается объект настроек');
  const accent=string(input.accent??existing.accent??'#d0a976','Цвет',7);
  if(!/^#[0-9a-fA-F]{6}$/.test(accent))bad(400,'Цвет должен быть в формате #RRGGBB');
  const contactEmail=string(input.contactEmail??existing.contactEmail??'','Почта контактов',254,false);
  if(contactEmail)validateEmail(contactEmail);
  return {accent:accent.toLowerCase(),tagline:string(input.tagline??existing.tagline??'','Подпись',100,false),contactEmail};
}
export const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderWebsite(page,pages,config,base=''){
  const h=escapeHtml;
  const settings=config.settings||{};
  const brand=h(config.name||'Компания');
  const color=/^#[0-9a-f]{6}$/i.test(settings.accent)?settings.accent:'#d0a976';
  const local=href=>href.startsWith('/')?base+href:href;
  const nav=pages.filter(x=>x.published).map(x=>`<a class="${x.slug===page.slug?'active':''}" href="${h(base+(x.slug==='home'?'/':'/'+x.slug))}">${h(x.title)}</a>`).join('');
  const blocks=page.blocks.map((b,i)=>{
    const cell=(html)=>`<div class="site-layout-item site-span-${['wide','half','third'].includes(b.layout)?b.layout:'wide'}">${html}</div>`;
    if(b.type==='hero')return cell(`<section class="hero"><p class="eyebrow">${h(b.eyebrow)}</p><h1>${h(b.title)}</h1><p class="hero-description">${h(b.subtitle)}</p></section>`);
    if(b.type==='text')return cell(`<section class="copy"><span class="section-number">${String(page.blocks.slice(0,i+1).filter(x=>x.type==='text').length).padStart(2,'0')}</span><div><h2>${h(b.title)}</h2><p>${h(b.body)}</p></div></section>`);
    if(b.type==='features')return cell(`<section class="features"><div class="section-heading"><span class="eyebrow">ЧТО ВАЖНО</span><h2>${h(b.title)}</h2></div><div class="feature-grid">${b.items.map((x,n)=>`<article class="feature"><span>0${n+1} /</span><h3>${h(x.title)}</h3><p>${h(x.body)}</p></article>`).join('')}</div></section>`);
    if(b.type==='button')return cell(`<section class="cta-row"><a class="cta ${b.style==='secondary'?'secondary':''}" href="${h(local(b.href))}" ${b.href.startsWith('https://')?'rel="noopener noreferrer"':''}>${h(b.label)} <span aria-hidden="true">↗</span></a></section>`);
    if(b.type==='form')return cell(`<section class="contact-panel"><div><span class="eyebrow">НАПИШИТЕ НАМ</span><h2>${h(b.title)}</h2><p>Ваше сообщение попадёт напрямую в панель управления сайтом.</p></div><form class="lead-form" data-site-lead="${h(page.slug)}" data-api="${h(base)}/api/site/leads"><label>Ваше имя<input name="name" required maxlength="120" autocomplete="name"></label><div class="form-grid"><label>Телефон<input name="phone" maxlength="40" autocomplete="tel"></label><label>Электронная почта<input name="email" type="email" maxlength="254" autocomplete="email"></label></div><label>Сообщение<textarea name="message" rows="4" maxlength="1500"></textarea></label><label class="honeypot" aria-hidden="true">Оставьте поле пустым<input name="website" tabindex="-1" autocomplete="off"></label><button class="cta" type="submit">${h(b.submitLabel)} <span aria-hidden="true">↗</span></button><p class="form-message" role="status"></p><small>Отправляя обращение, вы соглашаетесь на использование указанных данных для ответа. Уточните условия обработки данных перед публикацией сайта.</small></form></section>`);
    return cell(`<div class="block-divider"></div>`);
  }).join('');
  const title=h(page.title==='Главная'?config.name:`${page.title} — ${config.name}`);
  const description=h(page.description||settings.tagline||config.name);
  const productionUrl=process.env.PUBLIC_SITE_URL;
  const hasProductionUrl=typeof productionUrl==='string'&&/^https:\/\/[a-zA-Z0-9.-]+(?::443)?$/.test(productionUrl);
  const absoluteUrl=hasProductionUrl?`${productionUrl}${base}${page.slug==='home'?'/':'/'+page.slug}`:null;
  const seo=absoluteUrl?`<link rel="canonical" href="${h(absoluteUrl)}"><meta property="og:url" content="${h(absoluteUrl)}">`:'<meta name="robots" content="noindex,nofollow">';
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${description}">${seo}<meta name="theme-color" content="#111216"><meta property="og:type" content="website"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><title>${title}</title><link rel="stylesheet" href="${h(base)}/assets/site.css"><link rel="stylesheet" href="${h(base)}/assets/theme.css"></head><body><div class="site-shell"><header class="site-header"><a class="wordmark" href="${h(base)}/"><span class="brand-symbol">O<span class="dot">.</span></span><span>${brand}</span></a><nav aria-label="Главная навигация">${nav}</nav><a class="header-contact" href="${h(base)}/contacts">Связаться <span>↗</span></a></header><main class="site-layout">${blocks}</main><footer class="site-footer"><span>${brand}</span><span>${h(settings.tagline||'Создано на OSMANX APP FACTORY')}</span><small>© ${new Date().getUTCFullYear()}</small></footer></div><script src="${h(base)}/assets/site.js" defer></script></body></html>`;
}
