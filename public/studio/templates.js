// R0.8: real reusable project templates, private per owner, with safe JSON portability.
export function initTemplateLibrary({api,toast,reloadProjects,projects}){
  const $=id=>document.getElementById(id);
  const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dialogs=['templatesOverlay','projectCopyOverlay','diagnosticsOverlay'];
  let sourceProject=null,copyProjectId=null,restoreFocus=null;
  let library=[];
  const opened=()=>dialogs.find(id=>!$(id).hidden);
  function openDialog(id){
    restoreFocus=document.activeElement;
    dialogs.forEach(other=>$(other).hidden=other!==id);
    $(id).hidden=false;document.body.style.overflow='hidden';
    $(id).querySelector('.close-button')?.focus();
  }
  function closeDialog(){
    dialogs.forEach(id=>$(id).hidden=true);
    document.body.style.overflow='';
    restoreFocus?.focus?.();
    sourceProject=null;
  }
  function labelCount(n){return `${n} ${n%10===1&&n%100!==11?'шаблон':n%10>=2&&n%10<=4&&(n%100<12||n%100>14)?'шаблона':'шаблонов'}`;}
  async function refresh(){
    const response=await api('/api/studio/templates');
    library=response.templates||[];
    $('templatesCount').textContent=labelCount(library.length);
    renderLibrary();
  }
  function renderLibrary(){
    if(!library.length){
      $('templatesList').innerHTML='<div class="ox-template-empty"><strong>Здесь будет ваша библиотека</strong><p>Откройте меню существующего проекта, нажмите «Сохранить как шаблон», и следующий проект можно будет создать за несколько секунд.</p></div>';
      return;
    }
    const filter=$('templatesFilter').value.trim().toLocaleLowerCase('ru-RU');
    const visible=library.filter(t=>[t.name,t.description,t.type==='site'?'сайт':'crm'].join(' ').toLocaleLowerCase('ru-RU').includes(filter));
    if(!visible.length){$('templatesList').innerHTML='<div class="ox-template-empty"><strong>Совпадений нет</strong><p>Попробуйте другое название или сбросьте поиск.</p></div>';return;}
    $('templatesList').innerHTML=visible.map(t=>`<article class="ox-template-card">
      <div class="ox-template-card-head"><span class="ox-template-type">${t.type==='site'?'САЙТ':'CRM'}</span><span class="ox-template-date">${new Date(t.createdAt).toLocaleDateString('ru-RU')}</span></div>
      <h3>${safe(t.name)}</h3><p>${safe(t.description||'Настроенный набор страниц, модулей и структуры данных.')}</p>
      <label>Название нового проекта<input type="text" required maxlength="80" data-template-name="${t.id}" value="${safe(t.name.slice(0,58))} — новый клиент" aria-label="Название нового проекта по шаблону"></label>
      <div class="ox-template-card-actions"><button class="btn btn-primary" type="button" data-template-create="${t.id}">Создать проект ↗</button><a class="btn btn-outline" href="/api/studio/templates/${t.id}/download" download>Скачать JSON</a><button class="btn btn-outline ox-template-remove" type="button" data-template-delete="${t.id}">Удалить</button></div>
    </article>`).join('');
  }
  async function showLibrary(projectId=null){
    $('templateSaveForm').hidden=true;
    sourceProject=projectId;
    if(projectId){
      const source=projects().find(p=>p.id===projectId);
      if(!source)return;
      $('templateSourceLabel').textContent=`Исходный проект: ${source.name}`;
      $('templateSaveName').value=source.name;
      $('templateSaveDescription').value=source.type==='site'?'Сайт: страницы и настройки':'CRM: страницы, данные и модули';
      $('templateSaveForm').hidden=false;
    }
    openDialog('templatesOverlay');
    try{await refresh();}catch(err){toast(err.message,true);}
    if(projectId)$('templateSaveName').focus();
  }
  $('templatesFilter').addEventListener('input',renderLibrary);
  $('templatesClose').addEventListener('click',closeDialog);
  $('templatesRefresh').addEventListener('click',async()=>{try{await refresh();toast('Библиотека обновлена');}catch(err){toast(err.message,true)}});
  $('templateSaveCancel').addEventListener('click',()=>{$('templateSaveForm').hidden=true;sourceProject=null;});
  $('templateSaveForm').addEventListener('submit',async event=>{
    event.preventDefault();if(!sourceProject)return;
    const button=$('templateSaveSubmit');button.disabled=true;
    try{
      await api('/api/studio/templates',{method:'POST',body:{projectId:sourceProject,name:$('templateSaveName').value.trim(),description:$('templateSaveDescription').value.trim()}});
      $('templateSaveForm').hidden=true;sourceProject=null;await refresh();toast('Шаблон сохранён. Его можно использовать повторно.');
    }catch(err){toast(err.message,true)}finally{button.disabled=false}
  });
  $('templatesList').addEventListener('click',async event=>{
    const create=event.target.closest('[data-template-create]');
    const del=event.target.closest('[data-template-delete]');
    if(create){
      const templateId=create.dataset.templateCreate;
      const input=$('templatesList').querySelector(`[data-template-name="${templateId}"]`);
      const name=input?.value.trim();
      if(!name){input?.focus();toast('Введите название проекта',true);return;}
      create.disabled=true;
      try{
        await api(`/api/studio/templates/${templateId}/projects`,{method:'POST',body:{name}});
        await reloadProjects();closeDialog();document.getElementById('projectsSection')?.scrollIntoView({block:'start',behavior:'smooth'});toast('Новый проект создан из шаблона — без клиентских данных.');
      }catch(err){toast(err.message,true)}finally{create.disabled=false}
    }
    if(del){
      const templateId=del.dataset.templateDelete;
      if(del.dataset.confirm!=='yes'){
        del.dataset.confirm='yes';del.textContent='Подтвердить удаление';del.focus();return;
      }
      del.disabled=true;
      try{await api(`/api/studio/templates/${templateId}`,{method:'DELETE'});await refresh();toast('Шаблон удалён. Проекты не затронуты.');}
      catch(err){del.disabled=false;toast(err.message,true)}
    }
  });
  $('templateImport').addEventListener('click',()=>$('templateImportFile').click());
  $('templateImportFile').addEventListener('change',async event=>{
    const file=event.target.files?.[0];if(!file)return;
    event.target.value='';
    if(file.size>120*1024){toast('Файл больше допустимого размера шаблона (120 КБ)',true);return;}
    try{
      const manifest=JSON.parse(await file.text());
      await api('/api/studio/templates/import',{method:'POST',body:manifest});
      await refresh();toast('Шаблон импортирован и проверен.');
    }catch(err){toast('Импорт не выполнен: '+err.message,true)}
  });
  $('copyClose').addEventListener('click',closeDialog);
  $('copyCancel').addEventListener('click',closeDialog);
  function openCopy(projectId){
    const source=projects().find(p=>p.id===projectId);if(!source)return;
    copyProjectId=projectId;
    $('copyName').value=source.name+' — копия';
    openDialog('projectCopyOverlay');$('copyName').focus();$('copyName').select();
  }
  $('copyForm').addEventListener('submit',async event=>{
    event.preventDefault();if(!copyProjectId)return;
    const button=$('copySubmit');button.disabled=true;
    try{
      await api(`/api/studio/projects/${copyProjectId}/clone`,{method:'POST',body:{name:$('copyName').value.trim()}});
      await reloadProjects();closeDialog();document.getElementById('projectsSection')?.scrollIntoView({block:'start',behavior:'smooth'});toast('Создана независимая копия проекта с пустой базой.');
    }catch(err){toast(err.message,true)}finally{button.disabled=false}
  });
  const titles={configuration:'Структура и права',pages:'Страницы',home:'Главная страница',contact:'Контактная почта',leads:'Сбор заявок',payments:'Платёжные операции',clients:'База клиентов',export:'Экспорт исходников'};
  const details={configuration:'Схема, поля и зависимости модулей проходят проверку.',pages:'Есть опубликованные страницы, доступные пользователям.',home:'Для сайта нужна главная страница.',contact:'Добавьте контактную почту в настройках сайта.',leads:'Без модуля заявок формы не принимают обращения.',payments:'Платёжный модуль ведёт учёт, но не списывает деньги с карт.',clients:'В этой конфигурации нет клиентской базы.',export:'ZIP содержит исходники и конфигурацию, но не записи клиентов и пароли.'};
  async function showDiagnostics(projectId){
    const source=projects().find(p=>p.id===projectId);if(!source)return;
    $('diagnosticsHeading').textContent=`Проверка: ${source.name}`;
    openDialog('diagnosticsOverlay');
    $('diagnosticsChecks').textContent='Проверяем конфигурацию...';
    try{
      const data=await api(`/api/studio/projects/${projectId}/diagnostics`);
      const {summary,checks}=data;
      $('diagnosticsSummary').textContent=summary.exportReady
        ? `Экспорт доступен. Замечаний: ${summary.warnings}. Перед публикацией требуется отдельное тестирование.`
        : `Найдено ${summary.errors} ошибок конфигурации. Исправьте их перед экспортом.`;
      $('diagnosticsChecks').innerHTML=checks.map(c=>`<article class="ox-diagnostic ${safe(c.level)}"><span class="ox-diagnostic-symbol">${c.level==='ok'?'✓':c.level==='warning'?'!':'×'}</span><div><strong>${safe(titles[c.key]||c.title)}</strong><small>${safe(c.level==='ok'?details[c.key]||c.detail:details[c.key]||c.detail)}</small></div></article>`).join('');
    }catch(err){$('diagnosticsChecks').textContent=err.message;toast(err.message,true)}
  }
  $('diagnosticsClose').addEventListener('click',closeDialog);
  for(const id of dialogs){
    $(id).addEventListener('click',event=>{if(event.target===$(id))closeDialog()});
  }
  document.addEventListener('keydown',event=>{
    const active=opened();if(!active)return;
    if(event.key==='Escape'){event.preventDefault();closeDialog();return;}
    if(event.key!=='Tab')return;
    const items=[...$(active).querySelectorAll('button:not([disabled]),a[href],input:not([disabled]):not([hidden]),select,textarea')]
      .filter(el=>!el.closest('[hidden]')&&getComputedStyle(el).display!=='none');
    if(!items.length)return;
    const first=items[0],last=items.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  });
  document.getElementById('projectsList').addEventListener('click',event=>{
    const save=event.target.closest('[data-template-save]');
    const clone=event.target.closest('[data-project-clone]');
    const checks=event.target.closest('[data-project-check]');
    if(save)showLibrary(save.dataset.templateSave);
    else if(clone)openCopy(clone.dataset.projectClone);
    else if(checks)showDiagnostics(checks.dataset.projectCheck);
  });
  return {showLibrary,openCopy,showDiagnostics,closeDialog};
}
