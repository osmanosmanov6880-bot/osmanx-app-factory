// Published page interpreter. Only a fixed allowlist of components, fields and actions.
// No eval, HTML injection, dynamic SQL, arbitrary endpoint or outside URLs.
(function(){
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={full_name:'Гость',phone:'Телефон',email:'Email',source:'Источник',notes:'Примечание',title:'Название',description:'Описание',priority:'Приоритет',due_at:'Срок'};
const priorities={low:'Низкий',medium:'Обычный',high:'Высокий'};
const sources={unknown:'Не указан',walkin:'С улицы',social:'Соцсети',referral:'Рекомендация',website:'Сайт',other:'Другое'};
const metricNote={clients_total:'Активные карточки гостей',visits_total:'Все зарегистрированные визиты',open_tasks:'Статусы: к выполнению и в работе',repeat_share:'Среди гостей с визитами',paid_minor:'Ручной журнал учёта, не банковская выручка'};
function inputField(name){
  const title=names[name]||name, required=['full_name','title'].includes(name)?'required':'';
  if(name==='notes'||name==='description')return `<label class="page-field"><span>${title}</span><textarea name="${name}" maxlength="${name==='notes'?1500:1500}" rows="3"></textarea></label>`;
  if(name==='source'||name==='priority'){
    const values=name==='source'?sources:priorities;
    return `<label class="page-field"><span>${title}</span><select name="${name}">${Object.entries(values).map(([k,v])=>`<option value="${k}">${esc(v)}</option>`).join('')}</select></label>`;
  }
  const type=name==='email'?'email':name==='phone'?'tel':name==='due_at'?'datetime-local':'text';
  return `<label class="page-field"><span>${title}</span><input type="${type}" name="${name}" ${required} maxlength="${name==='full_name'?120:name==='title'?180:254}" autocomplete="off"></label>`;
}
function render(block,ctx){
 const custom=block.entity?.startsWith('custom:')?ctx.entities.find(e=>e.slug===block.entity.slice(7)):null;
 const fieldMap=custom?Object.fromEntries(custom.fields.map(f=>[f.key,f])):null;
 switch(block.type){
  case 'hero':return `<section class="page-hero"><span>${esc(block.eyebrow)}</span><h2>${esc(block.title)}</h2><p>${esc(block.subtitle)}</p></section>`;
  case 'text':return `<section class="page-text"><h3>${esc(block.title)}</h3><p>${esc(block.body)}</p></section>`;
  case 'metric':{
    if(block.metric==='entity_count'){
      const source=ctx.entities.find(e=>'custom:'+e.slug===block.entity);
      if(!source||!source.access.read.includes(ctx.role))return '';
      return `<section class="page-metric"><span>${esc(block.label)}</span><strong data-entity-count="${esc(source.slug)}">—</strong><small>Активных записей из «${esc(source.title)}»</small></section>`;
    }
    return `<section class="page-metric"><span>${esc(block.label)}</span><strong data-metric="${block.metric}">—</strong><small>${esc(metricNote[block.metric]||'')}</small></section>`;
  }
  case 'button':{
    const customAction=block.action.includes(':custom:')?ctx.entities.find(e=>e.slug===block.action.split(':')[2]):null;
    if(!(block.roles||['admin','manager','staff']).includes(ctx.role))return '';
    const privilegedOnly=['create:payments','navigate:payments','navigate:analytics'].includes(block.action);
    if(privilegedOnly&&!ctx.privileged())return '';
    if(customAction&&!customAction.access[block.action.startsWith('create:')?'write':'read'].includes(ctx.role))return '';
    return `<div class="page-action"><button type="button" class="button ${block.style==='secondary'?'outline':'primary'}" data-custom-action="${esc(block.action)}" data-custom-confirm="${block.confirm?'1':'0'}" data-custom-confirm-text="${esc(block.confirmText||'')}" data-custom-message="${esc(block.message||'')}">${esc(block.label)} <span>↗</span></button></div>`;
  }
  case 'form':{
    if(custom&&!custom.access.write.includes(ctx.role))return '';
    const fields=custom?block.fields.map(k=>window.crmEntityRuntime.input(fieldMap[k],null,{})).join(''):block.fields.map(inputField).join('');
    return `<section class="page-form surface surface-pad"><div class="page-card-head"><span>НОВАЯ ЗАПИСЬ</span><h3>${esc(block.title)}</h3></div><form data-custom-form="${esc(block.entity)}" data-page-form-id="${esc(block.id)}" class="page-data-form"><div class="page-form-grid">${fields}</div><button class="button primary" type="submit">${esc(block.submitLabel)} ↗</button></form></section>`;
  }
  case 'table':return `<section class="page-table surface"><div class="page-card-head"><span>ДАННЫЕ ИЗ CRM</span><h3>${esc(block.title)}</h3></div><div class="page-table-scroller"><table><thead><tr>${block.columns.map(c=>`<th>${esc(fieldMap?.[c]?.label||names[c]||c)}</th>`).join('')}</tr></thead><tbody data-table-block="${esc(block.id)}"><tr><td colspan="${block.columns.length}">Загружаем записи...</td></tr></tbody></table></div><div class="page-table-foot">Последние ${[5,10,20].includes(block.limit)?block.limit:10} записей из текущей выборки.</div></section>`;
  case 'divider':return '<div class="page-divider" aria-hidden="true"></div>';
  default:return '';
 }
}
function cell(value,key){
  if(value==null||value==='')return '—';
  if(key==='source')return sources[value]||value;
  if(key==='priority')return priorities[value]||value;
  if(key==='due_at'){const dt=new Date(value);return Number.isNaN(dt.getTime())?'—':dt.toLocaleString('ru-RU',{day:'numeric',month:'short',year:'numeric'});}
  return String(value);
}
function confirmPageAction(root,message){
 return new Promise(resolve=>{
  const layer=document.createElement('div');layer.className='page-confirm-layer';
  layer.innerHTML=`<div role="dialog" aria-modal="true" aria-label="Подтверждение действия" class="page-confirm-card"><span>ПОДТВЕРЖДЕНИЕ</span><h3>Выполнить действие?</h3><p></p><div><button type="button" data-answer="cancel" class="button outline">Отмена</button><button type="button" data-answer="yes" class="button primary">Продолжить</button></div></div>`;
  layer.querySelector('p').textContent=message||'Подтвердите выбранное действие.';
  root.append(layer);const yes=layer.querySelector('[data-answer="yes"]');yes.focus();
  let done=false;const finish=value=>{if(done)return;done=true;document.removeEventListener('keydown',onKey,true);layer.remove();resolve(value);};
  const onKey=e=>{if(e.key==='Escape'){e.preventDefault();finish(false);}};
  document.addEventListener('keydown',onKey,true);
  layer.addEventListener('click',e=>{const answer=e.target.closest('[data-answer]')?.dataset.answer;if(answer)finish(answer==='yes');else if(e.target===layer)finish(false);});
 });
}
async function mount({root,page,api,navigate,openClient,openTask,openVisit,openPayment,toast,privileged,formatMoney,entities=[],role='staff',openEntityCreate,pages=[]}){
 const ctx={privileged,entities,role};
 root.innerHTML=`<div class="page-title"><div><div class="eyebrow">РАБОЧАЯ СТРАНИЦА / ${esc(page.slug.toUpperCase())}</div><h1>${esc(page.title)}<span class="accent-dot">.</span></h1><p>${esc(page.description)}</p></div><span class="page-published">● НАСТРОЕНО В OSMANX STUDIO</span></div><div class="page-blocks">${page.blocks.map(b=>{const html=render(b,ctx);return html?`<div class="page-layout-item page-layout-${['wide','half','third'].includes(b.layout)?b.layout:b.type==='metric'?'half':'wide'}">${html}</div>`:'';}).join('')}</div>`;
 root.onclick=async e=>{
  const button=e.target.closest('[data-custom-action]');if(!button)return;
  const action=button.dataset.customAction;
  if(button.dataset.customConfirm==='1'&&!await confirmPageAction(root,button.dataset.customConfirmText))return;
  if(action==='notice'){toast(button.dataset.customMessage||'Готово');return;}
  if(action.startsWith('navigate:page:')){
    const slug=action.slice('navigate:page:'.length);
    const destination=pages.find(p=>p.slug===slug&&p.published);
    if(!destination)return toast('Страница не опубликована или недоступна',true);
    return navigate('page:'+slug);
  }
  if(action.startsWith('create:custom:'))return openEntityCreate?.(action.split(':')[2]);
  if(action.startsWith('navigate:custom:'))return navigate('entity:'+action.split(':')[2]);
  const actions={'create:clients':openClient,'create:tasks':openTask,'create:visits':openVisit,'create:payments':privileged()?openPayment:null};
  if(actions[action])return actions[action]();
  const target=action.startsWith('navigate:')?action.slice('navigate:'.length):null;
  if(['dashboard','clients','visits','tasks','payments','analytics'].includes(target)){
    if(['payments','analytics'].includes(target)&&!privileged())return toast('Недостаточно прав',true);
    navigate(target);
  }
 };
 root.onsubmit=async e=>{
  const form=e.target.closest('form[data-custom-form]');if(!form)return;e.preventDefault();
  const entity=form.dataset.customForm;
  const custom=entity.startsWith('custom:')?entities.find(e=>e.slug===entity.slice(7)):null;
  if(!custom&&!['clients','tasks'].includes(entity))return;
  if(custom&&!custom.access.write.includes(role))return toast('Нет прав на создание записи',true);
  const body=custom?{values:window.crmEntityRuntime.valuesFrom(form,custom)}:Object.fromEntries(new FormData(form).entries());
  if(body.due_at){const parsed=new Date(body.due_at);if(Number.isNaN(parsed.getTime()))return toast('Некорректная дата',true);body.due_at=parsed.toISOString();}
  const submit=form.querySelector('[type=submit]');submit.disabled=true;
  try{await api(custom?`/api/entities/${custom.slug}/rows`:'/api/'+entity,{method:'POST',body});const configured=page.blocks.find(b=>b.id===form.dataset.pageFormId);toast(configured?.successText||'Запись успешно сохранена');await mount({root,page,api,navigate,openClient,openTask,openVisit,openPayment,toast,privileged,formatMoney,entities,role,openEntityCreate,pages});}
  catch(err){toast(err.message,true);submit.disabled=false;}
 };
 const metricNodes=[...root.querySelectorAll('[data-metric]')];
 if(metricNodes.length){
  try{const r=await api('/api/page-metrics');
   for(const node of metricNodes){const key=node.dataset.metric,val=r.metrics[key];
    if(val===undefined){node.textContent='Нет доступа';node.classList.add('page-metric-restricted');}
    else if(key==='paid_minor')node.textContent=formatMoney(val,r.currency);
    else node.textContent=key==='repeat_share'?`${val}%`:new Intl.NumberFormat('ru-RU').format(val);
   }
  }catch(err){for(const node of metricNodes)node.textContent='Недоступно';}
 }
 // Entity counters are read through role-checked custom entity APIs; studio never embeds client data.
 for(const node of root.querySelectorAll('[data-entity-count]')){
  const slug=node.dataset.entityCount;
  try{const response=await api(`/api/entities/${encodeURIComponent(slug)}/rows?limit=1`);node.textContent=new Intl.NumberFormat('ru-RU').format(response.total);}
  catch(err){node.textContent='Нет доступа';node.classList.add('page-metric-restricted');}
 }
 // Load reference options for generated forms from the real database.
 for(const form of root.querySelectorAll('form[data-custom-form^="custom:"]')){
  const ent=entities.find(e=>e.slug===form.dataset.customForm.slice(7));if(!ent)continue;
  if(!ent.fields.some(f=>f.type==='reference'&&page.blocks.some(b=>b.entity===form.dataset.customForm&&b.fields?.includes(f.key))))continue;
  try{const refs=await window.crmEntityRuntime.references(ent,api);
    const block=page.blocks.find(b=>b.type==='form'&&b.entity===form.dataset.customForm);
    form.querySelector('.page-form-grid').innerHTML=block.fields.map(k=>window.crmEntityRuntime.input(ent.fields.find(f=>f.key===k),null,refs)).join('');
  }catch(err){toast('Не удалось загрузить связанные записи: '+err.message,true);}
 }
 // Read-only display: creating/updating records always uses secured CRM routes.
 for(const block of page.blocks.filter(b=>b.type==='table')){
  const tbody=[...root.querySelectorAll('[data-table-block]')].find(n=>n.dataset.tableBlock===block.id);
  if(!tbody)continue;
  try{
   const custom=block.entity.startsWith('custom:')?entities.find(e=>e.slug===block.entity.slice(7)):null;
   const rows=custom?(await api(`/api/entities/${custom.slug}/rows?limit=${[5,10,20].includes(block.limit)?block.limit:10}`)).rows:(await api('/api/'+block.entity))[block.entity]||[];
   tbody.innerHTML=rows.slice(0,[5,10,20].includes(block.limit)?block.limit:10).map(row=>`<tr>${block.columns.map(col=>`<td>${esc(custom?window.crmEntityRuntime.display(row[col],custom.fields.find(f=>f.key===col)):cell(row[col],col))}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${block.columns.length}">Пока нет записей. Добавьте первую через форму.</td></tr>`;
  }catch(err){tbody.innerHTML=`<tr><td colspan="${block.columns.length}">${esc(err.message)}</td></tr>`;}
 }
}
window.crmPageRuntime={mount};
})();
