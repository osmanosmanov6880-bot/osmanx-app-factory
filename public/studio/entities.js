// Entity schema studio: metadata only, no arbitrary SQL or code input.
const $=id=>document.getElementById(id);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TYPES=[['text','Короткий текст'],['longtext','Длинный текст'],['integer','Целое число'],['number','Дробное число'],['boolean','Да / Нет'],['date','Дата'],['select','Список'],['reference','Связь с таблицей']];
const keyOk=v=>/^[a-z][a-z0-9_]{1,31}$/.test(v);
const typesOptions=(value)=>TYPES.map(([id,label])=>`<option value="${id}" ${id===value?'selected':''}>${label}</option>`).join('');
const defaultEntity=slug=>({id:null,revision:null,slug,title:'Новая таблица',description:'',access:{read:['admin','manager','staff'],write:['admin','manager']},fields:[{key:'name',label:'Название',type:'text',required:true}]});
export function initEntityEditor({api,toast}){
 const E={project:null,entities:[],item:null,dirty:false,busy:false};
 const url=()=>`/api/studio/projects/${E.project.id}/entities`;
 const changed=()=>{E.dirty=true;$('entityStatus').textContent='● Не сохранено';$('entityStatus').classList.add('unsaved');preview();};
 const clean=()=>{E.dirty=false;$('entityStatus').textContent=E.item?.id?`Схема сохранена · v${E.item.revision}`:'Новая сущность';$('entityStatus').classList.remove('unsaved');};
 const canLeave=()=>!E.dirty||confirm('Несохранённые изменения таблицы будут потеряны. Продолжить?');
 function renderList(){
  const items=E.entities;
  $('entityList').innerHTML=items.map(e=>`<button type="button" data-entity-id="${esc(e.id)}" class="schema-entity-choice ${e.id===E.item?.id?'active':''}"><span class="schema-entity-glyph">▦</span><span><strong>${esc(e.title)}</strong><small>${esc(e.slug)} · ${e.fields.length} полей</small></span></button>`).join('')||'<p class="schema-muted">Создайте первую таблицу. Здесь появятся её поля и связи.</p>';
  $('entityTotal').textContent=`${items.length}/12 таблиц`;
 }
 function fieldHtml(f,i){
  const existed=!!E.item?.id&&E.entities.find(e=>e.id===E.item.id)?.fields.some(o=>o.key===f.key);
  const targets=[...E.entities.map(e=>[e.slug,e.title])];
  if(!targets.some(([k])=>k===E.item.slug))targets.push([E.item.slug,E.item.title]);
  return `<article class="schema-field" data-field-index="${i}"><header><span class="schema-field-n">${String(i+1).padStart(2,'0')}</span><strong>${esc(f.label||'Новое поле')}</strong><small>${esc(f.key||'—')}</small>${existed?'<span class="schema-lock" title="У существующего поля нельзя менять код, тип и обязательность">🔒</span>':`<button type="button" data-remove-field="${i}" title="Удалить новое поле">×</button>`}</header><div class="schema-field-grid"><label>Название<input data-prop="label" maxlength="64" value="${esc(f.label)}"></label><label>Код поля<input data-prop="key" maxlength="32" pattern="[a-z][a-z0-9_]+" ${existed?'readonly':''} value="${esc(f.key)}" placeholder="order_number"></label><label>Тип данных<select data-prop="type" ${existed?'disabled':''}>${typesOptions(f.type)}</select></label><label class="schema-check"><input type="checkbox" data-prop="required" ${f.required?'checked':''} ${existed||!!E.item.id?'disabled':''}> Обязательное</label></div>${f.type==='select'?`<label class="schema-option-field">Варианты списка — через запятую<input data-prop="options" value="${esc((f.options||[]).join(', '))}" placeholder="Новый, В работе, Завершён"><small>Существующие значения нельзя удалять или менять местами.</small></label>`:''}${f.type==='reference'?`<label class="schema-option-field">Связь с таблицей<select data-prop="target" ${existed?'disabled':''}>${targets.map(([slug,title])=>`<option value="${esc(slug)}" ${f.target===slug?'selected':''}>${esc(title)} (${esc(slug)})</option>`).join('')}</select></label>`:''}</article>`;
 }
 function draw(){
  renderList(); const item=E.item;if(!item)return;
  $('entityTitle').value=item.title;$('entitySlug').value=item.slug;$('entitySlug').readOnly=!!item.id;
  $('entityDescription').value=item.description;
  $('entityStaffRead').checked=item.access.read.includes('staff');
  $('entityManagerWrite').checked=item.access.write.includes('manager');
  $('entityStaffWrite').checked=item.access.write.includes('staff');
  $('entityFields').innerHTML=item.fields.map(fieldHtml).join('');
  $('entityFieldCount').textContent=`${item.fields.length} / 24`;clean();preview();
 }
 function preview(){
  const e=E.item;if(!e)return;
  $('entityPreviewTitle').textContent=e.title||'Без названия';
  $('entityPreviewSubtitle').textContent=e.description||'Форма создаётся из схемы автоматически.';
  $('entityPreview').innerHTML=e.fields.map(f=>{
   const type=TYPES.find(t=>t[0]===f.type)?.[1]||f.type;
   return `<div class="schema-preview-row"><span>${esc(f.label||f.key)} ${f.required?'*':''}<small>${esc(type)}</small></span><span class="schema-preview-placeholder">${f.type==='boolean'?'○':f.type==='date'?'ДД.ММ.ГГГГ':f.type==='reference'?'Выбрать запись ▾':f.type==='select'?'Выбрать вариант ▾':'Введите значение'}</span></div>`;
  }).join('');
  $('entitySqlHint').textContent=keyOk(e.slug)?`SQLite: custom_${e.slug} · API: /api/entities/${e.slug}/rows`:'Введите корректный код таблицы';
 }
 function selectEntity(e){E.item=structuredClone(e);draw();}
 function fresh(){if(!canLeave())return;if(E.entities.length>=12)return toast('Достигнут лимит 12 таблиц',true);const slug=`records_${E.entities.length+1}`;E.item=defaultEntity(slug);draw();}
 async function open(project){
  E.project=project;E.entities=[];E.item=null;E.dirty=false;
  $('entityEditor').hidden=false;document.body.classList.add('editing-entities');$('entityProjectName').textContent=project.name;
  try{E.entities=(await api(url())).entities;E.entities.length?selectEntity(E.entities[0]):fresh();}catch(err){toast(err.message,true);close(true);}
 }
 function close(force=false){if(!force&&!canLeave())return;$('entityEditor').hidden=true;document.body.classList.remove('editing-entities');E.project=null;}
 async function save(){if(!E.item||E.busy)return;E.busy=true;$('entitySave').disabled=true;
  try{
   const ent=E.item;const body={slug:ent.slug,title:ent.title,description:ent.description,access:ent.access,fields:ent.fields};
   if(ent.id)body.revision=ent.revision;
   const response=await api(ent.id?url()+'/'+ent.id:url(),{method:ent.id?'PATCH':'POST',body});
   const at=E.entities.findIndex(x=>x.id===response.entity.id);if(at<0)E.entities.push(response.entity);else E.entities[at]=response.entity;
   selectEntity(response.entity);toast('Схема сохранена. Таблица и API доступны в CRM.');
  }catch(err){toast(err.message,true)}finally{E.busy=false;$('entitySave').disabled=false;}
 }
 $('entityClose').addEventListener('click',()=>close());
 $('entitySave').addEventListener('click',save);
 $('entityNew').addEventListener('click',fresh);
 $('entityList').addEventListener('click',ev=>{const id=ev.target.closest('[data-entity-id]')?.dataset.entityId;if(!id||!canLeave())return;const ent=E.entities.find(x=>x.id===id);if(ent)selectEntity(ent);});
 $('entityTitle').addEventListener('input',ev=>{E.item.title=ev.target.value;changed();});
 $('entitySlug').addEventListener('input',ev=>{E.item.slug=ev.target.value;changed();});
 $('entityDescription').addEventListener('input',ev=>{E.item.description=ev.target.value;changed();});
 function accessChanged(){const read=['admin','manager'],write=['admin'];if($('entityStaffRead').checked)read.push('staff');if($('entityManagerWrite').checked)write.push('manager');if($('entityStaffWrite').checked){if(!read.includes('staff')){read.push('staff');$('entityStaffRead').checked=true;}write.push('staff');}E.item.access={read,write};changed();}
 ['entityStaffRead','entityManagerWrite','entityStaffWrite'].forEach(name=>$(name).addEventListener('change',accessChanged));
 $('entityAddField').addEventListener('click',()=>{if(!E.item)return;if(E.item.fields.length>=24)return toast('Не более 24 полей',true);
   const index=E.item.fields.length+1;E.item.fields.push({key:`field_${index}`,label:`Новое поле ${index}`,type:'text',required:false});$('entityFields').innerHTML=E.item.fields.map(fieldHtml).join('');$('entityFieldCount').textContent=`${E.item.fields.length} / 24`;changed();
 });
 $('entityFields').addEventListener('input',ev=>{
   const holder=ev.target.closest('[data-field-index]');if(!holder||!E.item)return;
   const field=E.item.fields[Number(holder.dataset.fieldIndex)],prop=ev.target.dataset.prop;if(!prop||prop==='type'||prop==='required')return;
   if(prop==='options')field.options=ev.target.value.split(',').map(x=>x.trim()).filter(Boolean);
   else field[prop]=ev.target.value;
   if(prop==='label'||prop==='key'){holder.querySelector('header strong').textContent=field.label;holder.querySelector('header small').textContent=field.key;}
   changed();
 });
 $('entityFields').addEventListener('change',ev=>{
   const holder=ev.target.closest('[data-field-index]');if(!holder||!E.item)return;
   const f=E.item.fields[Number(holder.dataset.fieldIndex)],prop=ev.target.dataset.prop;
   if(!['type','target','required'].includes(prop))return;
   if(prop==='type'){f.type=ev.target.value;delete f.options;delete f.target;if(f.type==='select')f.options=['Новый','В работе'];if(f.type==='reference')f.target=E.entities[0]?.slug||E.item.slug;}
   if(prop==='target')f.target=ev.target.value;
   if(prop==='required')f.required=ev.target.checked;
   $('entityFields').innerHTML=E.item.fields.map(fieldHtml).join('');changed();
 });
 $('entityFields').addEventListener('click',ev=>{const i=ev.target.closest('[data-remove-field]')?.dataset.removeField;if(i===undefined)return;E.item.fields.splice(Number(i),1);$('entityFields').innerHTML=E.item.fields.map(fieldHtml).join('');$('entityFieldCount').textContent=`${E.item.fields.length} / 24`;changed();});
 return {open,close};
}
