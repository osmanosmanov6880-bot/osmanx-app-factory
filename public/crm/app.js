const $=id=>document.getElementById(id);
const base=location.pathname.match(/^(\/workspace\/[0-9a-f-]{36})\//)?.[1]||'';
const S={config:null,session:null,clients:[],visits:[],tasks:[],payments:[],users:[],pages:[],entities:[],view:'dashboard',dialog:null};
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const has=m=>S.config?.modules.includes(m);
const privileged=()=>['admin','manager'].includes(S.session?.user?.role);
const shortDate=x=>x?new Date(x).toLocaleDateString('ru-RU',{day:'2-digit',month:'short',year:'numeric'}):'—';
const fullDate=x=>x?new Date(x).toLocaleString('ru-RU',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
const money=(amount,currency)=>new Intl.NumberFormat('ru-RU',{style:'currency',currency,maximumFractionDigits:2}).format((amount||0)/100);
const sourceLabels={unknown:'Не указан',walkin:'С улицы',social:'Соцсети',referral:'Рекомендация',website:'Сайт',other:'Другое'};
const statusLabels={todo:'К выполнению',doing:'В работе',done:'Завершено',cancelled:'Отменено',pending:'Ожидает',paid:'Оплачено',refunded:'Возврат учтён'};
const roleLabels={admin:'Администратор',manager:'Менеджер',staff:'Сотрудник'};
const methodLabels={cash:'Наличные',bank_transfer:'Перевод',terminal:'Терминал',other:'Другое'};
let toastTimer;
function toast(msg,error=false){const el=$('toast');el.textContent=msg;el.classList.toggle('error',error);el.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.hidden=true,4200);}
async function api(path,{method='GET',body=null,headers={}}={}){
  const h={...headers};if(body!==null)h['Content-Type']='application/json';
  if(!['GET','HEAD'].includes(method)&&S.session?.csrf)h['X-CSRF-Token']=S.session.csrf;
  let response;
  try{response=await fetch(base+path,{method,headers:h,body:body===null?undefined:JSON.stringify(body),credentials:'same-origin'});}
  catch{throw new Error('Нет связи с сервером приложения');}
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error||`Ошибка ${response.status}`);
  return result;
}
function showAuth(){
  $('authScreen').hidden=false;$('appScreen').hidden=true;
  const setup=!S.session?.initialized;
  $('authTitle').textContent=setup?'Создайте администратора':'Вход в систему';
  $('authSubtitle').textContent=setup?'Первый запуск. Создайте защищённую учётную запись владельца CRM.':'Введите данные для работы с клиентами и задачами.';
  $('authNameWrap').hidden=!setup;$('authName').required=setup;
  $('setupTokenWrap').hidden=!setup||!S.config?.requiresSetupToken;
  $('setupToken').required=setup&&!!S.config?.requiresSetupToken;
  $('authPassword').autocomplete=setup?'new-password':'current-password';
  $('authSubmit').firstChild.textContent=setup?'Создать аккаунт ':'Войти ';
}
async function boot(){
  try{
    S.config=(await api('/api/config')).config;
    document.documentElement.style.setProperty('--accent',S.config.settings.accent);
    document.title=`${S.config.name} · OSMANX CRM`;
    S.session=await api('/api/session');
    if(!S.session.authenticated){showAuth();return;}
    await showApp();
  }catch(e){toast(e.message,true);}
}
async function showApp(){
  $('authScreen').hidden=true;$('appScreen').hidden=false;
  $('sideProjectName').textContent=S.config.name;
  $('userFullName').textContent=S.session.user?.name||'Сотрудник';
  $('userInitial').textContent=(S.session.user?.name||'А').slice(0,1).toUpperCase();
  $('userRole').textContent=roleLabels[S.session.user?.role]||S.session.user?.role;
  $('todayLabel').textContent=new Date().toLocaleDateString('ru-RU',{day:'numeric',month:'long',year:'numeric'});
  $('analyticsCurrency').value=S.config.settings.currency;
  document.querySelectorAll('[data-module]').forEach(el=>{el.hidden=!has(el.dataset.module)});
  document.querySelectorAll('[data-roles]').forEach(el=>{el.hidden=!el.dataset.roles.split(',').includes(S.session.user?.role)});
  $('addUser').hidden=S.session.user.role!=='admin';
  const actions={new_client:['+ Добавить клиента','clients'],new_task:['+ Новая задача','tasks'],new_payment:['+ Учесть оплату','payments'],navigate_clients:['Перейти к клиентам','clients'],navigate_overview:['Открыть обзор',null]};
  const action=S.config.settings.primaryAction;
  $('mainAction').textContent=actions[action]?.[0]||'Клиенты';
  $('mainAction').hidden=(action==='new_payment'&&!privileged()) || (action!=='navigate_clients'&&!has(actions[action]?.[1]));
  await loadCustomEntities();
  await loadCustomPages();
  const selected=decodeURIComponent((location.hash.match(/^#page=([a-z0-9-]+)$/)||[])[1]||'');
  await navigate(S.pages.some(p=>p.slug===selected)?'page:'+selected:(location.hash==='#automations'&&privileged()&&has('tasks'))?'automations':location.hash==='#team'?'team':'dashboard');
}
async function loadCustomEntities(){
  const response=await api('/api/entities');S.entities=response.entities;
  $('customEntitiesNav').innerHTML=S.entities.length?'<div class="nav-label nav-separator">ВАШИ ТАБЛИЦЫ</div>'+S.entities.map(e=>`<button type="button" class="nav-item" data-view="entity:${esc(e.slug)}"><span>▦</span> ${esc(e.title)}</button>`).join(''):'';
}
async function loadCustomPages(){
  const r=await api('/api/pages');S.pages=r.pages;
  $('customPagesNav').innerHTML=S.pages.length?'<div class="nav-label nav-separator">ВАШИ СТРАНИЦЫ</div>'+S.pages.map(p=>`<button type="button" class="nav-item" data-view="page:${esc(p.slug)}"><span>◈</span> ${esc(p.title)}</button>`).join(''):'';
}
$('authForm').addEventListener('submit',async e=>{
  e.preventDefault();const btn=$('authSubmit');btn.disabled=true;
  try{
    const setup=!S.session?.initialized,body={email:$('authEmail').value,password:$('authPassword').value};
    const headers={};
    if(setup){
      body.name=$('authName').value;
      if(S.config.requiresSetupToken)body.setup_token=$('setupToken').value;
      if(base){
        const factory=await fetch('/api/studio/session',{credentials:'same-origin'}).then(r=>r.json());
        if(!factory.authenticated)throw new Error('Для создания первого администратора войдите в OSMANX APP FACTORY.');
        headers['x-studio-csrf-token']=factory.csrf;
      }
    }
    const r=await api(`/api/${setup?'setup':'login'}`,{method:'POST',body,headers});
    S.session={authenticated:true,initialized:true,user:r.user,csrf:r.csrf};$('authPassword').value='';await showApp();toast('Доступ открыт');
  }catch(e){toast(e.message,true)}finally{btn.disabled=false;}
});
$('logoutButton').addEventListener('click',async()=>{
  try{await api('/api/logout',{method:'POST',body:{}});S.session={initialized:true,authenticated:false};showAuth();toast('Вы вышли');}
  catch(e){toast(e.message,true)}
});
const viewNames={dashboard:'Обзор',clients:'Клиенты',visits:'Визиты',tasks:'Задачи',payments:'Учёт оплат',analytics:'Аналитика',team:'Команда',automations:'Автоматизации',settings:'О проекте'};
async function navigate(view){
  const isCustom=view.startsWith('page:');
  const isEntity=view.startsWith('entity:');
  const entity=isEntity?S.entities.find(e=>e.slug===view.slice(7)):null;
  if(isEntity&&!entity)return toast('Нет прав или таблица не существует',true);
  const currentPage=isCustom?S.pages.find(p=>p.slug===view.slice(5)):null;
  if(isCustom&&!currentPage)return toast('Страница не опубликована',true);
  S.view=view;
  document.querySelectorAll('.view').forEach(el=>el.hidden=el.id!==(isCustom?'view-custom':isEntity?'view-entity':`view-${view}`));
  document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  $('breadcrumb').textContent=currentPage?.title||entity?.title||viewNames[view]||view;
  if(isCustom)history.replaceState(null,'',location.pathname+'#page='+currentPage.slug);
  else if(location.hash.startsWith('#page=')||location.hash==='#automations')history.replaceState(null,'',location.pathname+(view==='automations'?'#automations':''));
  try{
    if(isEntity){
      await window.crmEntityRuntime.mount({root:$('customEntityBody'),entity,api,toast,role:S.session.user.role});
      return;
    }
    if(currentPage){
      await window.crmPageRuntime.mount({root:$('customPageBody'),page:currentPage,api,navigate,openClient,openTask,openVisit,openPayment,toast,privileged,formatMoney:money,entities:S.entities,role:S.session.user.role,openEntityCreate,pages:S.pages});
      return;
    }
    switch(view){
      case 'dashboard':await loadDashboard();break;
      case 'clients':await loadClients();break;
      case 'visits':await loadVisits();break;
      case 'tasks':await loadTasks();break;
      case 'payments':await loadPayments();break;
      case 'analytics':await loadAnalytics();break;
      case 'team':await loadTeam();break;
      case 'automations':await loadAutomations();break;
      case 'settings':renderSettings();break;
    }
  }catch(e){toast(e.message,true)}
}
async function openEntityCreate(slug){
  const ent=S.entities.find(e=>e.slug===slug);if(!ent||!ent.access.write.includes(S.session.user.role))return toast('Нет прав на создание записи',true);
  await navigate('entity:'+slug);const button=$('customEntityBody').querySelector('[data-entity-create]');if(button)button.click();
}
$('nav').addEventListener('click',e=>{const item=e.target.closest('[data-view]');if(item&&!item.hidden)navigate(item.dataset.view)});
$('mainAction').addEventListener('click',()=>{
  const act=S.config.settings.primaryAction;
  if(act==='new_client')openClient();else if(act==='new_task')openTask();else if(act==='new_payment')openPayment();else navigate(act==='navigate_overview'?'dashboard':'clients');
});
function metric(label,value,icon,foot){return `<div class="kpi"><div class="kpi-header"><span>${esc(label)}</span><span class="kpi-icon">${icon}</span></div><div class="kpi-number">${esc(value)}</div><div class="kpi-foot">${esc(foot)}</div></div>`;}
async function loadDashboard(){
  if(!has('analytics')||!privileged()){
    const clients=has('clients')?(await api('/api/clients')).clients:[];
    const tasks=has('tasks')?(await api('/api/tasks')).tasks:[];
    $('dashboardBody').innerHTML=`<div class="kpi-grid">${metric('Клиенты',clients.length,'◎','Доступные записи, максимум 200')}${metric('Задачи',tasks.length,'☑','Доступные записи, максимум 200')}</div><div class="surface surface-pad"><h3>Рабочее пространство готово</h3><p class="analytics-note">Раздел расширенной аналитики не подключён или недоступен для вашей роли.</p></div>`;
    return;
  }
  const a=(await api('/api/analytics')).analytics;
  const top=`<div class="kpi-grid">${metric('Клиентов в базе',a.totals.clients,'◎','Активные карточки гостей')}${metric('Повторные гости',a.totals.repeatShare+'%','↻',`${a.totals.repeatClients} из ${a.totals.visitedClients} посетивших`)}${metric('Учтено оплат',money(a.totals.paidMinor,a.currency),'▣','Ручной журнал, оплаченные операции')}${metric('Открытые задачи',a.totals.openTasks,'☑',`${a.totals.overdueTasks} просрочено`)}</div>`;
  const tasks=a.latestTasks.length?a.latestTasks.map(t=>`<div class="list-item"><span class="task-dot ${esc(t.priority)}"></span><div class="list-item-body"><strong>${esc(t.title)}</strong><small>${esc(t.client_name||'Без клиента')} · ${esc(t.due_at?shortDate(t.due_at):'Без срока')}</small></div><span class="pill ${esc(t.status)}">${esc(statusLabels[t.status])}</span></div>`).join(''):'<p class="empty-note">Открытых задач пока нет.</p>';
  $('dashboardBody').innerHTML=top+`<div class="dashboard-grid"><div class="surface surface-pad"><div class="card-heading"><div><h3>Учтённые оплаты</h3><p>По месяцам за последние 6 месяцев · ${esc(a.currency)}</p></div><span class="card-mini">MANUAL LEDGER</span></div><div class="chart" id="revenueChart"></div><div class="analytics-note">Данные отражают только вручную внесённые операции в статусе «Оплачено».</div></div><div class="surface surface-pad"><div class="card-heading"><div><h3>Задачи в работе</h3><p>Ближайшие сроки исполнения</p></div><button class="text-button" type="button" id="seeTasks">Все задачи ↗</button></div><div class="stat-list">${tasks}</div></div></div><div class="surface surface-pad"><div class="card-heading"><div><h3>Показатели базы гостей</h3><p>Вычисляются по зарегистрированным посещениям</p></div><span class="card-mini">LIVE METRICS</span></div><div class="stat-list"><div class="stat-item"><span class="stat-name">Зарегистрированных визитов</span><strong>${a.totals.visits}</strong></div><div class="stat-item"><span class="stat-name">Гостей хотя бы с одним визитом</span><strong>${a.totals.visitedClients}</strong></div><div class="stat-item"><span class="stat-name">С двумя или более визитами</span><strong>${a.totals.repeatClients}</strong></div></div></div>`;
  $('seeTasks').addEventListener('click',()=>navigate('tasks'));
  renderChart(a.monthly);
}
function renderChart(monthly){
  const wrap=$('revenueChart');if(!wrap)return;wrap.textContent='';
  const periods=[];
  for(let i=5;i>=0;i--){const d=new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth()-i,1));periods.push(d.toISOString().slice(0,7))}
  const values=periods.map(period=>Number(monthly.find(x=>x.month===period)?.total_minor||0));
  const max=Math.max(1,...values);
  periods.forEach((period,i)=>{
    const group=document.createElement('div');group.className='chart-group';
    const bar=document.createElement('div');bar.className='chart-bar';bar.style.height=`${Math.max(2,values[i]/max*90)}%`;
    bar.title=`${period}: ${money(values[i],S.config.settings.currency)}`;
    const label=document.createElement('span');label.className='chart-label';label.textContent=new Date(period+'-01').toLocaleDateString('ru-RU',{month:'short'});
    group.append(bar,label);wrap.append(group);
  });
}
async function loadClients(search=''){
  const r=await api('/api/clients'+(search?'?q='+encodeURIComponent(search):''));S.clients=r.clients;
  $('clientCount').textContent=`${S.clients.length} записей${S.clients.length===r.limit?' (показаны первые 200)':''}`;
  $('clientsTable').innerHTML=S.clients.length?S.clients.map(c=>`<tr><td><strong>${esc(c.full_name)}</strong><small>${shortDate(c.created_at)}</small></td><td>${esc(c.phone||c.email||'—')}</td><td>${esc(sourceLabels[c.source]||c.source)}</td><td><strong>${c.visit_count}</strong></td><td>${shortDate(c.last_visit_at)}</td><td><button class="table-action" data-action="visit" data-id="${c.id}">+ Визит</button><button class="table-action" data-action="edit-client" data-id="${c.id}">Изменить</button><button class="table-action danger" data-action="archive-client" data-id="${c.id}">Архив</button></td></tr>`).join(''):'<tr><td colspan="6" class="table-empty">Клиентов пока нет. Добавьте первого гостя.</td></tr>';
}
// CSV import/export onboarding, restricted to privileged CRM roles on the server.
let clientCsvContent=null;
function closeClientCsv(){
  $('clientCsvOverlay').hidden=true;$('clientCsvFile').value='';$('clientCsvFileName').textContent='Файл ещё не выбран';clientCsvContent=null;
  $('clientCsvCommit').disabled=true;$('clientCsvPreview').textContent='Файл ещё не выбран.';
}
$('clientImport').addEventListener('click',()=>{$('clientCsvOverlay').hidden=false;$('clientCsvFile').focus()});
$('clientCsvClose').addEventListener('click',closeClientCsv);
$('clientCsvCancel').addEventListener('click',closeClientCsv);
$('clientCsvOverlay').addEventListener('click',e=>{if(e.target===$('clientCsvOverlay'))closeClientCsv()});
$('clientCsvFile').addEventListener('change',async e=>{
  clientCsvContent=null;$('clientCsvCommit').disabled=true;
  const file=e.target.files?.[0];$('clientCsvFileName').textContent=file?.name||'Файл ещё не выбран';if(!file)return;
  if(file.size>115*1024){$('clientCsvPreview').textContent='Файл слишком большой. Максимум 115 КБ.';return;}
  try{
    const csv=await file.text();const result=await api('/api/clients/import-preview',{method:'POST',body:{csv}});
    const a=result.summary;
    $('clientCsvPreview').textContent=`Найдено строк: ${a.total}. Готово к добавлению: ${a.ready}. Пропущено повторов: ${a.duplicates}. Ошибки: ${a.invalid}.` +
      (result.errors.length?'\n'+result.errors.map(x=>`Строка ${x.row}: ${x.error}`).join('\n'):'') +
      (a.invalid?'\nИсправьте ошибки и выберите файл заново.':'\nПредпросмотр не изменил данные.');
    $('clientCsvCommit').disabled=a.invalid>0||a.ready===0;
    clientCsvContent=csv;
  }catch(err){$('clientCsvPreview').textContent=err.message;toast(err.message,true)}
});
$('clientCsvCommit').addEventListener('click',async()=>{
  if(!clientCsvContent)return;
  if(!confirm('Добавить проверенные записи клиентов? Это действие изменит базу CRM.'))return;
  $('clientCsvCommit').disabled=true;
  try{
    const outcome=await api('/api/clients/import',{method:'POST',body:{csv:clientCsvContent,confirm:true}});
    closeClientCsv();toast(`Импортировано клиентов: ${outcome.created}. Дубликаты: ${outcome.duplicates}.`);
    await loadClients($('clientSearch').value.trim());
  }catch(err){toast(err.message,true);$('clientCsvCommit').disabled=false;}
});
$('clientExport').addEventListener('click',async()=>{
  try{
    const resp=await fetch(base+'/api/clients/export',{credentials:'same-origin'});
    if(!resp.ok){const b=await resp.json();throw Error(b.error||'Ошибка экспорта')}
    const blob=await resp.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download='osmanx-clients.csv';document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);toast('CSV-файл клиентов подготовлен. Берегите персональные данные.');
  }catch(err){toast(err.message,true)}
});
let searchTimer;$('clientSearch').addEventListener('input',e=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadClients(e.target.value.trim()).catch(err=>toast(err.message,true)),250)});
$('addClient').addEventListener('click',()=>openClient());
$('clientsTable').addEventListener('click',async e=>{
  const btn=e.target.closest('[data-action]');if(!btn)return;
  const client=S.clients.find(c=>c.id===btn.dataset.id);if(!client)return;
  if(btn.dataset.action==='visit')return openVisit(client.id);
  if(btn.dataset.action==='edit-client')return openClient(client);
  if(btn.dataset.action==='archive-client'){
    if(!confirm(`Переместить «${client.full_name}» в архив? История визитов сохранится.`))return;
    try{await api(`/api/clients/${client.id}`,{method:'DELETE',body:{}});toast('Клиент архивирован');await loadClients($('clientSearch').value)}catch(err){toast(err.message,true)}
  }
});
async function loadVisits(){S.visits=(await api('/api/visits')).visits;
  $('visitsTable').innerHTML=S.visits.length?S.visits.map(v=>`<tr><td><strong>${esc(v.client_name||'Гость')}</strong></td><td>${fullDate(v.occurred_at)}</td><td>${esc(v.note||'—')}</td></tr>`).join(''):'<tr><td colspan="3" class="table-empty">Пока нет зарегистрированных визитов.</td></tr>';
}
$('addVisit').addEventListener('click',()=>openVisit());
async function loadTasks(){S.tasks=(await api('/api/tasks')).tasks;$('taskCount').textContent=`${S.tasks.length} записей`;
  $('tasksTable').innerHTML=S.tasks.length?S.tasks.map(t=>`<tr><td><strong>${esc(t.title)}</strong><small>${esc(t.description.slice(0,65))}</small></td><td>${esc(t.client_name||'—')}</td><td><span class="pill ${esc(t.priority)}">${esc({low:'Низкий',medium:'Средний',high:'Высокий'}[t.priority])}</span></td><td>${shortDate(t.due_at)}</td><td><span class="pill ${esc(t.status)}">${esc(statusLabels[t.status])}</span></td><td>${t.status==='done'||t.status==='cancelled'?`<button class="table-action" data-task="${t.id}" data-status="todo">Возобновить</button>`:`<button class="table-action" data-task="${t.id}" data-status="${t.status==='todo'?'doing':'done'}">${t.status==='todo'?'В работу':'Завершить'}</button>`}</td></tr>`).join(''):'<tr><td colspan="6" class="table-empty">Задач пока нет. Создайте первую.</td></tr>';
}
$('addTask').addEventListener('click',()=>openTask());
$('tasksTable').addEventListener('click',async e=>{const b=e.target.closest('[data-task]');if(!b)return;try{await api('/api/tasks/'+b.dataset.task,{method:'PATCH',body:{status:b.dataset.status}});toast('Статус изменён');await loadTasks()}catch(err){toast(err.message,true)}});
async function loadPayments(){S.payments=(await api('/api/payments')).payments;$('paymentCount').textContent=`${S.payments.length} операций`;
  $('paymentsTable').innerHTML=S.payments.length?S.payments.map(p=>`<tr><td><strong>${money(p.amount_minor,p.currency)}</strong><small>${esc(p.external_reference||'Без внешнего номера')}</small></td><td>${esc(p.client_name||'Без привязки')}</td><td>${esc(methodLabels[p.method]||p.method)}</td><td><span class="pill ${esc(p.status)}">${esc(statusLabels[p.status])}</span></td><td>${shortDate(p.created_at)}</td><td>${p.status==='pending'?`<button class="table-action" data-payment="${p.id}" data-status="paid">Подтвердить</button><button class="table-action" data-payment="${p.id}" data-status="cancelled">Отменить</button>`:p.status==='paid'?`<button class="table-action" data-payment="${p.id}" data-status="refunded">Учесть возврат</button>`:''}</td></tr>`).join(''):'<tr><td colspan="6" class="table-empty">Операций пока нет. Начните учёт.</td></tr>';
}
$('addPayment').addEventListener('click',()=>openPayment());
$('paymentsTable').addEventListener('click',async e=>{
  const b=e.target.closest('[data-payment]');if(!b)return;
  if(b.dataset.status==='refunded'&&!confirm('Это изменит ТОЛЬКО учётный статус. Реальные деньги не возвращаются. Продолжить?'))return;
  try{await api('/api/payments/'+b.dataset.payment,{method:'PATCH',body:{status:b.dataset.status}});toast(b.dataset.status==='refunded'?'Статус «Возврат учтён» установлен. Реальных переводов не было.':'Статус обновлён');await loadPayments()}catch(err){toast(err.message,true)}
});
async function loadAnalytics(){const r=await api('/api/analytics?currency='+encodeURIComponent($('analyticsCurrency').value));const a=r.analytics;
  const stats=`<div class="analytics-grid">${metric('Всего клиентов',a.totals.clients,'◎','Активные карточки')}${metric('Всего визитов',a.totals.visits,'◷','По введённым событиям')}${metric('Повторных гостей',a.totals.repeatClients,'↻','Два визита и более')}${metric('Доля повторных',a.totals.repeatShare+'%','%', 'От всех гостей с визитом')}${metric('Учтено оплат',money(a.totals.paidMinor,a.currency),'▣','Только статус paid')}${metric('Просрочено задач',a.totals.overdueTasks,'!', 'Из открытых задач')}</div>`;
  $('analyticsBody').innerHTML=stats+`<div class="dashboard-grid"><div class="surface surface-pad"><div class="card-heading"><div><h3>Источники клиентов</h3><p>Распределение по отмеченным каналам</p></div></div><div id="sourceBars"></div></div><div class="surface surface-pad"><div class="card-heading"><div><h3>Как считать показатели</h3><p>Прозрачные формулы вместо загадочных оценок</p></div></div><p class="analytics-note">${esc(a.notes.repeatShare)}</p><p class="analytics-note">${esc(a.notes.paidMinor)}</p><p class="analytics-note">Данные обновляются по мере внесения записей. Нет интеграции с кассой и автоматического определения причин возврата.</p></div></div>`;
  const max=Math.max(1,...a.sourceBreakdown.map(x=>x.count));
  const wrap=$('sourceBars');
  if(!a.sourceBreakdown.length)wrap.innerHTML='<p class="empty-note">Добавьте клиентов, чтобы увидеть распределение источников.</p>';
  a.sourceBreakdown.forEach(s=>{
    const row=document.createElement('div');row.className='bar-row';
    const label=document.createElement('span');label.className='bar-title';label.textContent=sourceLabels[s.source]||s.source;
    const track=document.createElement('div');track.className='bar-track';const fill=document.createElement('div');fill.className='bar-fill';fill.style.width=`${s.count/max*100}%`;track.append(fill);
    const n=document.createElement('span');n.className='bar-value';n.textContent=s.count;row.append(label,track,n);wrap.append(row);
  });
}
$('analyticsCurrency').addEventListener('change',()=>loadAnalytics().catch(e=>toast(e.message,true)));
async function loadTeam(){S.users=(await api('/api/users')).users;$('teamCount').textContent=`${S.users.length} сотрудников`;
  $('teamTable').innerHTML=S.users.map(u=>`<tr><td><strong>${esc(u.name)}</strong></td><td>${esc(u.email)}</td><td><span class="pill">${esc(roleLabels[u.role]||u.role)}</span></td><td>${u.active?'Активен':'Отключён'}</td></tr>`).join('');
}
$('addUser').addEventListener('click',()=>openUser());
function renderSettings(){const cfg=S.config;
  $('settingsDetails').innerHTML=[['Название',cfg.name],['Отрасль',({restaurant:'Ресторан / кофейня',dental:'Стоматология',auto:'Автосервис',beauty:'Салон красоты',retail:'Магазин одежды'})[cfg.industry]||cfg.industry],['Подключённые модули',cfg.modules.join(', ')],['Главная кнопка',cfg.settings.primaryAction],['Акцентный цвет',cfg.settings.accent],['Валюта учёта',cfg.settings.currency],['Платежи','Ручной журнал — без эквайринга'],['Хранение','Локальная SQLite-база проекта'],['Идентификатор',cfg.id]].map(([k,v])=>`<div class="settings-row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
}
function inputHtml(field){
  const id=`f_${field.name}`,label=`<label for="${id}">${esc(field.label)}${field.required?' *':''}</label>`;
  const val=esc(field.value??'');let input;
  if(field.options){input=`<select id="${id}" name="${esc(field.name)}" ${field.required?'required':''}><option value="">Не выбрано</option>${field.options.map(o=>`<option value="${esc(o.value)}" ${String(o.value)===String(field.value)?'selected':''}>${esc(o.label)}</option>`).join('')}</select>`;}
  else if(field.type==='textarea'){input=`<textarea id="${id}" name="${esc(field.name)}" maxlength="${field.max||600}" placeholder="${esc(field.placeholder||'')}" >${val}</textarea>`;}
  else input=`<input id="${id}" type="${esc(field.type||'text')}" name="${esc(field.name)}" value="${val}" ${field.required?'required':''} maxlength="${field.max||180}" ${field.min?'min="'+esc(field.min)+'"':''} step="${esc(field.step||'any')}" placeholder="${esc(field.placeholder||'')}">`;
  return `<div class="field">${label}${input}${field.help?`<small>${esc(field.help)}</small>`:''}</div>`;
}
function dialog({title,eyebrow='НОВАЯ ЗАПИСЬ',fields,save,submit='Сохранить'}){
  S.dialog=save;$('dialogTitle').textContent=title;$('dialogEyebrow').textContent=eyebrow;$('dialogSubmit').textContent=submit;
  $('dialogFields').innerHTML=fields.map(inputHtml).join('');$('dialogOverlay').hidden=false;
  const first=$('dialogFields').querySelector('input,select,textarea');if(first)first.focus();
}
function closeDialog(){$('dialogOverlay').hidden=true;S.dialog=null;$('dialogForm').reset()}
$('closeDialog').addEventListener('click',closeDialog);$('cancelDialog').addEventListener('click',closeDialog);
$('dialogOverlay').addEventListener('click',e=>{if(e.target===$('dialogOverlay'))closeDialog()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('dialogOverlay').hidden)closeDialog()});
$('dialogForm').addEventListener('submit',async e=>{
  e.preventDefault();const btn=$('dialogSubmit');btn.disabled=true;
  try{
    const raw=Object.fromEntries(new FormData(e.target).entries());
    await S.dialog(raw);closeDialog();toast('Сохранено');await navigate(S.view);
  }catch(err){toast(err.message,true)}finally{btn.disabled=false}
});
function openClient(existing=null){
  dialog({title:existing?'Редактировать клиента':'Новый клиент',eyebrow:'GUEST PROFILE',fields:[
    {name:'full_name',label:'Имя гостя',required:true,value:existing?.full_name,placeholder:'Имя и фамилия'},
    {name:'phone',label:'Телефон',value:existing?.phone,max:35,placeholder:'+7 999 000 00 00'},
    {name:'email',label:'Email',type:'email',value:existing?.email,max:254},
    {name:'source',label:'Источник',value:existing?.source||'unknown',options:Object.entries(sourceLabels).map(([value,label])=>({value,label}))},
    {name:'notes',label:'Комментарий',type:'textarea',value:existing?.notes,max:1500}],
    save:async raw=>{await api(existing?`/api/clients/${existing.id}`:'/api/clients',{method:existing?'PATCH':'POST',body:raw})}});
}
async function openVisit(clientId=null){
  try{
    const list=(await api('/api/clients')).clients;
    if(!list.length)return toast('Сначала добавьте клиента',true);
    dialog({title:'Новый визит',eyebrow:'GUEST HISTORY',fields:[
      {name:'client_id',label:'Гость',required:true,value:clientId||'',options:list.map(c=>({value:c.id,label:c.full_name}))},
      {name:'occurred_at',label:'Дата и время',type:'datetime-local',value:'',help:'Если не указать, будет использовано текущее время сервера'},
      {name:'note',label:'Комментарий',type:'textarea',max:600}],
      save:raw=>api('/api/visits',{method:'POST',body:{...raw,occurred_at:raw.occurred_at?new Date(raw.occurred_at).toISOString():null}})});
  }catch(e){toast(e.message,true)}
}
async function openTask(){
  try{
    const [clients,users]=await Promise.all([has('clients')?api('/api/clients'):Promise.resolve({clients:[]}),api('/api/users')]);
    dialog({title:'Новая задача',eyebrow:'TEAM OPERATIONS',fields:[
      {name:'title',label:'Что нужно сделать?',required:true,max:180,placeholder:'Например, уточнить отзыв гостя'},
      {name:'description',label:'Описание',type:'textarea',max:1500},
      {name:'priority',label:'Приоритет',value:'medium',options:[{value:'low',label:'Низкий'},{value:'medium',label:'Средний'},{value:'high',label:'Высокий'}]},
      {name:'client_id',label:'Связанный гость',options:clients.clients.map(c=>({value:c.id,label:c.full_name}))},
      {name:'assigned_to',label:'Ответственный',options:users.users.filter(u=>u.active).map(u=>({value:u.id,label:u.name}))},
      {name:'due_at',label:'Срок',type:'datetime-local'}],
      save:raw=>api('/api/tasks',{method:'POST',body:{...raw,due_at:raw.due_at?new Date(raw.due_at).toISOString():null}})});
  }catch(e){toast(e.message,true)}
}
async function openPayment(){
  if(!privileged())return toast('Только администратор и менеджер могут учитывать оплаты',true);
  try{
    const clients=has('clients')?(await api('/api/clients')).clients:[];
    dialog({title:'Учесть оплату',eyebrow:'MANUAL LEDGER ONLY',fields:[
      {name:'amount',label:'Сумма (рубли / евро / доллары)',type:'text',required:true,placeholder:'1500.00',help:'Регистрируется только запись. Реальное списание денег не производится.'},
      {name:'currency',label:'Валюта',value:S.config.settings.currency,options:['RUB','EUR','USD'].map(v=>({value:v,label:v}))},
      {name:'method',label:'Способ',required:true,value:'cash',options:Object.entries(methodLabels).map(([value,label])=>({value,label}))},
      {name:'status',label:'Статус',value:'paid',options:[{value:'paid',label:'Оплачено (подтверждено вручную)'},{value:'pending',label:'Ожидает'}]},
      {name:'client_id',label:'Клиент',options:clients.map(c=>({value:c.id,label:c.full_name}))},
      {name:'external_reference',label:'Внешний номер',max:120,placeholder:'Чек / номер операции'},
      {name:'note',label:'Примечание',type:'textarea',max:600}],
      save:async raw=>{
        if(!/^\d+(\.\d{1,2})?$/.test(raw.amount))throw new Error('Укажите сумму с максимум двумя знаками после точки');
        const amount_minor=Math.round(Number(raw.amount)*100);
        await api('/api/payments',{method:'POST',body:{...raw,amount_minor}});
      }});
  }catch(e){toast(e.message,true)}
}
function openUser(){
  if(S.session?.user?.role!=='admin')return toast('Нет прав администратора',true);
  dialog({title:'Добавить сотрудника',eyebrow:'ACCESS MANAGEMENT',fields:[
    {name:'name',label:'Имя',required:true,max:80},
    {name:'email',label:'Email',required:true,type:'email',max:254},
    {name:'password',label:'Временный пароль',required:true,type:'password',max:128,help:'Не менее 12 символов; передайте сотруднику по защищённому каналу.'},
    {name:'role',label:'Роль',required:true,value:'staff',options:[{value:'staff',label:'Сотрудник — без финансовых данных'},{value:'manager',label:'Менеджер — с учётом и аналитикой'}]}],
    save:raw=>api('/api/users',{method:'POST',body:raw})});
}
boot();

// R1.0 — rule builder: event → entity → condition → task. No executable formulas.
let automationCapabilities={entities:[]};
function updateAutomationControls(){
  const custom=$('automationEvent').value==='entity_created';
  $('automationEntityOptions').hidden=!custom;
  $('automationEntity').required=custom;
  const entity=automationCapabilities.entities.find(x=>x.slug===$('automationEntity').value);
  const prev=$('automationConditionField').value;
  $('automationConditionField').innerHTML='<option value="">Для каждой новой записи</option>'+(entity?.fields||[]).map(f=>`<option value="${esc(f.key)}">${esc(f.label)}</option>`).join('');
  if((entity?.fields||[]).some(f=>f.key===prev))$('automationConditionField').value=prev;
  updateAutomationConditionValue();
}
function updateAutomationConditionValue(){
  const entity=automationCapabilities.entities.find(x=>x.slug===$('automationEntity').value);
  const field=entity?.fields.find(f=>f.key===$('automationConditionField').value);
  $('automationConditionWrap').hidden=!field;
  $('automationConditionValue').hidden=!field||['boolean','select'].includes(field.type);
  $('automationConditionChoice').hidden=!field||!['boolean','select'].includes(field.type);
  if(!field)return;
  if(['boolean','select'].includes(field.type)){
    const options=field.type==='boolean'?['true','false']:(field.options||[]);
    $('automationConditionChoice').innerHTML=options.map(v=>`<option value="${esc(v)}">${esc(v==='true'?'Да':v==='false'?'Нет':v)}</option>`).join('');
  }
  $('automationConditionValue').placeholder=field.type==='integer'?'Например, 5':'Точное значение поля';
}
$('automationEvent').addEventListener('change',updateAutomationControls);
$('automationEntity').addEventListener('change',updateAutomationControls);
$('automationConditionField').addEventListener('change',updateAutomationConditionValue);
async function loadAutomations(){
  const [rules,runs]=await Promise.all([api('/api/automations'),api('/api/automations/runs')]);
  automationCapabilities=rules.capabilities||{entities:[]};
  const current=$('automationEntity').value;
  $('automationEntity').innerHTML=automationCapabilities.entities.map(e=>`<option value="${esc(e.slug)}">${esc(e.title)}</option>`).join('');
  if(automationCapabilities.entities.some(e=>e.slug===current))$('automationEntity').value=current;
  updateAutomationControls();
  const title=rule=>rule.event==='entity_created'?'Таблица «'+(automationCapabilities.entities.find(x=>x.slug===rule.entity_slug)?.title||rule.entity_slug)+'»':rule.event==='client_created'?'Новый клиент':'Новый визит';
  $('automationList').innerHTML=rules.automations.length?rules.automations.map(rule=>`<div class="automation-item"><div><strong>${esc(rule.name)}</strong><p>${esc(title(rule))}${rule.condition_field?' · '+esc(rule.condition_field)+' = '+esc(rule.condition_value):''} → ${esc(rule.task_title)} · ${rule.due_days?'срок '+rule.due_days+' дн. · ':''}${rule.priority==='high'?'Высокий':rule.priority==='low'?'Низкий':'Обычный'} приоритет</p></div><div class="automation-actions"><button type="button" class="button outline small" data-automation-toggle="${esc(rule.id)}" data-enabled="${rule.enabled?1:0}">${rule.enabled?'Отключить':'Включить'}</button><button type="button" class="button outline small" data-automation-delete="${esc(rule.id)}">Удалить</button></div></div>`).join(''):'<p>Пока нет правил. Добавьте первое правило выше.</p>';
  $('automationRuns').innerHTML=runs.runs.length?runs.runs.slice(0,30).map(run=>`<div class="automation-item"><div><strong>${esc(run.automation_name)}</strong><p>${fullDate(run.created_at)} · Задача создана</p></div></div>`).join(''):'<p>Срабатываний пока нет.</p>';
}
$('automationForm').addEventListener('submit',async e=>{
  e.preventDefault();const btn=e.submitter;btn.disabled=true;
  try{
    const event=$('automationEvent').value,custom=event==='entity_created';
    const condition=custom?$('automationConditionField').value:'';
    const field=custom?automationCapabilities.entities.find(x=>x.slug===$('automationEntity').value)?.fields.find(f=>f.key===condition):null;
    const value=field?(['select','boolean'].includes(field.type)?$('automationConditionChoice').value:$('automationConditionValue').value):undefined;
    const body={name:$('automationName').value,event,task_title:$('automationTitle').value,priority:$('automationPriority').value,due_days:Number($('automationDueDays').value)};
    if(custom){body.entity_slug=$('automationEntity').value;if(condition){body.condition_field=condition;body.condition_value=value;}}
    await api('/api/automations',{method:'POST',body});
    e.target.reset();await loadAutomations();toast('Правило сохранено и включено');
  }catch(err){toast(err.message,true)}finally{btn.disabled=false}
});
$('automationList').addEventListener('click',async e=>{
  const toggle=e.target.closest('[data-automation-toggle]');const del=e.target.closest('[data-automation-delete]');
  if(!toggle&&!del)return;
  try{
    if(toggle)await api('/api/automations/'+toggle.dataset.automationToggle,{method:'PATCH',body:{enabled:toggle.dataset.enabled!=='1'}});
    if(del && confirm('Удалить правило? Ранее созданные задачи останутся.'))await api('/api/automations/'+del.dataset.automationDelete,{method:'DELETE',body:{}});
    await loadAutomations();toast('Сохранено');
  }catch(err){toast(err.message,true)}
});
