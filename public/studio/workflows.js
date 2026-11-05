const $=id=>document.getElementById(id);
const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function initWorkflowStudio({api,toast}){
 let project=null,items=[],selected=null;
 const overlay=$('workflowOverlay');
 const control=(id)=>$(id);
 function reset(){
  selected=null;control('workflowForm').reset();control('workflowDays').value='0';control('workflowEnabled').checked=true;
  control('workflowEvent').value='entity_created';control('workflowPriority').value='medium';
  refreshFields();control('workflowSave').textContent='Сохранить сценарий';
  control('workflowPreview').textContent='Проверка ничего не меняет в реальной базе данных.';
  control('workflowPreview').className='ox-workflow-result';renderList();
 }
 function refreshFields(){
  const event=control('workflowEvent').value;
  const isEntity=event==='entity_created';
  control('workflowEntityWrap').hidden=!isEntity;control('workflowConditionWrap').hidden=!isEntity;
  const saved=control('workflowEntity').value;
  control('workflowEntity').innerHTML=project?.entities?.length?project.entities.map(e=>`<option value="${safe(e.slug)}">${safe(e.title)}</option>`).join(''):'<option value="">Нет таблиц — сначала создайте их в «База данных»</option>';
  if(project.entities.some(e=>e.slug===saved))control('workflowEntity').value=saved;
  refreshCondition();
 }
 function refreshCondition(){
  const entity=project?.entities?.find(e=>e.slug===control('workflowEntity').value);
  const current=control('workflowCondition').value;
  const available=(entity?.fields||[]).filter(f=>['text','select','boolean','integer'].includes(f.type));
  control('workflowCondition').innerHTML='<option value="">Без условия — при каждой записи</option>'+available.map(f=>`<option value="${safe(f.key)}">${safe(f.label)}</option>`).join('');
  if(available.some(f=>f.key===current))control('workflowCondition').value=current;
  refreshValue();
 }
 function refreshValue(){
  const entity=project?.entities?.find(e=>e.slug===control('workflowEntity').value);
  const f=entity?.fields?.find(f=>f.key===control('workflowCondition').value);
  control('workflowValueWrap').hidden=!f;
  if(!f){control('workflowValue').value='';return;}
  const parent=control('workflowValue');const value=parent.value;
  if(f.type==='select'||f.type==='boolean'){
    const options=f.type==='boolean'?['true','false']:f.options;
    const s=document.createElement('select');s.id='workflowValue';s.innerHTML=options.map(v=>`<option value="${safe(v)}">${safe(v)}</option>`).join('');parent.replaceWith(s);
    if(options.includes(value))s.value=value;
  }else if(parent.tagName!=='INPUT'){
    const el=document.createElement('input');el.id='workflowValue';el.maxLength=120;el.placeholder='Точное значение';parent.replaceWith(el);el.value=value;
  }
 }
 function read(){
  const event=control('workflowEvent').value;
  const input={name:control('workflowName').value,event,task_title:control('workflowTask').value,priority:control('workflowPriority').value,due_days:Number(control('workflowDays').value),enabled:control('workflowEnabled').checked};
  if(event==='entity_created'){
    input.entity_slug=control('workflowEntity').value;
    if(control('workflowCondition').value){input.condition_field=control('workflowCondition').value;input.condition_value=control('workflowValue').value}
  }
  return input;
 }
 function renderList(){
  control('workflowCount').textContent=`${items.length} из 30 правил`;
  control('workflowList').innerHTML=items.length?items.map(w=>`<article class="ox-workflow-card ${selected?.id===w.id?'is-selected':''}">
    <h4>${safe(w.name)}</h4><p>${w.event==='entity_created'?'Таблица: '+safe(project.entities.find(e=>e.slug===w.entity_slug)?.title||w.entity_slug):w.event==='client_created'?'Новый клиент':'Новый визит'}${w.condition_field?' · '+safe(w.condition_field)+' = '+safe(w.condition_value):''}</p>
    <div class="ox-workflow-card-foot"><span class="ox-workflow-status ${w.enabled?'':'off'}">${w.enabled?'● Включено':'○ Выключено'}</span><div><button type="button" data-wf-edit="${safe(w.id)}">Изменить</button> <button type="button" data-wf-delete="${safe(w.id)}">Удалить</button></div></div></article>`).join(''):'<p class="ox-workflow-empty">Пока нет сценариев. Создайте первое правило слева. Оно сохранится в настройках проекта и будет доступно следующим клиентам.</p>';
 }
 function edit(w,scroll=true){
  selected=w;control('workflowName').value=w.name;control('workflowEvent').value=w.event;refreshFields();
  if(w.entity_slug)control('workflowEntity').value=w.entity_slug;
  refreshCondition();if(w.condition_field)control('workflowCondition').value=w.condition_field;refreshValue();
  if(w.condition_value!==null&&w.condition_value!==undefined)control('workflowValue').value=w.condition_value;
  control('workflowTask').value=w.task_title;control('workflowPriority').value=w.priority;
  control('workflowDays').value=w.due_days;control('workflowEnabled').checked=!!w.enabled;
  control('workflowSave').textContent='Сохранить изменения';renderList();
  if(scroll){control('workflowName').focus({preventScroll:true});control('workflowForm').scrollIntoView({block:'start',behavior:'smooth'});}
 }
 async function reload(){
  const data=await api(`/api/studio/projects/${project.id}/workflows`);items=data.workflows;renderList();
 }
 function close(){overlay.hidden=true;project=null;selected=null}
 control('workflowClose').addEventListener('click',close);
 overlay.addEventListener('click',e=>{if(e.target===overlay)close()});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!overlay.hidden)close()});
 control('workflowNew').addEventListener('click',reset);
 control('workflowEvent').addEventListener('change',refreshFields);
 control('workflowEntity').addEventListener('change',refreshCondition);
 control('workflowCondition').addEventListener('change',refreshValue);
 control('workflowList').addEventListener('click',async e=>{
  const b=e.target.closest('[data-wf-edit],[data-wf-delete]');if(!b)return;
  const id=b.dataset.wfEdit||b.dataset.wfDelete;const w=items.find(x=>x.id===id);if(!w)return;
  if(b.dataset.wfEdit){edit(w);return;}
  if(!confirm(`Удалить сценарий «${w.name}» из шаблона? Рабочая CRM останется без изменений.`))return;
  try{await api(`/api/studio/projects/${project.id}/workflows/${id}`,{method:'DELETE'});if(selected?.id===id)reset();await reload();toast('Сценарий удалён из шаблона.')}catch(err){toast(err.message,true)}
 });
 control('workflowForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!project)return;
  const body=read();const url=`/api/studio/projects/${project.id}/workflows`+(selected?'/'+selected.id:'');
  try{const r=await api(url,{method:selected?'PATCH':'POST',body:selected?{...body,revision:selected.revision}:body});await reload();edit(r.workflow,false);toast('Сценарий сохранён. Он войдёт в новые проекты.');}catch(err){toast(err.message,true)}
 });
 control('workflowSimulate').addEventListener('click',async()=>{
  try{
    const rule=read(),values={};if(rule.condition_field){
      const raw=rule.condition_value;values[rule.condition_field]=raw==='true'?true:raw==='false'?false:/^-?\d+$/.test(raw)?Number(raw):raw;
    }
    // Other interpolations are purely sample placeholders, not customer data.
    if(rule.event==='entity_created')for(const field of project.entities.find(e=>e.slug===rule.entity_slug)?.fields||[])if(!Object.hasOwn(values,field.key)&&field.type==='text')values[field.key]='Пример';
    const result=await api(`/api/studio/projects/${project.id}/workflow-preview`,{method:'POST',body:{rule,sample:{event:rule.event,entitySlug:rule.entity_slug||null,recordValues:values}}});
    const el=control('workflowPreview');el.className='ox-workflow-result '+(result.wouldRun?'success':'fail');
    el.textContent=result.wouldRun?`✓ Сработает. Будет создана задача: «${result.taskTitle}» (${rule.due_days?`через ${rule.due_days} дн.`:'без срока'}).`:`Не сработает: ${result.reason}`;
  }catch(err){control('workflowPreview').textContent='Проверка: '+err.message;control('workflowPreview').className='ox-workflow-result fail'}
 });
 return {async open(complete){
  if(complete.type!=='crm'||!complete.modules.includes('tasks')){toast('Нужна CRM с модулем задач',true);return}
  project=complete;selected=null;control('workflowHeading').textContent=`Сценарии — ${complete.name}`;
  control('workflowSubtitle').textContent='Повторно используемые правила, которые войдут в шаблон и новый ZIP';
  overlay.hidden=false;control('workflowForm').reset();refreshFields();reset();
  try{await reload()}catch(err){toast(err.message,true);close();return}
  control('workflowName').focus({preventScroll:true});
 }};
}
