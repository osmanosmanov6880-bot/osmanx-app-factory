// Generic UI for schema-defined SQLite tables. Data is rendered escaped; no HTML/JS in schema.
(function(){
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=v=>v===null||v===undefined?'':String(v);
const labelValue=(row,entity)=>{
 const field=entity.fields.find(f=>f.type==='text')||entity.fields[0];
 return String(row[field?.key]||row.id).slice(0,100);
};
function input(field,value,refs={}){
 const attrs=`name="${esc(field.key)}" ${field.required?'required':''}`;
 const textValue=esc(norm(value));
 let control='';
 if(field.type==='longtext')control=`<textarea ${attrs} rows="3" maxlength="4000">${textValue}</textarea>`;
 else if(field.type==='boolean')control=`<label class="entity-switch"><input name="${esc(field.key)}" type="checkbox" ${value===true||value===1?'checked':''}><span>Да</span></label>`;
 else if(field.type==='select')control=`<select ${attrs}><option value="">Не выбрано</option>${field.options.map(o=>`<option value="${esc(o)}" ${o===value?'selected':''}>${esc(o)}</option>`).join('')}</select>`;
 else if(field.type==='reference')control=`<select ${attrs} data-reference="${esc(field.target)}"><option value="">Не выбрано</option>${(refs[field.target]||[]).map(o=>`<option value="${esc(o.id)}" ${o.id===value?'selected':''}>${esc(o.title)}</option>`).join('')}</select>`;
 else {
  const type=field.type==='date'?'date':['integer','number'].includes(field.type)?'number':'text';
  control=`<input ${attrs} type="${type}" ${type==='number'?`step="${field.type==='integer'?'1':'any'}"`:''} ${type==='text'?'maxlength="240"':''} value="${textValue}" autocomplete="off">`;
 }
 return `<label class="entity-data-field"><span>${esc(field.label)} ${field.required?'<b>*</b>':''}</span>${control}<small>${esc(field.type==='reference'?'Ссылка на запись другой таблицы':field.type==='number'?'Для денежных сумм используйте целое число минимальных единиц':'')}</small></label>`;
}
function valuesFrom(form,ent){
 const values={};const raw=new FormData(form);
 for(const f of ent.fields){
  if(f.type==='boolean'){values[f.key]=form.elements.namedItem(f.key)?.checked||false;continue;}
  let value=raw.get(f.key);
  if(value===null||value===''){values[f.key]=null;continue;}
  if(f.type==='integer'){if(!/^-?\d+$/.test(String(value)))throw new Error('Поле «'+f.label+'»: требуется целое число');value=Number(value);}
  if(f.type==='number'){value=Number(value);if(!Number.isFinite(value))throw new Error('Поле «'+f.label+'»: требуется число');}
  values[f.key]=value;
 }
 return values;
}
async function references(ent,api){
 const map={};
 for(const field of ent.fields.filter(f=>f.type==='reference')){
  if(map[field.target])continue;
  const data=await api(`/api/entities/${field.target}/rows?limit=100`);
  map[field.target]=data.rows.map(row=>({id:row.id,title:labelValue(row,data.entity)}));
 }
 return map;
}
function display(value,field,refs={}){
 if(value===null||value===undefined||value==='')return '—';
 if(field.type==='boolean')return value?'Да':'Нет';
 if(field.type==='reference')return (refs[field.target]||[]).find(r=>r.id===value)?.title||String(value).slice(0,8)+'…';
 if(field.type==='number')return new Intl.NumberFormat('ru-RU',{maximumFractionDigits:4}).format(value);
 return String(value);
}
let current=null;
async function mount({root,entity,api,toast,role}){
 const authorized=entity.access.write.includes(role);
 const env={root,entity,api,toast,role,authorized,offset:0,q:'',rows:[],total:0};current=env;
 async function refresh(){
  const url=`/api/entities/${entity.slug}/rows?limit=25&offset=${env.offset}&q=${encodeURIComponent(env.q)}`;
  const data=await api(url);env.rows=data.rows;env.total=data.total;
  const displayRefs=await references(entity,api).catch(()=>({}));
  const header=`<div class="page-title"><div><div class="eyebrow">CUSTOM DATA / ${esc(entity.slug.toUpperCase())}</div><h1>${esc(entity.title)}<span class="accent-dot">.</span></h1><p>${esc(entity.description||'Записи из пользовательской таблицы SQLite.')}</p></div>${authorized?'<button type="button" class="button primary" data-entity-create>+ Новая запись</button>':''}</div>`;
  const table=`<div class="surface table-surface"><div class="table-tools"><div><strong>Таблица ${esc(entity.title)}</strong><small>${env.total} записей</small></div><form data-entity-search class="search-field"><span>⌕</span><input name="q" aria-label="Поиск по записям" value="${esc(env.q)}" placeholder="Поиск по текстовым полям"><button type="submit">Найти</button></form></div><div class="table-scroll"><table><thead><tr>${entity.fields.map(f=>`<th>${esc(f.label)}</th>`).join('')}<th>Изменения</th></tr></thead><tbody>${data.rows.map(row=>`<tr>${entity.fields.map(f=>`<td>${esc(display(row[f.key],f,displayRefs))}</td>`).join('')}<td>${authorized?`<button type="button" class="entity-row-edit" data-row-edit="${esc(row.id)}">Изменить</button>`:'<span class="entity-readonly">Чтение</span>'}</td></tr>`).join('')||`<tr><td colspan="${entity.fields.length+1}">Пока записей нет. ${authorized?'Создайте первую запись.':'Обратитесь к администратору.'}</td></tr>`}</tbody></table></div><div class="entity-pagination"><span>${data.total?env.offset+1:0}–${Math.min(data.total,env.offset+data.rows.length)} из ${data.total}</span><div><button type="button" data-page-prev ${env.offset===0?'disabled':''}>← Назад</button><button type="button" data-page-next ${env.offset+25>=env.total?'disabled':''}>Далее →</button></div></div></div>`;
  root.innerHTML=header+table+'<div class="entity-dialog-wrap" data-entity-modal hidden></div>';
 }
 async function edit(row=null){
  if(!authorized)return toast('Недостаточно прав',true);
  try{
   const refs=await references(entity,api);const modal=root.querySelector('[data-entity-modal]');
   modal.hidden=false;modal.innerHTML=`<div class="entity-dialog-backdrop"><div class="entity-dialog" role="dialog" aria-modal="true" aria-label="${row?'Редактирование':'Новая запись'}"><header><div><span class="eyebrow">DATA / ${esc(entity.slug.toUpperCase())}</span><h2>${row?'Редактировать':'Новая запись'}</h2></div><button type="button" data-entity-close aria-label="Закрыть">×</button></header><form data-entity-form>${entity.fields.map(f=>input(f,row?.[f.key],refs)).join('')}<div class="entity-dialog-buttons">${row?'<button type="button" class="button outline" data-entity-archive>В архив</button>':''}<button type="submit" class="button primary">${row?'Сохранить изменения':'Создать запись'}</button></div></form></div></div>`;
   modal.querySelector('[data-entity-close]').onclick=()=>modal.hidden=true;
   modal.querySelector('[data-entity-form]').onsubmit=async ev=>{
    ev.preventDefault();const submit=ev.target.querySelector('[type=submit]');submit.disabled=true;
    try{const values=valuesFrom(ev.target,entity);
     await api(row?`/api/entities/${entity.slug}/rows/${row.id}`:`/api/entities/${entity.slug}/rows`,{method:row?'PATCH':'POST',body:row?{version:row.version,values}:{values}});
     toast('Запись сохранена');await refresh();
    }catch(err){toast(err.message,true);submit.disabled=false;}
   };
   if(row)modal.querySelector('[data-entity-archive]').onclick=async()=>{
    if(!confirm('Переместить запись в архив? Данные физически не удаляются.'))return;
    try{await api(`/api/entities/${entity.slug}/rows/${row.id}`,{method:'DELETE',body:{version:row.version}});toast('Запись архивирована');await refresh();}catch(err){toast(err.message,true);}
   };
   modal.querySelector('.entity-dialog-backdrop').onclick=ev=>{if(ev.target===modal.querySelector('.entity-dialog-backdrop'))modal.hidden=true};
  }catch(err){toast(err.message,true);}
 }
 root.onclick=ev=>{
  const a=ev.target.closest('[data-entity-create]');if(a)return edit();
  const id=ev.target.closest('[data-row-edit]')?.dataset.rowEdit;if(id)return edit(env.rows.find(r=>r.id===id));
  if(ev.target.closest('[data-page-prev]')){env.offset=Math.max(0,env.offset-25);refresh().catch(e=>toast(e.message,true));}
  if(ev.target.closest('[data-page-next]')){env.offset+=25;refresh().catch(e=>toast(e.message,true));}
 };
 root.onsubmit=ev=>{
  const f=ev.target.closest('[data-entity-search]');if(!f)return;ev.preventDefault();env.q=new FormData(f).get('q').trim().slice(0,80);env.offset=0;refresh().catch(e=>toast(e.message,true));
 };
 await refresh();
 return {create:()=>edit()};
}
window.crmEntityRuntime={mount,input,valuesFrom,references,display};
})();
