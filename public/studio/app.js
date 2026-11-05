import { initPageEditor } from './editor.js';
import { initEntityEditor } from './entities.js';
import { initTemplateLibrary } from './templates.js';
import { initWorkflowStudio } from './workflows.js';
import { initProjectWorkbench } from './workbench.js';
import { initDeployWizard } from './deploy.js';
const $=id=>document.getElementById(id);
const state={session:null,projects:[],settingsId:null};
const pageEditor=initPageEditor({api,toast});
const entityEditor=initEntityEditor({api,toast});
const templateUI=initTemplateLibrary({api,toast,reloadProjects:loadProjects,projects:()=>state.projects});
const workflowUI=initWorkflowStudio({api,toast});
const deployWizard=initDeployWizard({api,toast});
const workbench=initProjectWorkbench({api,toast,editPage:(p,options)=>pageEditor.open(p,options),editData:p=>entityEditor.open(p),editWorkflow:p=>workflowUI.open(p),showReleases:id=>openReleases(id),showSettings:id=>openSettings(id),openDeployment:p=>deployWizard.open(p)});
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtDate=x=>new Date(x).toLocaleDateString('ru-RU',{day:'2-digit',month:'short',year:'numeric'});
let toastTimeout;
function toast(message,error=false){const el=$('toast');el.textContent=message;el.classList.toggle('error',error);el.hidden=false;clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>el.hidden=true,4500)}
async function api(path,{method='GET',body=null}={}){
  const headers={};if(body!==null)headers['Content-Type']='application/json';
  if(!['GET','HEAD'].includes(method)&&state.session?.csrf) headers['X-CSRF-Token']=state.session.csrf;
  let response;
  try {response=await fetch(path,{method,headers,body:body===null?undefined:JSON.stringify(body),credentials:'same-origin'});}
  catch {throw new Error('Сервер недоступен. Проверьте, запущен ли проект.');}
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||`Ошибка HTTP ${response.status}`);
  return payload;
}
function showAuth(){
  $('authScreen').hidden=false;$('studioScreen').hidden=true;
  const setup=!state.session?.initialized;
  $('authTitle').textContent=setup?'Создайте рабочую область':'Войти в мастерскую';
  $('authSubtitle').textContent=setup?'Создайте первого администратора. Доступ к проектам будет защищён паролем.':'Доступ к конструктору и проектам вашей студии.';
  $('nameField').hidden=!setup;
  $('setupTokenWrap').hidden=!setup||!state.session?.requiresSetupToken;
  $('setupToken').required=setup&&!!state.session?.requiresSetupToken;
  $('authName').required=setup;
  $('authPassword').autocomplete=setup?'new-password':'current-password';
  $('authSubmit').firstChild.textContent=setup?'Создать администратора ':'Войти в систему ';
  $('authHint').textContent=setup?'Пароль не менее 12 символов. Хранится только scrypt-хеш.':'Для работы необходима учётная запись владельца.';
}
function isSite(){return $('projectType').value==='site';}
function selectedModules(){return isSite()?['auth','cms',...($('siteModuleList').querySelector('[value=leads]').checked?['leads']:[])]:['auth',...[...document.querySelectorAll('[data-module]:checked')].map(i=>i.value).filter(v=>v!=='auth')];}
function updateType(){
  const site=isSite();$('crmModuleList').hidden=site;$('siteModuleList').hidden=!site;
  $('crmActionWrap').hidden=site;$('crmCurrencyWrap').hidden=site;
  $('siteTaglineWrap').hidden=!site;$('siteEmailWrap').hidden=!site;
  $('projectIndustry').value=site?'business':($('projectIndustry').value==='business'?'restaurant':$('projectIndustry').value);
  for(const option of $('projectIndustry').options)option.hidden=site?option.value!=='business':option.value==='business';
  $('blueprintName').textContent=site?'Корпоративный сайт':'Ресторанная CRM';
  $('blueprintDescription').textContent=site?'Публичный сайт, редактор контента, заявки и настройка поиска. Самостоятельный сервер и код.':'Клиенты, задачи, аналитика и учёт платежей. Рабочий код.';
  $('createProject').firstChild.textContent=site?'Создать сайт ':'Создать CRM ';
  const name=$('projectName');if(['Ресторан · CRM','Новая компания · сайт'].includes(name.value))name.value=site?'Новая компания · сайт':'Ресторан · CRM';
  $('projectColor').value=site?'#a78150':'#386f61';$('colorCode').textContent=$('projectColor').value.toUpperCase();
  document.querySelectorAll('[data-type-choice]').forEach(b=>{const on=b.dataset.typeChoice===(site?'site':'crm');b.classList.toggle('selected',on);b.setAttribute('aria-pressed',String(on));});
  updateBuilderSummary();
}
let wizardStep=1;
function updateBuilderSummary(){
  $('summaryType').textContent=isSite()?'Корпоративный сайт':'CRM-система';
  const label=$('projectIndustry').selectedOptions[0]?.textContent||'CRM';
  $('blueprintName').textContent=isSite()?'Корпоративный сайт':label+' · CRM';
  $('blueprintDescription').textContent=isSite()?'Публичный сайт, редактор страниц и заявки.':'Готовые разделы и связанные таблицы для отрасли «'+label+'». Настройте без кода.';
  const count=selectedModules().length;
  $('summaryModules').textContent=`${count} ${count===1?'модуль':count>=2&&count<=4?'модуля':'модулей'}`;
  $('summaryName').textContent=$('projectName').value.trim()||'Без названия';
}
function setWizardStep(step,focus=false){
  wizardStep=Math.max(1,Math.min(3,step));
  document.querySelectorAll('[data-wizard-panel]').forEach(panel=>{panel.hidden=Number(panel.dataset.wizardPanel)!==wizardStep});
  document.querySelectorAll('[data-wizard-to]').forEach(button=>{
    const number=Number(button.dataset.wizardTo);
    button.classList.toggle('active',number===wizardStep);
    button.classList.toggle('completed',number<wizardStep);
    if(number===wizardStep)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');
  });
  $('builderBack').hidden=wizardStep===1;
  $('builderNext').hidden=wizardStep===3;
  $('createProject').hidden=wizardStep!==3;
  updateBuilderSummary();
  if(focus){document.querySelector('[data-wizard-panel="'+wizardStep+'"] .panel-heading h3')?.setAttribute('tabindex','-1');document.querySelector('[data-wizard-panel="'+wizardStep+'"] .panel-heading h3')?.focus({preventScroll:true});}
}
function goForward(){
  if(wizardStep===1){
    if(!$('projectName').value.trim()){$('projectName').setCustomValidity('Укажите название проекта');$('projectName').reportValidity();return;}
    $('projectName').setCustomValidity('');
    if(!$('projectName').checkValidity()){$('projectName').reportValidity();return;}
  }
  setWizardStep(wizardStep+1,true);
}
$('builderNext').addEventListener('click',goForward);
$('builderBack').addEventListener('click',()=>setWizardStep(wizardStep-1,true));
document.querySelectorAll('[data-wizard-to]').forEach(button=>button.addEventListener('click',()=>{
  const next=Number(button.dataset.wizardTo);
  if(next>wizardStep&&wizardStep===1&&!$('projectName').value.trim()){goForward();return;}
  setWizardStep(next,true);
}));
document.querySelectorAll('[data-type-choice]').forEach(button=>button.addEventListener('click',()=>{
  $('projectType').value=button.dataset.typeChoice;
  updateType();
}));
$('projectForm').addEventListener('input',updateBuilderSummary);
$('projectForm').addEventListener('change',updateBuilderSummary);
$('projectType').addEventListener('change',updateType);updateType();setWizardStep(1);

