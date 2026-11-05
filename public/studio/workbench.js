// Unified project workbench: one owner-scoped console for pages, data, actions,
// workflow presets, and export preflight. Complex edits use the existing editors.
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tabs=[['overview','Главное','◈'],['pages','Страницы','▤'],['data','Данные','▦'],['actions','Кнопки','↗'],['workflows','Сценарии','⚡'],['release','Выпуск','✓']];
const count=(n,single,plural)=>`${n} ${n===1?single:plural}`;
const button=(label,action,extra='')=>`<button class="oxw-small-btn" type="button" data-oxw-action="${action}" ${extra}>${esc(label)} <span aria-hidden="true">↗</span></button>`;
const pill=(label,good=true)=>`<span class="oxw-pill ${good?'oxw-pill-ok':'oxw-pill-muted'}">${esc(label)}</span>`;
function actionName(action){
 if(action==='notice')return 'Показать уведомление';
 if(action?.startsWith('navigate:page:'))return 'Открыть страницу /'+action.slice(14);
 if(action?.startsWith('create:custom:'))return 'Новая запись · '+action.slice(14);
 if(action?.startsWith('navigate:custom:'))return 'Открыть таблицу · '+action.slice(16);
 return ({'create:clients':'Добавить клиента','create:tasks':'Создать задачу','create:visits':'Добавить визит','create:payments':'Учесть оплату','navigate:clients':'Открыть клиентов','navigate:tasks':'Открыть задачи','navigate:dashboard':'Открыть обзор','navigate:analytics':'Открыть аналитику','navigate:payments':'Открыть оплаты','navigate:visits':'Открыть визиты'})[action]||action||'Нет действия';
}
export function initProjectWorkbench({api,toast,editPage,editData,editWorkflow,showReleases,showSettings,openDeployment}){
 const overlay=$('workbenchOverlay');
 const S={id:null,tab:'overview',project:null,diagnostics:null,releases:[],busy:false};
 function close(){overlay.hidden=true;S.id=null;S.project=null;document.body.classList.remove('oxw-open');}
 async function open(id,tab='overview'){
   S.id=id;S.tab=tab;overlay.hidden=false;document.body.classList.add('oxw-open');
   $('oxwContent').innerHTML='<div class="oxw-loading">Открываем мастерскую проекта…</div>';
   await refresh();
 }
 async function refresh(){
   if(!S.id)return;const current=S.id;
   try{
     const data=await api(`/api/studio/projects/${current}/workbench`);
     if(S.id!==current)return;
     S.project=data.project;S.diagnostics=data.diagnostics;S.releases=data.releases||[];
     $('oxwTitle').textContent=data.project.name;
     $('oxwSubtitle').textContent=(data.project.type==='site'?'Корпоративный сайт':'Бизнес-CRM')+' · Все настройки одного проекта';
     render();
   }catch(err){toast(err.message,true);close();}
 }
 function overview(){
   const p=S.project,d=S.diagnostics;
   const actions=p.pages.flatMap(pg=>pg.blocks.filter(b=>b.type==='button'));
   const stats=[['Страницы',p.pages.length,'pages'],['Таблицы',p.entities.length,'data'],['Действия',actions.length,'actions'],['Сценарии',p.automationPresets.length,'workflows']];
   return `<div class="oxw-intro"><div><span class="oxw-eyebrow">СТРУКТУРА ПРОЕКТА</span><h2>Всё для запуска. <em>В одном месте.</em></h2><p>Настройте данные, страницы, поведение кнопок и сценарии. Каждый раздел связан с вашим приложением — без демонстрационных заглушек.</p></div><div class="oxw-intro-mark">O<span>✦</span></div></div>
    <div class="oxw-stats">${stats.map(([title,num,tab])=>`<button type="button" data-oxw-tab="${tab}"><strong>${num}</strong><span>${title}</span><small>Открыть →</small></button>`).join('')}</div>
    <div class="oxw-dual"><section class="oxw-surface"><span class="oxw-eyebrow">КАК НАСТРАИВАТЬ</span><h3>От идеи до приложения</h3><ol class="oxw-steps"><li><b>01</b><span><strong>Данные</strong><small>Какие записи будут храниться в CRM</small></span></li><li><b>02</b><span><strong>Страницы и кнопки</strong><small>Какие экраны увидит сотрудник и что произойдёт при нажатии</small></span></li><li><b>03</b><span><strong>Сценарии</strong><small>Какие задачи CRM выполнит автоматически</small></span></li><li><b>04</b><span><strong>Проверка и выпуск</strong><small>Проверенный ZIP с независимым кодом</small></span></li></ol></section>
    <section class="oxw-surface"><span class="oxw-eyebrow">ГОТОВНОСТЬ К ЭКСПОРТУ</span><h3>${d.summary.errors?'Нужны исправления':'Структура проверена'}</h3><div class="oxw-health ${d.summary.errors?'bad':''}">${d.summary.errors?'!':'✓'} <span>${d.summary.errors?count(d.summary.errors,'ошибка','ошибок'):'Критических ошибок нет'}</span></div><p class="oxw-note">${d.summary.warnings?count(d.summary.warnings,'предупреждение','предупреждений')+'. Они не блокируют локальный экспорт.':'Предупреждений нет.'}</p>${button('Открыть проверки','go-release')}</section></div>`;
 }
 function pages(){const p=S.project;return `<div class="oxw-sectionhead"><div><span class="oxw-eyebrow">СТРАНИЦЫ И ВИДИМЫЕ ЭКРАНЫ</span><h2>Страницы проекта</h2><p>Переключайте публикацию прямо здесь или откройте визуальный редактор блоков.</p></div>${button('Редактор страниц','edit-pages')}</div><div class="oxw-list">${p.pages.map(pg=>`<article class="oxw-line"><div class="oxw-line-icon">▤</div><div><strong>${esc(pg.title)}</strong><small>/${esc(pg.slug)} · ${pg.blocks.length} блоков · версия ${pg.revision}</small></div><div class="oxw-line-ops">${pill(pg.published?'Опубликована':'Черновик',pg.published)}${button(pg.published?'Снять с публикации':'Опубликовать','publish-page:'+pg.id)}${button('Изменить','edit-page:'+pg.id)}</div></article>`).join('')||'<p class="oxw-empty">Страницы ещё не созданы.</p>'}</div>`;}
 function data(){const p=S.project;if(p.type==='site')return `<section class="oxw-surface"><h2>Система контента сайта</h2><p>Страницы редактируются в CMS сайта. Отдельные CRM-таблицы в этом типе проекта не создаются.</p>${button('Редактор страниц','edit-pages')}</section>`;
  return `<div class="oxw-sectionhead"><div><span class="oxw-eyebrow">СТРУКТУРА ДАННЫХ</span><h2>Таблицы и поля</h2><p>Таблицы уже подключаются к формам, API и самостоятельному ZIP. Системные таблицы CRM управляются соответствующими модулями.</p></div>${button('+ Настроить таблицы','edit-data')}</div><div class="oxw-list">${p.entities.map(e=>`<article class="oxw-line"><div class="oxw-line-icon">▦</div><div><strong>${esc(e.title)}</strong><small>${esc(e.slug)} · ${e.fields.length} полей · версия ${e.revision}</small></div><div class="oxw-field-tags">${e.fields.slice(0,4).map(f=>pill(f.label,false)).join('')}${e.fields.length>4?pill(`+${e.fields.length-4}`,false):''}</div>${button('Изменить','edit-data')}</article>`).join('')||'<p class="oxw-empty">Нет дополнительных таблиц. Создайте первую через конструктор.</p>'}</div>`;}
 function actions(){const p=S.project;const blocks=p.pages.flatMap(page=>page.blocks.filter(b=>b.type==='button').map(block=>({page,block})));
  return `<div class="oxw-sectionhead"><div><span class="oxw-eyebrow">ДЕЙСТВИЯ БЕЗ КОДА</span><h2>Кнопки и переходы</h2><p>Кнопки могут открывать записи, страницы, показывать уведомления и требовать подтверждение. Доступ ограничивается ролями.</p></div>${button('Открыть редактор','edit-pages')}</div><div class="oxw-list">${blocks.map(({page,block})=>`<article class="oxw-line"><div class="oxw-line-icon">↗</div><div><strong>${esc(block.label)}</strong><small>${esc(page.title)} · ${esc(actionName(block.action))}</small></div><div class="oxw-field-tags">${block.confirm?pill('Подтверждение',true):''}${pill((block.roles||['admin','manager','staff']).map(x=>({admin:'Админ',manager:'Управляющий',staff:'Сотрудник'})[x]).join(', '),false)}</div>${button('Настроить','edit-action:'+page.id+':'+block.id)}</article>`).join('')||'<p class="oxw-empty">Кнопок ещё нет. Добавьте блок «Кнопка» в редакторе страниц.</p>'}</div>`;
 }
 function workflows(){const p=S.project;if(p.type==='site')return '<section class="oxw-surface"><h2>Сценарии для CRM</h2><p>Автоматизации доступны для CRM с подключённым модулем задач.</p></section>';
 return `<div class="oxw-sectionhead"><div><span class="oxw-eyebrow">БИЗНЕС-ПРОЦЕССЫ</span><h2>Автоматизации</h2><p>Правила создают задачи при событиях в базе данных. Включённые правила войдут в экспортированный шаблон.</p></div>${button('+ Создать сценарий','edit-workflows')}</div><div class="oxw-list">${p.automationPresets.map(w=>`<article class="oxw-line"><div class="oxw-line-icon">⚡</div><div><strong>${esc(w.name)}</strong><small>${esc(w.event==='entity_created'?'Новая запись в таблице '+w.entity_slug:w.event==='client_created'?'Новый клиент':'Новый визит')} → задача «${esc(w.task_title)}»</small></div>${pill(w.enabled?'Включён':'Выключен',w.enabled)}${button(w.enabled?'Отключить':'Включить','toggle-workflow:'+w.id)}</article>`).join('')||'<p class="oxw-empty">Нет автоматизаций. Добавьте первую через редактор сценариев.</p>'}</div>`;
 }
 function release(){const d=S.diagnostics,p=S.project;return `<div class="oxw-sectionhead"><div><span class="oxw-eyebrow">ПРОВЕРКИ И ИСХОДНЫЙ КОД</span><h2>Передача проекта</h2><p>Проверка относится к структуре приложения, а не заменяет аудит безопасности или развёртывание на сервере.</p></div>${button('История версий','show-releases')}${button('Подготовить публикацию','open-deployment')}</div><div class="oxw-release-grid"><div class="oxw-surface"><span class="oxw-eyebrow">СОСТОЯНИЕ</span><h3>${d.summary.exportReady?'К экспорту готов':'Нужны исправления'}</h3><p class="oxw-note">${d.summary.errors} ошибок · ${d.summary.warnings} предупреждений</p><div class="oxw-checks">${d.checks.map(c=>`<div><b class="${c.level}">${c.level==='ok'?'✓':c.level==='error'?'×':'!'}</b><span><strong>${esc(c.title)}</strong><small>${esc(c.detail)}</small></span></div>`).join('')}</div></div><div class="oxw-surface oxw-release-card"><span class="oxw-eyebrow">НEЗАВИСИМЫЙ ПРОЕКТ</span><h3>Исходники принадлежат вам.</h3><p>Самостоятельный Node.js сервер, конфигурация, страницы и собственная база SQLite. Реальные записи пользователей и пароли в архив не входят.</p>${d.summary.exportReady?`<a class="oxw-download" href="/api/studio/projects/${encodeURIComponent(p.id)}/export" download>Скачать исходники ZIP ↓</a>`:'<div class="oxw-download blocked">Экспорт заблокирован проверкой</div>'}<small>Запуск и публичная публикация — отдельные операции.</small><div class="oxw-release-count">${S.releases.length} сохранённых версий</div></div></div>`;}
 function render(){if(!S.project)return;
  $('oxwTabs').innerHTML=tabs.filter(([id])=>S.project.type==='crm'||!['data','workflows'].includes(id)).map(([id,label,icon])=>`<button type="button" data-oxw-tab="${id}" ${S.tab===id?'aria-current="page"':''} class="${S.tab===id?'active':''}"><span>${icon}</span>${label}</button>`).join('');
  $('oxwContent').innerHTML=({overview,pages,data,actions,workflows,release}[S.tab]||overview)();
  $('oxwContent').scrollTop=0;
 }
 async function mutate(action){if(S.busy)return;S.busy=true;
  try{
   if(action.startsWith('publish-page:')){
    const page=S.project.pages.find(p=>p.id===action.slice(13));if(!page)return;
    const {id,revision,title,slug,description,blocks,published}=page;
    await api(`/api/studio/projects/${S.id}/pages/${id}`,{method:'PATCH',body:{title,slug,description,blocks,published:!published,revision}});
    toast('Публикация страницы обновлена');await refresh();
   }else if(action.startsWith('toggle-workflow:')){
    const wf=S.project.automationPresets.find(w=>w.id===action.slice(16));if(!wf)return;
    await api(`/api/studio/projects/${S.id}/workflows/${wf.id}`,{method:'PATCH',body:{...wf,enabled:!wf.enabled}});
    toast('Состояние сценария обновлено');await refresh();
   }
  }catch(err){toast(err.message,true);await refresh();}finally{S.busy=false;}
 }
 overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
 $('oxwClose').addEventListener('click',close);$('oxwRefresh').addEventListener('click',refresh);
 $('oxwTabs').addEventListener('click',e=>{const tab=e.target.closest('[data-oxw-tab]')?.dataset.oxwTab;if(tab){S.tab=tab;render();}});
 $('oxwContent').addEventListener('click',e=>{
   const tab=e.target.closest('[data-oxw-tab]')?.dataset.oxwTab;if(tab){S.tab=tab;render();return;}
   const action=e.target.closest('[data-oxw-action]')?.dataset.oxwAction;if(!action)return;
   if(action.startsWith('publish-page:')||action.startsWith('toggle-workflow:'))return mutate(action);
   if(action==='go-release'){S.tab='release';render();return;}
   const project=S.project;const id=S.id;close();
   if(action==='edit-pages')return editPage(project);
   if(action.startsWith('edit-action:')){const [,pageId,blockId]=action.split(':');return editPage(project,{pageId,blockId});}
   if(action.startsWith('edit-page:'))return editPage(project,{pageId:action.slice(10)});
   if(action==='edit-data')return editData(project);
   if(action==='edit-workflows')return editWorkflow(project);
   if(action==='open-deployment')return openDeployment(project);
   if(action==='show-releases')return showReleases(id);
   if(action==='settings')return showSettings(id);
  });
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!overlay.hidden){e.preventDefault();close();}});
 return {open,close,isOpen:()=>!overlay.hidden};
}
