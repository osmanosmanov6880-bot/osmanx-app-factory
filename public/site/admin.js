const $=id=>document.getElementById(id);
const base=location.protocol==='about:'?'':location.pathname.replace(/\/admin\/?$/,'');
$('siteLink').href=base+'/';
const state={session:null,pages:[],page:null,settings:null,leads:[]};
const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uuid=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),b=>b.toString(16).padStart(2,'0')).join('');
let toastTimer;
function toast(text,error=false){const t=$('toast');t.hidden=false;t.textContent=text;t.classList.toggle('error',error);clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.hidden=true,3800);}
async function api(path,{method='GET',body,extraHeaders={}}={}){
 const headers={...extraHeaders};if(body!==undefined)headers['Content-Type']='application/json';
 if(!['GET','HEAD'].includes(method)&&state.session?.csrf)headers['X-CSRF-Token']=state.session.csrf;
 const r=await fetch(base+path,{method,credentials:'same-origin',headers,body:body===undefined?undefined:JSON.stringify(body)});
 const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||`HTTP ${r.status}`);return data;
}
function showAuth(){
 $('auth').hidden=false;$('app').hidden=true;
 const setup=!state.session?.initialized;
 $('authTitle').textContent=setup?'Создайте администратора сайта.':'Войти в управление сайтом.';
 $('nameWrap').hidden=!setup;$('authName').required=setup;
 $('setupTokenWrap').hidden=!setup||!state.session?.requiresSetupToken;
 $('setupToken').required=setup&&!!state.session?.requiresSetupToken;
 $('authPassword').autocomplete=setup?'new-password':'current-password';
}
async function boot(){
 try{state.session=await api('/api/site/session');if(state.session.authenticated)await showApp();else showAuth();}catch(e){toast(e.message,true);}
}
$('authForm').addEventListener('submit',async e=>{
 e.preventDefault();const setup=!state.session.initialized;
 const data={email:$('authEmail').value.trim(),password:$('authPassword').value};
 if(setup){data.name=$('authName').value.trim();if(state.session.requiresSetupToken)data.setup_token=$('setupToken').value;}
 $('authSubmit').disabled=true;
 try{
  const extraHeaders={};
  // A website inside the Factory can only be initialized by its authenticated owner.
  // A standalone ZIP has no Studio session and uses local setup or SETUP_TOKEN.
  if(setup&&base.startsWith('/workspace/')){
    const session=await fetch('/api/studio/session',{credentials:'same-origin'}).then(r=>r.ok?r.json():null).catch(()=>null);
    if(session?.authenticated&&session.csrf)extraHeaders['X-Studio-CSRF-Token']=session.csrf;
  }
  const r=await api('/api/site/'+(setup?'setup':'login'),{method:'POST',body:data,extraHeaders});state.session={initialized:true,authenticated:true,user:r.user,csrf:r.csrf};$('authPassword').value='';await showApp();}
 catch(err){$('authError').textContent=err.message;}finally{$('authSubmit').disabled=false;}
});
$('logout').addEventListener('click',async()=>{try{await api('/api/site/logout',{method:'POST',body:{}});state.session={initialized:true,authenticated:false};showAuth();}catch(e){toast(e.message,true);}});
function tab(name){document.querySelectorAll('.section').forEach(el=>el.classList.toggle('active',el.id===name));document.querySelectorAll('[data-tab]').forEach(el=>el.classList.toggle('active',el.dataset.tab===name));}
document.querySelector('.menu').addEventListener('click',async e=>{
 const n=e.target.closest('[data-tab]')?.dataset.tab;if(!n)return;tab(n);
 try{if(n==='dashboard')await loadOverview();if(n==='pages')await loadPages();if(n==='leads')await loadLeads();if(n==='settings')await loadSettings();}catch(err){toast(err.message,true);}
});
async function showApp(){$('auth').hidden=true;$('app').hidden=false;await loadOverview();tab('dashboard');}
async function loadOverview(){const r=await api('/api/site/overview');$('statLeads').textContent=r.overview.leads;$('statNew').textContent=r.overview.newLeads;$('statPages').textContent=r.overview.publishedPages;}
async function loadPages(){const r=await api('/api/site/pages');state.pages=r.pages;
 $('pageList').innerHTML=r.pages.map(p=>`<article class="page-card"><span class="badge">${p.published?'● ОПУБЛИКОВАНО':'○ ЧЕРНОВИК'}</span><h3>${h(p.title)}</h3><p>${h(p.description)}</p><div class="row"><small class="muted">/${h(p.slug)}</small><button class="btn" data-edit-page="${h(p.id)}">Изменить ↗</button></div></article>`).join('')||'<p class="muted">Страниц нет</p>';
}
$('pageList').addEventListener('click',e=>{const id=e.target.closest('[data-edit-page]')?.dataset.editPage;const page=state.pages.find(p=>p.id===id);if(page)openPage(page);});
$('newPage').addEventListener('click',()=>openPage({id:null,title:'Новая страница',slug:'new-page',description:'',published:false,blocks:[makeBlock('hero')],revision:null}));
$('backToPages').addEventListener('click',async()=>{tab('pages');await loadPages();});
function makeBlock(type){const common={id:uuid(),type};
 if(type==='hero')return {...common,eyebrow:'ВАША КОМПАНИЯ',title:'Новый заголовок',subtitle:'Расскажите о ваших услугах'};
 if(type==='text')return {...common,title:'Новый раздел',body:'Описание раздела'};
 if(type==='button')return {...common,label:'Подробнее',href:'/contacts',style:'primary'};
 if(type==='features')return {...common,title:'Наши преимущества',items:[{title:'Преимущество',body:'Краткое описание'}]};
 if(type==='form')return {...common,title:'Оставить обращение',submitLabel:'Отправить'};
 return common;
}
function openPage(page){state.page=structuredClone(page);tab('pageEdit');$('pageEditTitle').textContent=page.title;$('pageTitle').value=page.title;$('pageSlug').value=page.slug;$('pageDescription').value=page.description;$('pagePublished').checked=page.published;$('deletePage').hidden=!page.id||page.slug==='home';renderBlocks();}
const fld=(label,key,value,area=false)=>`<label>${h(label)}${area?`<textarea data-property="${key}">${h(value)}</textarea>`:`<input data-property="${key}" value="${h(value)}" maxlength="500">`}</label>`;
function renderBlocks(){const p=state.page;if(!p)return;
 $('editBlocks').innerHTML=p.blocks.map((b,i)=>{
  let f='';
  if(b.type==='hero')f=fld('Надпись','eyebrow',b.eyebrow)+fld('Заголовок','title',b.title,true)+fld('Описание','subtitle',b.subtitle,true);
  if(b.type==='text')f=fld('Заголовок','title',b.title)+fld('Текст','body',b.body,true);
  if(b.type==='button')f=fld('Надпись','label',b.label)+fld('Ссылка /... или https://...','href',b.href)+`<label>Оформление<select data-property="style"><option value="primary" ${b.style==='primary'?'selected':''}>Основная</option><option value="secondary" ${b.style==='secondary'?'selected':''}>Вторичная</option></select></label>`;
  if(b.type==='features')f=fld('Название секции','title',b.title)+(b.items||[]).map((item,j)=>`<div class="field-grid"><label>Преимущество ${j+1}<input data-item="${j}" data-item-property="title" value="${h(item.title)}"></label><label>Описание<input data-item="${j}" data-item-property="body" value="${h(item.body)}"></label></div>`).join('')+'<button type="button" class="btn" data-item-add>+ Преимущество</button>';
  if(b.type==='form')f=fld('Заголовок','title',b.title)+fld('Кнопка','submitLabel',b.submitLabel);
  return `<article class="block-card" data-block="${i}"><div class="row"><strong>${h({hero:'Заголовок',text:'Текст',button:'Кнопка',features:'Преимущества',form:'Форма заявки',divider:'Разделитель'}[b.type])} <span class="muted">#${i+1}</span></strong><div class="block-actions"><button class="btn" type="button" data-move="up" title="Вверх">↑</button><button class="btn" type="button" data-move="down" title="Вниз">↓</button><button class="btn danger" type="button" data-remove>×</button></div></div><div class="block-card-fields">${f}</div></article>`;
 }).join('');
 renderPreview();
}
function renderPreview(){const p=state.page;if(!p)return;
 $('pagePreview').innerHTML=p.blocks.map(b=>`<article class="preview-${h(b.type)}"><h4>${h(b.title||b.label||'Разделитель')}</h4><p>${h(b.subtitle||b.body||(b.type==='form'?'Форма с полями имени, телефона, почты и сообщения':b.type==='features'?(b.items||[]).map(i=>i.title).join(' · '):b.href||''))}</p></article>`).join('')||'<p class="muted">Пустая страница</p>';
}
$('editBlocks').addEventListener('input',e=>{
 const node=e.target.closest('[data-block]');if(!node||!state.page)return;const b=state.page.blocks[Number(node.dataset.block)];
 if(e.target.dataset.property)b[e.target.dataset.property]=e.target.value;
 if(e.target.dataset.itemProperty)b.items[Number(e.target.dataset.item)][e.target.dataset.itemProperty]=e.target.value;
 renderPreview();
});
$('editBlocks').addEventListener('click',e=>{
 const node=e.target.closest('[data-block]');if(!node||!state.page)return;const i=Number(node.dataset.block),blocks=state.page.blocks;
 if(e.target.closest('[data-remove]')){blocks.splice(i,1);renderBlocks();return;}
 const move=e.target.closest('[data-move]')?.dataset.move;if(move){const j=i+(move==='up'?-1:1);if(j>=0&&j<blocks.length){[blocks[i],blocks[j]]=[blocks[j],blocks[i]];renderBlocks();}return;}
 if(e.target.closest('[data-item-add]')){if(blocks[i].items.length>=6)return toast('Максимум 6 преимуществ',true);blocks[i].items.push({title:'Новое преимущество',body:'Описание'});renderBlocks();}
});
$('addBlock').addEventListener('click',()=>{if(!state.page)return;if(state.page.blocks.length>=30)return toast('Максимум 30 блоков',true);state.page.blocks.push(makeBlock($('blockType').value));renderBlocks();});
$('pageForm').addEventListener('submit',async e=>{
 e.preventDefault();if(!state.page)return;
 const p=state.page;const body={title:$('pageTitle').value,slug:$('pageSlug').value,description:$('pageDescription').value,published:$('pagePublished').checked,blocks:p.blocks};
 if(p.id)body.revision=p.revision;
 $('savePage').disabled=true;
 try{const r=await api('/api/site/pages'+(p.id?'/'+p.id:''),{method:p.id?'PATCH':'POST',body});state.page=r.page;toast('Страница сохранена');openPage(r.page);}
 catch(err){toast(err.message,true);}finally{$('savePage').disabled=false;}
});
$('deletePage').addEventListener('click',async()=>{const p=state.page;if(!p?.id||!confirm('Удалить страницу?'))return;
 try{await api('/api/site/pages/'+p.id,{method:'DELETE',body:{revision:p.revision}});toast('Страница удалена');tab('pages');await loadPages();}catch(err){toast(err.message,true);}
});
async function loadLeads(){const r=await api('/api/site/leads?limit=100');state.leads=r.leads;
 $('leadsBody').innerHTML=r.leads.map(l=>`<tr><td><strong>${h(l.name)}</strong></td><td>${h(l.phone)}<small>${h(l.email)}</small></td><td>${h(l.message)}</td><td>/${h(l.page_slug)}<small>${h(new Date(l.created_at).toLocaleString('ru-RU'))}</small></td><td><select class="lead-status" data-lead="${h(l.id)}"><option value="new" ${l.status==='new'?'selected':''}>Новая</option><option value="in_progress" ${l.status==='in_progress'?'selected':''}>В работе</option><option value="closed" ${l.status==='closed'?'selected':''}>Закрыта</option></select></td></tr>`).join('')||'<tr><td colspan="5">Пока нет обращений</td></tr>';
}
$('refreshLeads').addEventListener('click',()=>loadLeads().catch(e=>toast(e.message,true)));
$('leadsBody').addEventListener('change',async e=>{const id=e.target.dataset.lead;if(!id)return;
 try{await api('/api/site/leads/'+id,{method:'PATCH',body:{status:e.target.value}});toast('Статус обновлён');await loadOverview();}catch(err){toast(err.message,true);}
});
async function loadSettings(){const r=await api('/api/site/settings');state.settings=r.settings;$('siteBrand').value=r.settings.name;$('siteTagline').value=r.settings.settings.tagline;$('siteEmail').value=r.settings.settings.contactEmail;$('siteAccent').value=r.settings.settings.accent;}
$('settingsForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/site/settings',{method:'PATCH',body:{brand:$('siteBrand').value,tagline:$('siteTagline').value,contactEmail:$('siteEmail').value,accent:$('siteAccent').value}});toast('Дизайн и контакты обновлены');}catch(err){toast(err.message,true);}});
boot();