const prettyModules={auth:'Доступ',clients:'Клиенты',analytics:'Аналитика',tasks:'Задачи',payments:'Платежи',cms:'Страницы',leads:'Заявки'};
let projectsListStyle='grid';
function projectCover(p,i){
  if(p.type==='site')return '/assets/studio/media/project-studio.jpg';
  if(/фитнес|спорт|gym|fitness|тренаж/i.test(p.name))return '/assets/studio/media/project-fitness.jpg';
  return '/assets/studio/media/project-restaurant.jpg';
}
function renderProjects(){
  const all=state.projects;
  const count=all.length;
  $('projectCount').textContent=String(count);
  $('navProjectCount').textContent=String(count);
  $('crmCount').textContent=String(all.filter(p=>p.type==='crm').length);
  $('siteCount').textContent=String(all.filter(p=>p.type==='site').length);
  $('projectsLabel').textContent=`${count} ${count===1?'проект':count>=2&&count<=4?'проекта':'проектов'}`;
  const filter=($('globalSearch')?.value||'').trim().toLocaleLowerCase('ru-RU');
  let rows=[...all].filter(p=>[p.name,p.type==='site'?'сайт':'crm',p.industry,...p.modules.map(m=>prettyModules[m]||m)].join(' ').toLocaleLowerCase('ru-RU').includes(filter));
  const sort=$('projectSort')?.value||'newest';
  rows.sort((a,b)=>sort==='name'?a.name.localeCompare(b.name,'ru'):sort==='oldest'?new Date(a.createdAt)-new Date(b.createdAt):new Date(b.createdAt)-new Date(a.createdAt));
  const list=$('projectsList');
  list.classList.toggle('list-layout',projectsListStyle==='list');
  const addCard='<button type="button" class="project-add-card" data-open-create="1"><span class="project-add-plus"><svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M12 4v16M4 12h16"/></svg></span><strong>Создать проект</strong><small>CRM или сайт</small></button>';
  if(!count){
    if(filter && !'ресторан сайт crm студия фитнес шаблон'.includes(filter)){
      list.innerHTML='<div class="empty-projects"><strong>Ничего не найдено</strong><p>Попробуйте другой запрос или создайте первый проект.</p></div>'+addCard;return;
    }
    const samples=[{type:'crm',name:'Ресторан «Элегант»',desc:'CRM для ресторана',cover:'project-restaurant.jpg'},{type:'site',name:'OSMANX Studio',desc:'Корпоративный сайт',cover:'project-studio.jpg'},{type:'crm',name:'Фитнес-клуб Prime',desc:'CRM и запись',cover:'project-fitness.jpg'}];
    list.innerHTML=samples.map((p,i)=>`<article class="starter-card project-card"><div class="project-cover"><img src="/assets/studio/media/${p.cover}" alt="" loading="lazy"><span class="project-type-badge">${p.type==='site'?'Сайт':'CRM'}</span></div><div class="project-card-body"><h3>${escape(p.name)}</h3><p class="project-desc">${escape(p.desc)}</p><div class="project-status">Готовый шаблон</div><button type="button" class="starter-action" data-demo-type="${p.type}">Использовать шаблон <span>→</span></button></div></article>`).join('')+addCard;
    return;
  }
  const markup=rows.map((p,i)=>`<article class="project-card"><div class="project-cover"><img src="${projectCover(p,i)}" alt="" loading="lazy"><span class="project-type-badge">${p.type==='site'?'Сайт':'CRM'}</span></div><div class="project-card-body"><h3 title="${escape(p.name)}">${escape(p.name)}</h3><p class="project-desc">${p.type==='site'?'Корпоративный сайт':'CRM для бизнеса'} · ${fmtDate(p.createdAt)}</p><div class="project-status">Локальный проект</div><div class="project-actions"><button type="button" class="open-link" data-project-workbench="${p.id}">Мастерская →</button><a class="open-link" href="/workspace/${encodeURIComponent(p.id)}/" target="_blank" rel="noopener">${p.type==='site'?'Открыть сайт':'Открыть CRM'} ↗</a><details class="project-more"><summary aria-label="Управление проектом ${escape(p.name)}">⋯<span aria-hidden="true">⌄</span></summary><div class="project-tools"><button type="button" data-editor="${p.id}" class="editor-open-action">Редактор страниц</button>${p.type==='site'?`<a href="/workspace/${encodeURIComponent(p.id)}/admin" target="_blank" rel="noopener">Панель CMS</a>`:`<button type="button" data-entities="${p.id}" class="editor-open-action">База данных</button>`}<button type="button" data-releases="${p.id}" class="editor-open-action">История версий</button><button type="button" data-template-save="${p.id}" class="editor-open-action">Сохранить как шаблон</button><button type="button" data-project-clone="${p.id}" class="editor-open-action">Создать копию</button><button type="button" data-project-check="${p.id}" class="editor-open-action">Проверить проект</button><button type="button" data-settings="${p.id}">Настройки проекта</button><a href="/api/studio/projects/${encodeURIComponent(p.id)}/export" download>Скачать исходники (ZIP) ↓</a></div></details></div></div></article>`).join('');
  list.innerHTML=(rows.length?markup:'<div class="empty-projects"><strong>Проекты не найдены</strong><p>Измените поисковый запрос, чтобы увидеть остальные проекты.</p></div>')+addCard;
}
async function loadProjects(){const r=await api('/api/studio/projects');state.projects=r.projects;renderProjects()}
async function showStudio(){
  $('authScreen').hidden=true;$('studioScreen').hidden=false;
  $('userName').textContent=state.session.user?.name||'Владелец';
  await loadProjects();
}
async function boot(){
  try{state.session=await api('/api/studio/session');if(state.session.authenticated)await showStudio();else showAuth();}
  catch(e){toast(e.message,true);showAuth();}
}
$('authForm').addEventListener('submit',async e=>{
  e.preventDefault();const btn=$('authSubmit');btn.disabled=true;
  try{
    const setup=!state.session?.initialized;
    const body={email:$('authEmail').value.trim(),password:$('authPassword').value};
    if(setup){body.name=$('authName').value.trim();if(state.session?.requiresSetupToken)body.setup_token=$('setupToken').value;}
    const result=await api(`/api/studio/${setup?'setup':'login'}`,{method:'POST',body});
    state.session={authenticated:true,initialized:true,user:result.user,csrf:result.csrf};
    $('authPassword').value='';await showStudio();toast('Рабочая область открыта');
  }catch(err){toast(err.message,true);}finally{btn.disabled=false;}
});
$('logoutButton').addEventListener('click',async()=>{
  try{await api('/api/studio/logout',{method:'POST',body:{}});state.session={initialized:true,authenticated:false};state.projects=[];closeWizard();showAuth();toast('Вы вышли');}
  catch(e){toast(e.message,true)}
});
$('projectColor').addEventListener('input',e=>{$('colorCode').textContent=e.target.value.toUpperCase()});
const clientsInput=[...document.querySelectorAll('[data-module]')].find(e=>e.value==='clients');
const analyticsInput=[...document.querySelectorAll('[data-module]')].find(e=>e.value==='analytics');
clientsInput.addEventListener('change',()=>{analyticsInput.disabled=!clientsInput.checked;if(!clientsInput.checked)analyticsInput.checked=false});
$('projectForm').addEventListener('submit',async e=>{
  e.preventDefault();const button=$('createProject');button.disabled=true;
  try{
    const result=await api('/api/studio/projects',{method:'POST',body:{
      name:$('projectName').value.trim(),type:isSite()?'site':'crm',industry:$('projectIndustry').value,modules:selectedModules(),
      settings:isSite()?{accent:$('projectColor').value,tagline:$('projectTagline').value,contactEmail:$('projectContactEmail').value}:{accent:$('projectColor').value,primaryAction:$('projectAction').value,currency:$('projectCurrency').value}
    }});
    await loadProjects();closeWizard();toast('Проект создан. Его можно открыть и экспортировать.');
    $('projectsSection').scrollIntoView({behavior:'smooth',block:'start'});
    setWizardStep(1);
    const card=$('projectsList').firstElementChild;if(card)card.style.borderColor='#ad976e';
  }catch(err){toast(err.message,true)}finally{button.disabled=false}
});
function openSettings(id){
  const p=state.projects.find(p=>p.id===id);if(!p)return;
  state.settingsId=id;$('settingsName').value=p.name;$('settingsColor').value=p.settings.accent;
  const site=p.type==='site';$('settingsActionWrap').hidden=site;$('settingsCurrencyWrap').hidden=site;$('settingsTaglineWrap').hidden=!site;$('settingsEmailWrap').hidden=!site;
  if(site){$('settingsTagline').value=p.settings.tagline||'';$('settingsEmail').value=p.settings.contactEmail||'';}
  else{$('settingsAction').value=p.settings.primaryAction;$('settingsCurrency').value=p.settings.currency;}
  $('settingsOverlay').hidden=false;$('settingsName').focus();
}
function closeSettings(){$('settingsOverlay').hidden=true;state.settingsId=null;}
$('projectsList').addEventListener('click',async e=>{
  const work=e.target.closest('[data-project-workbench]');if(work)return workbench.open(work.dataset.projectWorkbench);
  const hub=e.target.closest('[data-project-hub]');if(hub)return openProjectHub(hub.dataset.projectHub);
  const rel=e.target.closest('[data-releases]');if(rel)return openReleases(rel.dataset.releases);
  const el=e.target.closest('[data-settings]');if(el)return openSettings(el.dataset.settings);
  const edit=e.target.closest('[data-editor]');const entities=e.target.closest('[data-entities]');
  const target=edit||entities;if(!target)return;
  try{const p=(await api('/api/studio/projects/'+(edit?edit.dataset.editor:entities.dataset.entities))).project;
    if(edit)pageEditor.open(p);else entityEditor.open(p);
  }catch(err){toast(err.message,true)}
});
$('closeSettings').addEventListener('click',closeSettings);
$('cancelSettings').addEventListener('click',closeSettings);
$('settingsOverlay').addEventListener('click',e=>{if(e.target===$('settingsOverlay'))closeSettings()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('settingsOverlay').hidden)closeSettings()});
$('settingsForm').addEventListener('submit',async e=>{
  e.preventDefault();const p=state.projects.find(p=>p.id===state.settingsId);if(!p)return;
  const btn=e.target.querySelector('[type=submit]');btn.disabled=true;
  try{
    await api(`/api/studio/projects/${p.id}`,{method:'PATCH',body:{name:$('settingsName').value,settings:p.type==='site'?{accent:$('settingsColor').value,tagline:$('settingsTagline').value,contactEmail:$('settingsEmail').value}:{accent:$('settingsColor').value,primaryAction:$('settingsAction').value,currency:$('settingsCurrency').value}}});
    await loadProjects();closeSettings();toast('Конфигурация сохранена. Обновите страницу CRM для применения.');
  }catch(err){toast(err.message,true)}finally{btn.disabled=false}
});

