// Offline visual page builder. No custom HTML/JS or free-form API execution.
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const FIELDS={clients:{full_name:'Имя гостя',phone:'Телефон',email:'Email',source:'Источник',notes:'Примечание'},tasks:{title:'Название',description:'Описание',priority:'Приоритет',due_at:'Срок'}};
const entityFields=(name,entities=[])=>name.startsWith('custom:')?Object.fromEntries((entities.find(e=>e.slug===name.slice(7))?.fields||[]).map(f=>[f.key,f.label])):FIELDS[name]||{};
const requiredKeys=(name,entities=[])=>name.startsWith('custom:')?(entities.find(e=>e.slug===name.slice(7))?.fields||[]).filter(f=>f.required).map(f=>f.key):[name==='clients'?'full_name':'title'];
const entityChoices=(project)=>[
 ...Object.keys(FIELDS).filter(k=>project.modules.includes(k)).map(k=>[k,k==='clients'?'Клиенты':'Задачи']),
 ...(project.entities||[]).map(e=>['custom:'+e.slug,e.title])
];
const actionChoices=(project,pages=[])=>[
 ...Object.entries(ACTIONS).filter(([,v])=>project.modules.includes(v[1])).map(([k,v])=>[k,v[0]]),
 ...(project.entities||[]).flatMap(e=>[['navigate:custom:'+e.slug,'Открыть: '+e.title],['create:custom:'+e.slug,'Создать: '+e.title]]),
 ...pages.map(p=>['navigate:page:'+p.slug,'Страница: '+p.title])
];
const METRICS={clients_total:['Гости в базе','clients'],visits_total:['Визиты','clients'],open_tasks:['Открытые задачи','tasks'],repeat_share:['Повторные гости, %','analytics'],paid_minor:['Учтено оплат','payments']};
const ACTIONS={'navigate:dashboard':['Открыть обзор','auth'],'navigate:clients':['Открыть клиентов','clients'],'navigate:visits':['Перейти к визитам','clients'],'navigate:tasks':['Открыть задачи','tasks'],'navigate:payments':['Открыть оплаты','payments'],'navigate:analytics':['Открыть аналитику','analytics'],'create:clients':['Добавить гостя','clients'],'create:tasks':['Создать задачу','tasks'],'create:visits':['Добавить визит','clients'],'create:payments':['Учесть оплату','payments'],'notice':['Показать уведомление','auth']};
const TYPES=[['hero','Заголовок','◈','Вступительный блок'],['metric','Показатель','▥','Данные из CRM'],['text','Текст','≡','Информационный блок'],['button','Кнопка','↗','Действие по клику'],['form','Форма','▤','Новая запись'],['table','Таблица','⊞','Живые данные'],['divider','Разделитель','—','Визуальный отступ']];
const SITE_TYPES=[['hero','Первый экран','◈','Крупный заголовок'],['text','Секция текста','≡','О компании и услугах'],['features','Преимущества','▦','Карточки услуг'],['button','Ссылка-кнопка','↗','Переход на страницу'],['form','Форма заявки','✉','Контактные данные'],['divider','Разделитель','—','Пространство']];
const newId=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');
const opts=(items,value)=>items.map(([k,n])=>`<option value="${esc(k)}" ${k===value?'selected':''}>${esc(n)}</option>`).join('');
const field=(label,key,value,textarea=false,limit=240)=>`<label class="ed-field"><span>${esc(label)}</span>${textarea?`<textarea rows="3" data-block-prop="${key}" maxlength="${limit}">${esc(value)}</textarea>`:`<input data-block-prop="${key}" maxlength="${limit}" value="${esc(value)}">`}</label>`;
const select=(label,key,items,value)=>`<label class="ed-field"><span>${esc(label)}</span><select data-block-prop="${key}">${opts(items,value)}</select></label>`;
function draft(type,modules,customEntities=[]){
 const b={id:newId(),type,layout:type==='metric'?'half':'wide'},client=modules.includes('clients'),entity=client?'clients':modules.includes('tasks')?'tasks':('custom:'+customEntities[0]?.slug);
 if(type==='hero')return {...b,eyebrow:'ВАШ РЕСТОРАН',title:'Новая страница ресторана',subtitle:'Измените заголовок, данные и действия в редакторе.'};
 if(type==='text')return {...b,title:'Новый раздел',body:'Здесь можно описать процесс, услугу или инструкцию.'};
 if(type==='metric')return {...b,label:client?'Гости в базе':modules.includes('tasks')?'Открытые задачи':'Записей в таблице',metric:client?'clients_total':modules.includes('tasks')?'open_tasks':'entity_count',...(client||modules.includes('tasks')?{}:{entity})};
 if(type==='button')return {...b,label:client?'Добавить гостя':'Открыть обзор',action:client?'create:clients':'navigate:dashboard',style:'primary',roles:['admin','manager','staff'],confirm:false,confirmText:'',message:''};
 if(type==='form')return {...b,entity,title:client?'Новый гость':'Новая запись',fields:entity.startsWith('custom:')?Array.from(new Set([...requiredKeys(entity,customEntities),...Object.keys(entityFields(entity,customEntities)).slice(0,2)])):client?['full_name','phone','source']:['title','description','priority'],submitLabel:'Сохранить запись',successText:'Запись успешно сохранена'};
 if(type==='table')return {...b,entity,title:client?'Гости':'Записи',columns:entity.startsWith('custom:')?Object.keys(entityFields(entity,customEntities)).slice(0,3):client?['full_name','phone','source']:['title','priority','due_at'],limit:10};
 return b;
}
function siteDraft(type){
 const b={id:newId(),type,layout:'wide'};
 if(type==='hero')return {...b,eyebrow:'ПРОФЕССИОНАЛЬНЫЙ ПОДХОД',title:'Заголовок вашей страницы',subtitle:'Опишите преимущество и услуги вашей компании.'};
 if(type==='text')return {...b,title:'О компании',body:'Добавьте здесь описание услуги, процесса или команды.'};
 if(type==='features')return {...b,title:'Наши преимущества',items:[{title:'Качество',body:'Внимание к деталям и задачам.'},{title:'Прозрачность',body:'Понятные этапы работы.'}]};
 if(type==='button')return {...b,label:'Связаться с нами',href:'/contacts',style:'primary'};
 if(type==='form')return {...b,title:'Оставить обращение',submitLabel:'Отправить заявку'};
 return b;
}
function sitePreview(b){
 if(b.type==='hero')return `<div class="ed-pv-hero"><small>${esc(b.eyebrow)}</small><h2>${esc(b.title)}</h2><p>${esc(b.subtitle)}</p></div>`;
 if(b.type==='text')return `<div class="ed-pv-text"><h3>${esc(b.title)}</h3><p>${esc(b.body)}</p></div>`;
 if(b.type==='features')return `<div class="ed-pv-table"><h3>${esc(b.title)}</h3><div class="ed-pv-form-grid">${(b.items||[]).map(x=>`<label>${esc(x.title)}<p>${esc(x.body)}</p></label>`).join('')}</div></div>`;
 if(b.type==='button')return `<div class="ed-pv-cta"><span class="ed-pv-button ${b.style==='secondary'?'alt':''}">${esc(b.label)} ↗</span><small>${esc(b.href)}</small></div>`;
 if(b.type==='form')return `<div class="ed-pv-form"><h3>${esc(b.title)}</h3><div class="ed-pv-form-grid"><label>Ваше имя<span></span></label><label>Телефон или email<span></span></label></div><span class="ed-pv-submit">${esc(b.submitLabel)} ↗</span></div>`;
 return '<div class="ed-pv-divider"></div>';
}
function siteProperties(b){
 let html='';
 if(b.type==='hero')html+=field('Надпись','eyebrow',b.eyebrow,false,40)+field('Заголовок','title',b.title,true,110)+field('Описание','subtitle',b.subtitle,true,320);
 if(b.type==='text')html+=field('Заголовок','title',b.title,false,110)+field('Текст','body',b.body,true,1500);
 if(b.type==='button')html+=field('Надпись','label',b.label,false,80)+field('Ссылка (от / либо https://)','href',b.href,false,300)+select('Оформление','style',[['primary','Основная'],['secondary','Вторичная']],b.style);
 if(b.type==='form')html+=field('Заголовок','title',b.title,false,110)+field('Надпись кнопки','submitLabel',b.submitLabel,false,80)+'<p class="ed-help">В рабочем сайте форма сохраняет обращение в SQLite.</p>';
 if(b.type==='features')html+=field('Заголовок','title',b.title,false,110)+(b.items||[]).map((item,i)=>`<div class="ed-field"><span>Карточка ${i+1}</span><input data-site-feature="title" data-feature-index="${i}" maxlength="80" value="${esc(item.title)}"><textarea data-site-feature="body" data-feature-index="${i}" maxlength="240" rows="2">${esc(item.body)}</textarea><button data-site-feature-remove="${i}" type="button" class="ed-danger">Удалить карточку</button></div>`).join('')+`<button data-site-feature-add type="button" ${b.items.length>=6?'disabled':''}>+ Карточка</button>`;
 if(b.type==='divider')html+='<p class="ed-help">Визуальный разделитель.</p>';
 return html;
}
function preview(b,customEntities=[]){
 if(b.type==='hero')return `<div class="ed-pv-hero"><small>${esc(b.eyebrow)}</small><h2>${esc(b.title)}</h2><p>${esc(b.subtitle)}</p></div>`;
 if(b.type==='text')return `<div class="ed-pv-text"><h3>${esc(b.title)}</h3><p>${esc(b.body)}</p></div>`;
 if(b.type==='metric')return `<div class="ed-pv-metric"><span>${esc(b.label)} <b>◈</b></span><strong>—</strong><small>${b.metric==='entity_count'?'Источник: '+esc(customEntities.find(e=>'custom:'+e.slug===b.entity)?.title||'Выберите таблицу'):'Значение будет загружено из CRM'}</small></div>`;
 if(b.type==='button')return `<div class="ed-pv-cta"><span class="ed-pv-button ${b.style==='secondary'?'alt':''}">${esc(b.label)} ↗</span><small>${esc(ACTIONS[b.action]?.[0]||(b.action.startsWith('navigate:page:')?'Переход на страницу':b.action))}${b.confirm?' · С подтверждением':''}</small></div>`;
 if(b.type==='form')return `<div class="ed-pv-form"><h3>${esc(b.title)}</h3><div class="ed-pv-form-grid">${(b.fields||[]).map(f=>`<label>${esc(entityFields(b.entity,customEntities)?.[f]||f)}<span></span></label>`).join('')}</div><span class="ed-pv-submit">${esc(b.submitLabel)} ↗</span></div>`;
 if(b.type==='table')return `<div class="ed-pv-table"><h3>${esc(b.title)}</h3><div class="ed-pv-table-head">${(b.columns||[]).map(f=>`<span>${esc(entityFields(b.entity,customEntities)?.[f]||f)}</span>`).join('')}</div><p>Источник: ${esc(customEntities.find(e=>'custom:'+e.slug===b.entity)?.title||({clients:'Гости',tasks:'Задачи'})[b.entity]||'CRM')} · ${Number(b.limit)||10} записей</p></div>`;
 return '<div class="ed-pv-divider"></div>';
}
export function initPageEditor({api,toast}){
 const E={project:null,pages:[],page:null,selected:null,dirty:false,drag:null,busy:false,past:[],future:[],hover:null};
 const url=()=>`/api/studio/projects/${E.project.id}/pages`;
 const available=(type)=>E.project?.type==='site'?SITE_TYPES.some(x=>x[0]===type)&&(type!=='form'||E.project.modules.includes('leads')):['hero','text','divider','button'].includes(type)||(type==='metric'&&(Object.values(METRICS).some(([,m])=>E.project.modules.includes(m))||(E.project.entities||[]).length>0))||(['form','table'].includes(type)&&entityChoices(E.project).length>0);
 const typeDefs=()=>E.project?.type==='site'?SITE_TYPES:TYPES;
 const makeBlock=type=>E.project.type==='site'?siteDraft(type):draft(type,E.project.modules,E.project.entities||[]);
 const dirty=()=>{E.dirty=true;$('editorStatus').textContent='Не сохранено';$('editorStatus').classList.add('unsaved');};
 const clean=()=>{E.dirty=false;$('editorStatus').textContent=`Сохранено · v${E.page?.revision||'new'}`;$('editorStatus').classList.remove('unsaved');};
 const canLeave=()=>!E.dirty||confirm('Есть несохранённые изменения. Продолжить без сохранения?');
 const snapshot=()=>({page:structuredClone(E.page),selected:E.selected});
 const historyButtons=()=>{const a=$('editorUndo'),b=$('editorRedo');if(a)a.disabled=!E.past.length;if(b)b.disabled=!E.future.length;};
 function remember(){if(!E.page)return;const item=snapshot();if(JSON.stringify(item)!==JSON.stringify(E.past.at(-1))){E.past.push(item);if(E.past.length>35)E.past.shift();}E.future=[];historyButtons();}
 function history(direction){const from=direction==='undo'?E.past:E.future,to=direction==='undo'?E.future:E.past;if(!from.length)return;to.push(snapshot());const prev=from.pop();E.page=prev.page;E.selected=prev.selected;dirty();draw();historyButtons();}
 if(!$('editorUndo')){const container=document.querySelector('.editor-top-actions');if(container){const group=document.createElement('div');group.className='ed-history-controls';group.innerHTML='<button id="editorUndo" type="button" title="Отменить действие (Ctrl+Z)" aria-label="Отменить">↶</button><button id="editorRedo" type="button" title="Повторить действие (Ctrl+Y)" aria-label="Повторить">↷</button>';container.prepend(group);$('editorUndo').addEventListener('click',()=>history('undo'));$('editorRedo').addEventListener('click',()=>history('redo'));}}
 function pages(){
  const items=E.page&&!E.page.id?[...E.pages,E.page]:E.pages;
  $('editorPageList').innerHTML=items.map(p=>`<button class="editor-page-choice ${E.page===p||E.page?.id===p.id?'active':''}" data-page-id="${esc(p.id||'_new')}" type="button"><span>${p.published?'◉':'○'}</span><strong>${esc(p.title)}</strong><small>${p.published?'ОПУБЛИКОВАНО':'ЧЕРНОВИК'}</small></button>`).join('')||'<p class="editor-side-hint">Создайте первую страницу</p>';
 }
 function stage(){
  if(!E.page){$('editorCanvas').innerHTML='';return;}
  $('editorPageTitle').textContent=E.page.title;
  $('editorPageSlug').textContent='/'+E.page.slug;
  $('editorCanvas').innerHTML=E.page.blocks.map((b,i)=>`<article class="editor-preview-block ed-span-${esc(b.layout|| (b.type==='metric'?'half':'wide'))} ${E.selected===b.id?'selected':''}" data-block-id="${esc(b.id)}" data-block-index="${i}" tabindex="0" role="group" aria-label="Блок ${i+1}: ${esc(typeDefs().find(t=>t[0]===b.type)?.[1]||b.type)}" draggable="true"><div class="editor-block-label"><span>⠿ ${esc(typeDefs().find(t=>t[0]===b.type)?.[1]||b.type)} <small>${i+1} · ${b.layout==='third'?'1/3':b.layout==='half'?'1/2':'100%'}</small></span><button class="ed-insert-before" type="button" data-insert-before="${i}" title="Добавить блок перед этим" aria-label="Добавить перед блоком ${i+1}">+</button></div>${E.project.type==='site'?sitePreview(b):preview(b,E.project.entities||[])}</article>`).join('')+'<button class="ed-add-inline ed-drop-end" type="button" data-add-inline-at="'+E.page.blocks.length+'">+ Добавить блок в конец · сюда можно перетащить элемент</button>';
 }
 function inspector(){
  const p=E.page;if(!p){$('editorInspector').innerHTML='';return;}
  const b=p.blocks.find(x=>x.id===E.selected),i=p.blocks.indexOf(b);
  $('editorInspectorTag').textContent=typeDefs().find(t=>t[0]===b?.type)?.[1]||'СТРАНИЦА';
  let html=`<div class="ed-inspector-section"><h3>Страница</h3><label class="ed-field"><span>Название</span><input data-page-prop="title" maxlength="80" value="${esc(p.title)}"></label><label class="ed-field"><span>Адрес страницы</span><input data-page-prop="slug" maxlength="48" value="${esc(p.slug)}"></label><label class="ed-field"><span>Описание</span><textarea data-page-prop="description" maxlength="240" rows="2">${esc(p.description)}</textarea></label><label class="ed-switch"><input data-page-prop="published" type="checkbox" ${p.published?'checked':''}><span><strong>Опубликована</strong><small>${E.project.type==='site'?'Видна посетителям сайта':'Видна сотрудникам CRM'}</small></span></label></div>`;
  if(b){
   html+=`<div class="ed-inspector-section"><div class="ed-prop-title"><h3>${esc(typeDefs().find(t=>t[0]===b.type)?.[1])}</h3><small>Блок ${i+1}</small></div>`;
   html+=select('Ширина на компьютере','layout',b.type==='divider'?[['wide','Во всю ширину']]:['hero','form','table'].includes(b.type)?[['wide','Во всю ширину'],['half','Половина страницы']]:[['wide','Во всю ширину'],['half','Половина страницы'],['third','Треть страницы']],b.layout??(b.type==='metric'?'half':'wide'))+'<p class="ed-help">На телефоне блок всегда занимает всю ширину. Положение и размер сохраняются в ZIP.</p>';
   if(E.project.type==='site')html+=siteProperties(b);
   else {
   if(b.type==='hero')html+=field('Надпись','eyebrow',b.eyebrow,false,40)+field('Заголовок','title',b.title,true,110)+field('Описание','subtitle',b.subtitle,true,320);
   if(b.type==='text')html+=field('Заголовок','title',b.title,false,110)+field('Текст','body',b.body,true,1500);
   if(b.type==='metric'){
    const options=Object.entries(METRICS).filter(([,v])=>E.project.modules.includes(v[1])).map(([k,v])=>[k,v[0]]);
    if((E.project.entities||[]).length)options.push(['entity_count','Количество записей из таблицы']);
    html+=field('Название','label',b.label,false,80)+select('Источник показателя','metric',options,b.metric);
    if(b.metric==='entity_count')html+=select('Считать записи в таблице','entity',(E.project.entities||[]).map(e=>['custom:'+e.slug,e.title]),b.entity);
    html+='<p class="ed-help">Показатель загрузится из защищённого API готовой CRM с учётом прав сотрудника.</p>';
   }
   if(b.type==='button'){
    html+=field('Надпись на кнопке','label',b.label,false,80)+select('Действие при нажатии','action',actionChoices(E.project,E.pages),b.action)+select('Оформление','style',[['primary','Основная'],['secondary','Вторичная']],b.style);
    if(b.action==='notice')html+=field('Текст уведомления','message',b.message||'',true,180);
    else html+=`<label class="ed-field ed-switch-field"><input type="checkbox" data-block-boolean="confirm" ${b.confirm?'checked':''}><span>Запрашивать подтверждение перед действием</span></label>`+(b.confirm?field('Что спросить у пользователя','confirmText',b.confirmText||'Подтвердить действие?',true,180):'');
    html+='<div class="ed-field"><span>Кто увидит кнопку</span><div class="ed-checkboxes ed-role-list">'+[['admin','Администратор'],['manager','Управляющий'],['staff','Сотрудник']].map(([role,label])=>`<label><input type="checkbox" data-button-role="${role}" ${(b.roles||['admin','manager','staff']).includes(role)?'checked':''}><span>${label}</span></label>`).join('')+'</div><small class="ed-help">Право на саму операцию дополнительно проверяется сервером CRM.</small></div>';
   }
   if(b.type==='form'||b.type==='table'){
    const key=b.type==='form'?'fields':'columns';
    html+=field('Название','title',b.title,false,110)+select('Данные','entity',entityChoices(E.project),b.entity);
    if(b.type==='form')html+=field('Кнопка сохранения','submitLabel',b.submitLabel,false,80)+field('Текст после сохранения','successText',b.successText||'Запись успешно сохранена',false,120);
    if(b.type==='table')html+=select('Сколько строк показывать','limit',[['5','5 последних'],['10','10 последних'],['20','20 последних']],String(b.limit||10));
    html+=`<div class="ed-field"><span>${b.type==='form'?'Поля формы':'Столбцы'}</span><div class="ed-checkboxes">`+
      Object.entries(entityFields(b.entity,E.project.entities||[])).map(([k,v])=>`<label><input data-field="${k}" type="checkbox" ${b[key].includes(k)?'checked':''} ${requiredKeys(b.entity,E.project.entities).includes(k)?'disabled':''}><span>${esc(v)}</span></label>`).join('')+'</div></div>';
   }
   if(b.type==='divider')html+='<p class="ed-help">Разделитель не требует настроек.</p>';
   }
   html+=`<div class="ed-block-ops"><button data-op="up" ${i===0?'disabled':''} type="button">↑ Выше</button><button data-op="down" ${i===p.blocks.length-1?'disabled':''} type="button">↓ Ниже</button><button data-op="duplicate" type="button">Дублировать</button><button data-op="delete" class="ed-danger" type="button">Удалить</button></div></div>`;
  }else html+='<div class="ed-inspector-tip">Выберите блок в центре, чтобы настроить его поля и действия.</div>';
  if(p.id)html+='<button id="editorDeletePage" class="ed-delete-page" type="button">Удалить страницу</button>';
  $('editorInspector').innerHTML=html;
 }
 const draw=()=>{pages();stage();inspector();};
 function choose(p){E.page=structuredClone(p);E.selected=null;E.past=[];E.future=[];clean();draw();historyButtons();}
 function create(check=true){if(check&&!canLeave())return;if(E.pages.length>=20)return toast('Можно создать не более 20 страниц',true);
  E.page={id:null,title:'Новая страница',slug:`new-page-${E.pages.length+1}`,description:'',published:false,blocks:[makeBlock('hero')],revision:null};
  E.selected=E.page.blocks[0].id;E.past=[];E.future=[];draw();dirty();historyButtons();
 }
 async function open(project,{pageId=null,blockId=null}={}){
  E.project=project;E.pages=[];E.page=null;E.dirty=false;E.past=[];E.future=[];historyButtons();
  document.querySelector('.editor-page-preview-head small').textContent=project.type==='site'?'САЙТ · ПРЕДПРОСМОТР БЛОКОВ':'CRM · ПРЕДПРОСМОТР БЕЗ ДАННЫХ';
  $('pageEditor').hidden=false;document.body.classList.add('editing-pages');
  document.documentElement.style.setProperty('--editor-accent',project.settings.accent);
  $('editorProjectName').textContent=project.name;$('editorCrmLink').textContent=project.type==='site'?'Открыть сайт ↗':'Открыть CRM ↗';$('editorCrmLink').href=`/workspace/${project.id}/`;
  $('editorPalette').innerHTML=typeDefs().filter(([type])=>available(type)).map(([type,name,icon,description])=>`<button data-add-block="${type}" class="editor-palette-item" type="button" draggable="true" title="Перетащить в нужное место или нажать для добавления"><span class="editor-palette-icon">${icon}</span><span><strong>${name}</strong><small>${description}</small></span><span class="editor-palette-plus">⠿</span></button>`).join('');
  try{E.pages=(await api(url())).pages;if(E.pages.length){choose(E.pages.find(p=>p.id===pageId)||E.pages[0]);if(blockId&&E.page.blocks.some(b=>b.id===blockId)){E.selected=blockId;stage();inspector();}}else create(false);}
  catch(e){toast(e.message,true);close(true);}
 }
 function close(force=false){if(!force&&!canLeave())return;$('pageEditor').hidden=true;document.body.classList.remove('editing-pages');E.project=null;}
 async function save(){if(E.busy||!E.page)return;E.busy=true;$('editorSave').disabled=true;
  try{const p=E.page,data={title:p.title,slug:p.slug,description:p.description,published:p.published,blocks:p.blocks};if(p.id)data.revision=p.revision;
   const r=await api(p.id?url()+'/'+p.id:url(),{method:p.id?'PATCH':'POST',body:data});
   const at=E.pages.findIndex(x=>x.id===r.page.id);if(at<0)E.pages.push(r.page);else E.pages[at]=r.page;
   E.page=structuredClone(r.page);E.past=[];E.future=[];historyButtons();clean();draw();toast(E.project.type==='site'?'Страница сайта сохранена. Обновите сайт для просмотра.':'Страница CRM сохранена.');
  }catch(e){toast(e.message,true)}finally{E.busy=false;$('editorSave').disabled=false;}
 }
 function move(i,j){if(j<0||j>=E.page.blocks.length||i===j)return;remember();const [b]=E.page.blocks.splice(i,1);E.page.blocks.splice(j,0,b);E.selected=b.id;dirty();stage();inspector();}
 function insertBlock(type,index){if(!available(type)||!E.page)return;if(E.page.blocks.length>=30)return toast('Не более 30 блоков на странице',true);remember();const b=makeBlock(type);E.page.blocks.splice(Math.min(Math.max(0,index),E.page.blocks.length),0,b);E.selected=b.id;dirty();stage();inspector();}
 function relocate(blockId,index){const i=E.page.blocks.findIndex(b=>b.id===blockId);if(i<0)return;const target=Math.min(Math.max(0,index),E.page.blocks.length);if(i===target||i+1===target)return;remember();const [b]=E.page.blocks.splice(i,1);E.page.blocks.splice(target>i?target-1:target,0,b);E.selected=b.id;dirty();stage();inspector();}
 function dragCleanup(){$('editorCanvas').querySelectorAll('.ed-drag-before,.ed-drag-after,.ed-drag-end-active').forEach(n=>n.classList.remove('ed-drag-before','ed-drag-after','ed-drag-end-active'));E.hover=null;E.drag=null;}
 function dragAt(e){const target=e.target.closest('[data-block-index]');if(target){const box=target.getBoundingClientRect();return {index:Number(target.dataset.blockIndex)+(e.clientY>box.top+box.height*.5?1:0),target,after:e.clientY>box.top+box.height*.5};}const end=e.target.closest('[data-add-inline-at]');return end?{index:E.page.blocks.length,target:end,end:true}:null;}
 function add(type,index){insertBlock(type,index===undefined?E.page.blocks.length:index);}
 $('editorClose').addEventListener('click',()=>close());
 $('editorSave').addEventListener('click',save);
 $('editorNewPage').addEventListener('click',()=>create());
 $('editorPageList').addEventListener('click',e=>{const el=e.target.closest('[data-page-id]');if(!el||!canLeave())return;const p=E.pages.find(p=>p.id===el.dataset.pageId);if(p)choose(p);});
 $('editorPalette').addEventListener('click',e=>{const el=e.target.closest('[data-add-block]');if(el)add(el.dataset.addBlock);});
 $('editorPalette').addEventListener('dragstart',e=>{const el=e.target.closest('[data-add-block]');if(!el)return;E.drag={kind:'palette',type:el.dataset.addBlock};e.dataTransfer.effectAllowed='copy';e.dataTransfer.setData('text/plain','palette:'+E.drag.type);});
 $('editorPalette').addEventListener('dragend',dragCleanup);
 $('editorCanvas').addEventListener('click',e=>{const inline=e.target.closest('[data-add-inline-at]');if(inline)return add('text',Number(inline.dataset.addInlineAt));const before=e.target.closest('[data-insert-before]');if(before)return add('text',Number(before.dataset.insertBefore));const el=e.target.closest('[data-block-id]');if(el){E.selected=el.dataset.blockId;stage();inspector();}});
 $('editorCanvas').addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)&&e.target.dataset.blockId){e.preventDefault();E.selected=e.target.dataset.blockId;stage();inspector();}});
 $('editorCanvas').addEventListener('dragstart',e=>{const item=e.target.closest('[data-block-id]');if(!item)return;E.drag={kind:'reorder',id:item.dataset.blockId};e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain','block:'+E.drag.id);});
 $('editorCanvas').addEventListener('dragover',e=>{if(!E.drag)return;const at=dragAt(e);if(!at)return;e.preventDefault();e.dataTransfer.dropEffect=E.drag.kind==='palette'?'copy':'move';$('editorCanvas').querySelectorAll('.ed-drag-before,.ed-drag-after,.ed-drag-end-active').forEach(n=>n.classList.remove('ed-drag-before','ed-drag-after','ed-drag-end-active'));at.target.classList.add(at.end?'ed-drag-end-active':at.after?'ed-drag-after':'ed-drag-before');E.hover=at;});
 $('editorCanvas').addEventListener('drop',e=>{if(!E.drag)return;const at=dragAt(e)||E.hover;if(at){e.preventDefault();const drag=E.drag;dragCleanup();if(drag.kind==='palette')insertBlock(drag.type,at.index);else relocate(drag.id,at.index);}else dragCleanup();});
 $('editorCanvas').addEventListener('dragend',dragCleanup);
 document.addEventListener('keydown',e=>{if($('pageEditor').hidden||!(e.ctrlKey||e.metaKey)||e.altKey)return;if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;const key=e.key.toLowerCase();if(key==='z'){e.preventDefault();history(e.shiftKey?'redo':'undo');}else if(key==='y'){e.preventDefault();history('redo');}});
 $('editorInspector').addEventListener('focusin',e=>{if(e.target.closest('[data-page-prop],[data-block-prop],[data-block-boolean],[data-field],[data-button-role],[data-site-feature]'))remember();});
 $('editorInspector').addEventListener('input',e=>{
  if(!E.page)return;
  const k=e.target.dataset.pageProp,bk=e.target.dataset.blockProp;
  if(k){E.page[k]=e.target.type==='checkbox'?e.target.checked:e.target.value;dirty();stage();pages();return;}
  if(bk){const b=E.page.blocks.find(b=>b.id===E.selected);if(b){b[bk]=bk==='limit'?Number(e.target.value):e.target.value;dirty();stage();}}
  const fk=e.target.dataset.siteFeature;if(fk){const b=E.page.blocks.find(b=>b.id===E.selected);if(b?.type==='features'){const i=Number(e.target.dataset.featureIndex);if(b.items[i]){b.items[i][fk]=e.target.value;dirty();stage();}}}
 });
 $('editorInspector').addEventListener('change',e=>{
  const b=E.page?.blocks.find(b=>b.id===E.selected);if(!b)return;
  if(e.target.dataset.blockBoolean){b[e.target.dataset.blockBoolean]=e.target.checked;dirty();stage();inspector();return;}
  if(e.target.dataset.buttonRole){
    const role=e.target.dataset.buttonRole;
    const roles=new Set(b.roles||['admin','manager','staff']);
    if(e.target.checked)roles.add(role);else roles.delete(role);
    if(!roles.size){e.target.checked=true;return toast('Выберите хотя бы одну роль',true);}
    b.roles=['admin','manager','staff'].filter(x=>roles.has(x));dirty();stage();return;
  }
  if(e.target.dataset.blockProp==='action'){dirty();stage();inspector();return;}
  if(e.target.dataset.blockProp==='metric'){
    if(b.metric==='entity_count'){
      if(!b.entity)b.entity='custom:'+E.project.entities[0]?.slug;
      if(['Гости в базе','Открытые задачи','Записей в таблице'].includes(b.label))b.label='Количество: '+(E.project.entities.find(x=>'custom:'+x.slug===b.entity)?.title||'записей');
    }
    dirty();stage();inspector();return;
  }
  if(e.target.dataset.blockProp==='entity'){
   b.entity=e.target.value;
   b[b.type==='form'?'fields':'columns']=b.type==='form'?Array.from(new Set([...requiredKeys(b.entity,E.project.entities),...Object.keys(entityFields(b.entity,E.project.entities)).slice(0,2)])):Object.keys(entityFields(b.entity,E.project.entities)).slice(0,3);dirty();stage();inspector();
  }
  if(e.target.dataset.field){const key=b.type==='form'?'fields':'columns';const set=new Set(b[key]);if(e.target.checked)set.add(e.target.dataset.field);else set.delete(e.target.dataset.field);b[key]=Object.keys(entityFields(b.entity,E.project.entities)).filter(k=>set.has(k));dirty();stage();}
 });
 $('editorInspector').addEventListener('click',async e=>{
  const siteBlock=E.page?.blocks.find(b=>b.id===E.selected);
  if(siteBlock?.type==='features'&&e.target.closest('[data-site-feature-add]')){if(siteBlock.items.length<6){siteBlock.items.push({title:'Новое преимущество',body:'Описание'});dirty();stage();inspector();}return;}
  const removeFeature=e.target.closest('[data-site-feature-remove]');
  if(siteBlock?.type==='features'&&removeFeature){if(siteBlock.items.length<=1)return toast('Нужна хотя бы одна карточка',true);siteBlock.items.splice(Number(removeFeature.dataset.siteFeatureRemove),1);dirty();stage();inspector();return;}
  if(e.target.id==='editorDeletePage'){
   if(!E.page?.id||!confirm('Удалить эту страницу?'))return;
   try{await api(`${url()}/${E.page.id}`,{method:'DELETE',body:{revision:E.page.revision}});E.pages=E.pages.filter(p=>p.id!==E.page.id);toast('Страница удалена');E.pages.length?choose(E.pages[0]):create(false);}catch(err){toast(err.message,true)}return;
  }
  const op=e.target.closest('[data-op]')?.dataset.op;
  if(!op||!E.page)return;const i=E.page.blocks.findIndex(x=>x.id===E.selected);if(i<0)return;
  if(op==='up')return move(i,i-1);if(op==='down')return move(i,i+1);
  if(op==='delete'){remember();E.page.blocks.splice(i,1);E.selected=null;dirty();stage();inspector();}
  if(op==='duplicate'){if(E.page.blocks.length>=30)return toast('Максимум 30 блоков',true);remember();const copy=structuredClone(E.page.blocks[i]);copy.id=newId();E.page.blocks.splice(i+1,0,copy);E.selected=copy.id;dirty();stage();inspector();}
 });
 for(const [mode,id] of [['desktop','editorDesktop'],['mobile','editorMobile']]){
  $(id).addEventListener('click',()=>{$('editorDevice').classList.toggle('is-mobile',mode==='mobile');$('editorDesktop').classList.toggle('active',mode==='desktop');$('editorMobile').classList.toggle('active',mode==='mobile');});
 }
 return {open,close};
}
