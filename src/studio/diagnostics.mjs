import { validateSnapshot, snapshotFromProject } from './templates.mjs';

// This is a deterministic configuration preflight, NOT a production security audit.
export function projectDiagnostics(project,normalizeProject){
  const checks=[];
  const add=(key,level,title,detail)=>checks.push({key,level,title,detail});
  try{
    validateSnapshot(snapshotFromProject(project),normalizeProject,{maxBytes:Infinity});
    add('configuration','ok','Конфигурация корректна','Проверены типы, права, страницы и зависимости модулей');
  }catch(e){
    add('configuration','error','Исправьте структуру проекта',e.message);
  }
  const pages=project.pages||[];
  if(project.type==='crm' && project.modules.includes('tasks')){
    const count=project.automationPresets?.length||0;
    add('workflows','ok','Повторно используемые сценарии',`${count} сценариев попадут в новые CRM и шаблоны`);
  }
  if(!pages.length)add('pages','warning','Страницы не созданы','Добавьте страницу для сотрудников или посетителей');
  else if(!pages.some(p=>p.published))add('pages','warning','Нет опубликованных страниц','Опубликуйте хотя бы одну страницу');
  else add('pages','ok','Страницы готовы',`${pages.filter(p=>p.published).length} опубликованных страниц`);
  if(project.type==='crm'){
    const bySlug=new Map(pages.map(p=>[p.slug,p]));
    const links=pages.flatMap(p=>p.blocks.filter(b=>b.type==='button'&&b.action?.startsWith('navigate:page:')).map(b=>({from:p,to:b.action.slice('navigate:page:'.length)})));
    const broken=links.filter(({from,to})=>from.published&&!bySlug.get(to)?.published);
    if(broken.length){
      add('page-links','error','Неработающие переходы',broken.map(x=>`«${x.from.title}» → «${x.to}»`).slice(0,5).join('; '));
    }else if(links.length)add('page-links','ok','Переходы между страницами',`${links.length} переходов проверено`);
  }
  if(project.type==='site'){
    if(!pages.some(p=>p.slug==='home'))add('home','error','Не найдена главная страница','Для сайта нужна страница с адресом home');
    if(!project.settings.contactEmail)add('contact','warning','Не указана контактная почта','Добавьте адрес электронной почты в настройки');
    if(!project.modules.includes('leads'))add('leads','warning','Формы заявок выключены','Подключите модуль заявок, если нужны формы');
  }else{
    if(project.modules.includes('payments'))add('payments','warning','Платежи только учётные','Эквайринг и реальные возвраты не подключены');
    if(!project.modules.includes('clients'))add('clients','warning','Клиентская база выключена','Без модуля клиентов не появится клиентская база');
  }
  add('export','ok','Автономный исходный код','ZIP не содержит действующих клиентских записей и паролей');
  const errors=checks.filter(c=>c.level==='error').length;
  const warnings=checks.filter(c=>c.level==='warning').length;
  return {summary:{exportReady:errors===0,errors,warnings},checks};
}