let activeReleaseProject=null;
async function loadReleases(){
  if(!activeReleaseProject)return;
  const result=await api(`/api/studio/projects/${activeReleaseProject}/releases`);
  const items=result.releases||[];
  $('releaseList').innerHTML=items.length ? items.map(r=>`<div class="release-item"><div><strong>v${r.sequence}</strong><small>${fmtDate(r.createdAt)} &middot; ${escape(r.notes||'Снимок версии')}</small><code>${escape(r.snapshotSha256.slice(0,16))}</code></div><a class="btn btn-outline" download href="/api/studio/projects/${activeReleaseProject}/releases/${r.id}/export">\u0421\u043a\u0430\u0447\u0430\u0442\u044c ZIP</a></div>`).join('') : '<p class="release-note">\u041f\u043e\u043a\u0430 \u043d\u0435\u0442 \u043e\u043f\u0443\u0431\u043b\u0438\u043a\u043e\u0432\u0430\u043d\u043d\u044b\u0445 \u0432\u0435\u0440\u0441\u0438\u0439.</p>';
}
async function openReleases(id){
  const project=state.projects.find(p=>p.id===id);if(!project)return;
  activeReleaseProject=id;
  $('releaseHeading').textContent=`\u0420\u0435\u043b\u0438\u0437\u044b / ${project.name}`;
  $('releasesOverlay').hidden=false;
  try{await loadReleases();}catch(e){toast(e.message,true);}
}
function closeReleases(){$('releasesOverlay').hidden=true;activeReleaseProject=null;}
$('releaseClose').addEventListener('click',closeReleases);
$('releasesOverlay').addEventListener('click',e=>{if(e.target===$('releasesOverlay'))closeReleases();});
$('releaseCreate').addEventListener('click',async()=>{
  if(!activeReleaseProject)return;
  const btn=$('releaseCreate');btn.disabled=true;
  try{
    const response=await api(`/api/studio/projects/${activeReleaseProject}/releases`,{method:'POST',body:{notes:$('releaseNotes').value.trim()}});
    $('releaseNotes').value='';await loadReleases();toast(`\u0412\u0435\u0440\u0441\u0438\u044f v${response.release.sequence} \u043e\u043f\u0443\u0431\u043b\u0438\u043a\u043e\u0432\u0430\u043d\u0430`);
  }catch(e){toast(e.message,true);}finally{btn.disabled=false;}
});
// R0.7 interface control: the three-step working builder lives in a modal.
function openWizard(type=null,step=1){
  if(type){$('projectType').value=type;updateType();}
  setWizardStep(step);
  $('overviewView').hidden=false;
  document.body.style.overflow='hidden';
  $('wizardDismiss').focus({preventScroll:true});
}
function closeWizard(){
  $('overviewView').hidden=true;
  document.body.style.overflow='';
}
$('wizardDismiss').addEventListener('click',closeWizard);
$('overviewView').addEventListener('click',e=>{if(e.target===$('overviewView'))closeWizard()});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&!$('overviewView').hidden){closeWizard();return;}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){
    e.preventDefault();if($('studioScreen').hidden)return;
    closeWizard();$('globalSearch').focus();$('globalSearch').select();
  }
});
$('topCreate').addEventListener('click',()=>openWizard(null,1));
$('navOverview').addEventListener('click',()=>{window.scrollTo({top:0,behavior:'smooth'});setActiveNav('navOverview')});
$('navProjects').addEventListener('click',()=>{$('projectsSection').scrollIntoView({behavior:'smooth'});setActiveNav('navProjects')});
$('navBlueprint').addEventListener('click',()=>{templateUI.showLibrary();setActiveNav('navBlueprint')});
$('navWorkspace').addEventListener('click',()=>chooseProjectFor('workbench'));
function setActiveNav(which){document.querySelectorAll('.luxury-nav .nav-item').forEach(b=>b.classList.toggle('active',b.id===which));}
$('navBuilder').addEventListener('click',()=>{
 const open=$('navBuilder').getAttribute('aria-expanded')!=='true';
 $('navBuilder').setAttribute('aria-expanded',String(open));$('builderSubnav').hidden=!open;
});
// One project hub for all major modules; no more guessing which CRM the nav opens.
let hubProject=null,hubMode='overview';
const hubOverlay=$('projectHubOverlay');
function closeHub(){hubOverlay.hidden=true;hubProject=null;hubMode='overview';}
function hubAction(label,detail,action,icon){
  return `<button type="button" class="hub-action" data-hub-action="${action}"><span class="hub-action-icon">${icon}</span><span><strong>${escape(label)}</strong><small>${escape(detail)}</small></span><span class="hub-action-arrow">→</span></button>`;
}
async function openProjectHub(id,mode='overview'){
  hubMode=mode;hubProject=id;hubOverlay.hidden=false;
  $('projectHubBody').innerHTML='<p class="hub-loading">Загружаем настройки проекта…</p>';
  try{
    const project=(await api(`/api/studio/projects/${id}`)).project;
    if(hubProject!==id)return;
    $('projectHubTitle').textContent=project.name;
    $('projectHubSubtitle').textContent=project.type==='site'?'Сайт · страницы, заявки и публикация':'CRM · '+($('projectIndustry').querySelector(`option[value="${project.industry}"]`)?.textContent||project.industry);
    const actions=[
      hubAction('Открыть проект',project.type==='site'?'Публичная часть сайта':'Рабочая CRM с реальными данными','open','↗'),
      hubAction('Редактор страниц','Соберите формы, кнопки и структуру экранов','pages','▤')
    ];
    if(project.type==='crm'){
      actions.push(hubAction('База данных',`${project.entities.length} пользовательских таблиц · поля, связи и права`,'entities','▦'));
      if(project.modules.includes('tasks')){
        actions.push(hubAction('Сценарии для шаблона',`${project.automationPresets?.length||0} готовых правил · переносятся к новым клиентам`,'workflows','⚡'));
        actions.push(hubAction('Автоматизации в CRM','Рабочие правила и журнал срабатываний','automation','↗'));
      }
      actions.push(hubAction('Команда','Пользователи и роли доступа','team','♙'));
    } else actions.push(hubAction('Панель сайта','Контент и обработка заявок','cms','▤'));
    actions.push(hubAction('Диагностика','Проверка конфигурации перед экспортом','check','✓'));
    actions.push(hubAction('История версий','Снимки, архивы и безопасные изменения','releases','◷'));
    actions.push(hubAction('Подготовить публикацию','Домен, проверка DNS, Docker Compose и HTTPS','deploy','⇧'));
    actions.push(hubAction('Настройки','Название, цвет и главное действие','settings','⚙'));
    const hubTop=`<div class="hub-project-summary"><div><span class="hub-kicker">${project.type==='site'?'КОРПОРАТИВНЫЙ САЙТ':'БИЗНЕС-CRM'}</span><h3>${escape(project.name)}</h3><p>${project.pages.length} страниц · ${project.entities.length} таблиц · ${project.modules.length} модулей</p></div><a href="/api/studio/projects/${encodeURIComponent(id)}/export" download class="btn btn-primary">Скачать ZIP ↓</a></div>`;
    $('projectHubBody').innerHTML=hubTop+'<div class="hub-actions">'+actions.join('')+'</div><div class="hub-result" id="hubDiagnostics" hidden></div>';
    if(mode!=='overview')await hubExecute(mode);
    else $('projectHubClose').focus({preventScroll:true});
  }catch(err){toast(err.message,true);closeHub();}
}
async function hubExecute(mode){
  const id=hubProject;if(!id)return;
  const project=state.projects.find(p=>p.id===id);if(!project)return;
  try{
    if(mode==='open'||mode==='automation'||mode==='team'||mode==='cms'){
      const destination=`/workspace/${encodeURIComponent(id)}/`+(mode==='automation'?'#automations':mode==='team'?'#team':mode==='cms'?'admin':'');
      // Direct navigation in the same tab avoids pop-up blockers on mobile.
      window.location.assign(destination);return;
    }
    if(mode==='pages'||mode==='entities'||mode==='workflows'){
      const complete=(await api(`/api/studio/projects/${id}`)).project;
      closeHub();mode==='pages'?pageEditor.open(complete):mode==='entities'?entityEditor.open(complete):workflowUI.open(complete);return;
    }
    if(mode==='deploy'){closeHub();deployWizard.open(project);return;}
    if(mode==='settings'){closeHub();openSettings(id);return;}
    if(mode==='releases'){closeHub();await openReleases(id);return;}
    if(mode==='check'){
      const result=await api(`/api/studio/projects/${id}/diagnostics`);
      $('hubDiagnostics').hidden=false;
      $('hubDiagnostics').innerHTML=`<h3>Проверка проекта: ${result.summary.errors?'есть ошибки':'можно экспортировать'}</h3>`+
        result.checks.map(c=>`<p><strong>${c.level==='ok'?'✓':c.level==='warning'?'!':'×'} ${escape(c.title)}</strong><span>${escape(c.detail)}</span></p>`).join('');
      return;
    }
  }catch(err){toast(err.message,true);}
}
$('projectHubBody').addEventListener('click',e=>{const b=e.target.closest('[data-hub-action]');if(b)hubExecute(b.dataset.hubAction);});
$('projectHubClose').addEventListener('click',closeHub);
hubOverlay.addEventListener('click',e=>{if(e.target===hubOverlay)closeHub();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!hubOverlay.hidden)closeHub();});
function chooseProjectFor(mode){
  const eligible=state.projects.filter(p=>mode==='entities'||mode==='automation'||mode==='workflows'||mode==='team'?p.type==='crm':true).filter(p=>mode==='automation'||mode==='workflows'?p.modules.includes('tasks'):true);
  if(!eligible.length){toast('Сначала создайте подходящий проект.',true);openWizard(['entities','automation','workflows'].includes(mode)?'crm':null,1);return;}
  if(eligible.length===1){mode==='workbench'?workbench.open(eligible[0].id):openProjectHub(eligible[0].id,mode);return;}
  hubMode=mode;hubProject=null;hubOverlay.hidden=false;
  $('projectHubTitle').textContent='Выберите проект';
  $('projectHubSubtitle').textContent='С какой системой хотите работать?';
  $('projectHubBody').innerHTML='<div class="hub-actions">'+eligible.map(p=>hubAction(p.name,p.type==='site'?'Сайт':'CRM · '+p.industry,'select:'+p.id,'▦')).join('')+'</div>';
}
$('projectHubBody').addEventListener('click',e=>{
  const a=e.target.closest('[data-hub-action]')?.dataset.hubAction;
  if(a?.startsWith('select:')){if(hubMode==='workbench'){const selected=a.slice(7);closeHub();workbench.open(selected);}else openProjectHub(a.slice(7),hubMode);}
});
$('navPages').addEventListener('click',()=>chooseProjectFor('pages'));
$('navEntities').addEventListener('click',()=>chooseProjectFor('entities'));
$('navComponents').addEventListener('click',()=>openWizard(null,2));
$('navAutomation').addEventListener('click',()=>chooseProjectFor('workflows'));
$('navTeam').addEventListener('click',()=>chooseProjectFor('team'));
$('navSettings').addEventListener('click',()=>chooseProjectFor('settings'));
$('navPlan').addEventListener('click',()=>{toast('Эта локальная версия работает без тарифов и платёжных подписок.');});
$('futureMobile').addEventListener('click',()=>{toast('Генератор мобильных приложений ещё не реализован. Сейчас доступны CRM и сайты.');});
document.querySelectorAll('[data-start-type]').forEach(b=>b.addEventListener('click',()=>{
 document.querySelectorAll('[data-start-type]').forEach(x=>x.classList.toggle('selected',x===b));
 openWizard(b.dataset.startType,1);
}));
$('projectsList').addEventListener('click',e=>{
 const demo=e.target.closest('[data-demo-type]');
 if(demo){openWizard(demo.dataset.demoType,1);return;}
 if(e.target.closest('[data-open-create]'))openWizard(null,1);
});
document.querySelectorAll('[data-feature]').forEach(b=>b.addEventListener('click',()=>{
 const feature=b.dataset.feature;
 if(feature==='templates')templateUI.showLibrary();
 else if(feature==='modules')openWizard(null,2);
 else if(feature==='design')openWizard(null,3);
 else if(feature==='database')chooseProjectFor('entities');
 else if(feature==='automation')$('navAutomation').click();
 else $('navTeam').click();
}));
$('projectsGridView').addEventListener('click',()=>{projectsListStyle='grid';$('projectsGridView').classList.add('active');$('projectsListView').classList.remove('active');renderProjects()});
$('projectsListView').addEventListener('click',()=>{projectsListStyle='list';$('projectsListView').classList.add('active');$('projectsGridView').classList.remove('active');renderProjects()});
$('projectSort').addEventListener('change',renderProjects);
$('globalSearch').addEventListener('input',renderProjects);
$('notificationButton').addEventListener('click',()=>toast('Новых уведомлений нет.'));
$('profileToggle').addEventListener('click',()=>{$('profileMenu').hidden=!$('profileMenu').hidden});
$('profileLogout').addEventListener('click',()=>{$('profileMenu').hidden=true;$('logoutButton').click()});
document.addEventListener('click',e=>{if(!e.target.closest('.top-profile'))$('profileMenu').hidden=true});
boot();
