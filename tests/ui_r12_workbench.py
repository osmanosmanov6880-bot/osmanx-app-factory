"""R1.2 Chromium interaction test with mock APIs. Separate from real Node HTTP/SQLite tests."""
from pathlib import Path
import re,base64
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]; QA=ROOT/'qa'; QA.mkdir(exist_ok=True)
h=(ROOT/'public/studio/index.html').read_text()
h=re.sub(r'<link[^>]+href="/assets/studio/app.css"[^>]*>','',h)
h=re.sub(r'<script[^>]+src="/assets/studio/app.js"[^>]*></script>','',h)
css=(ROOT/'public/studio/app.css').read_text()
for file in (ROOT/'public/studio/media').iterdir():
 if file.suffix in ('.png','.jpg'):
  uri='data:'+('image/png' if file.suffix=='.png' else 'image/jpeg')+';base64,'+base64.b64encode(file.read_bytes()).decode()
  css=css.replace('/assets/studio/media/'+file.name,uri);h=h.replace('/assets/studio/media/'+file.name,uri)
files={name:(ROOT/f'public/studio/{name}.js').read_text() for name in ['editor','entities','templates','workflows','workbench','app']}
for name,fn in [('editor','initPageEditor'),('entities','initEntityEditor'),('templates','initTemplateLibrary'),('workflows','initWorkflowStudio'),('workbench','initProjectWorkbench')]:
 files[name]=files[name].replace('export function '+fn,'function '+fn)
 files['app']=files['app'].replace(f"import {{ {fn} }} from './{name}.js';",f'const {{{fn}}}=window;')
mock=r'''
window.ox={calls:[],project:{id:'11111111-2222-4333-8444-555555555555',name:'OSMANX / Премиальная стоматология',type:'crm',industry:'dental',modules:['auth','clients','tasks','analytics','payments'],settings:{accent:'#c9a473',currency:'RUB',primaryAction:'new_client'},createdAt:'2026-11-04T00:00:00.000Z',
 pages:[
 {id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',title:'Рабочая панель',slug:'work-panel',description:'Все важные показатели',published:true,revision:1,blocks:[{type:'hero',id:'hero-primary-001',eyebrow:'OSMANX',title:'Контроль клиники',subtitle:'Обзор'},{type:'button',id:'button-action-001',action:'navigate:page:visits-info',label:'Открыть инструкции',roles:['admin','manager'],confirm:true,confirmText:'Перейти к инструкциям?',style:'primary'}]},
 {id:'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',title:'Информация о визитах',slug:'visits-info',description:'Инструкции команды',published:true,revision:1,blocks:[{type:'text',id:'text-action-001',title:'Инструкция',body:'Важно соблюдать регламент'}]}],
 entities:[{id:'cccccccc-dddd-4eee-8fff-111111111111',slug:'patients',title:'Пациенты',revision:1,fields:[{key:'full_name',label:'Имя пациента',type:'text'},{key:'phone',label:'Телефон',type:'text'}],access:{read:['admin','manager','staff'],write:['admin','manager']}},{id:'dddddddd-eeee-4fff-8000-222222222222',slug:'appointments',title:'Записи на приём',revision:1,fields:[{key:'doctor',label:'Врач',type:'text'},{key:'status',label:'Статус',type:'select',options:['Новая','Подтверждена']}],access:{read:['admin','manager','staff'],write:['admin','manager']}}],
 automationPresets:[{id:'eeeeeeee-ffff-4000-8111-333333333333',name:'Подготовка кабинета',event:'entity_created',entity_slug:'appointments',condition_field:'status',condition_value:'Подтверждена',task_title:'Подготовить кабинет',priority:'high',due_days:1,enabled:true,revision:1}]},
 diagnostics:{summary:{exportReady:true,errors:0,warnings:1},checks:[{key:'configuration',level:'ok',title:'Структура корректна',detail:'Все проверки пройдены'},{key:'payments',level:'warning',title:'Учётный журнал',detail:'Настоящие платежи не подключены'}]},releases:[]};
window.fetch=async(url,options={})=>{
 const path=String(url),method=options.method||'GET',data=options.body?JSON.parse(options.body):{};
 ox.calls.push({path,method,data});const response=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json'}});
 if(path==='/api/studio/session')return response({authenticated:true,initialized:true,user:{name:'Владелец'},csrf:'mock-token'});
 if(path==='/api/studio/projects'&&method==='GET')return response({projects:[(({pages,entities,automationPresets,...r})=>r)(ox.project)]});
 if(path==='/api/studio/projects/'+ox.project.id+'/workbench')return response({project:ox.project,diagnostics:ox.diagnostics,releases:ox.releases});
 if(path==='/api/studio/projects/'+ox.project.id)return response({project:ox.project});
 if(path==='/api/studio/projects/'+ox.project.id+'/pages')return response({pages:ox.project.pages});
 if(path.includes('/pages/')&&method==='PATCH'){
  const id=path.split('/').at(-1),index=ox.project.pages.findIndex(p=>p.id===id);
  if(index<0)return response({error:'Missing page'},404);
  ox.project.pages[index]={...ox.project.pages[index],...data,revision:ox.project.pages[index].revision+1};return response({page:ox.project.pages[index]});
 }
 if(path.includes('/workflows/')&&method==='PATCH'){
  const id=path.split('/').at(-1),index=ox.project.automationPresets.findIndex(p=>p.id===id);
  ox.project.automationPresets[index]={...ox.project.automationPresets[index],...data,revision:ox.project.automationPresets[index].revision+1};return response({workflow:ox.project.automationPresets[index]});
 }
 return response({error:'Not mocked: '+path},404);
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 for width,height in [(1440,930),(390,844)]:
  page=browser.new_page(viewport={'width':width,'height':height});page.set_default_timeout(8000)
  errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
  page.set_content(h);page.add_style_tag(content=css);page.add_script_tag(content=mock)
  for name,fn in [('editor','initPageEditor'),('entities','initEntityEditor'),('templates','initTemplateLibrary'),('workflows','initWorkflowStudio'),('workbench','initProjectWorkbench')]:
   page.add_script_tag(content='(()=>{'+files[name]+f'\nwindow.{fn}={fn}'+'})();')
  page.add_script_tag(content=files['app'])
  page.locator('[data-project-workbench]').first.wait_for(state='visible')
  page.locator('[data-project-workbench]').first.click()
  page.locator('#workbenchOverlay').wait_for(state='visible')
  page.locator('.oxw-stats button').first.wait_for(state='visible')
  page.screenshot(path=str(QA/f'r12_workbench_{width}.png'))
  page.locator('#oxwTabs [data-oxw-tab="pages"]').click()
  assert page.locator('.oxw-line').count()==2
  page.locator('[data-oxw-action^="publish-page:"]').first.click()
  page.wait_for_function('ox.project.pages[0].published===false')
  page.locator('#oxwTabs [data-oxw-tab="actions"]').click()
  assert page.locator('.oxw-line').count()==1
  page.screenshot(path=str(QA/f'r12_actions_{width}.png'))
  page.locator('[data-oxw-action^="edit-action:"]').click()
  page.locator('#pageEditor').wait_for(state='visible')
  page.locator('[data-block-boolean="confirm"]').wait_for(state='visible')
  assert page.locator('[data-button-role="admin"]').is_checked()
  assert not page.locator('[data-button-role="staff"]').is_checked()
  page.screenshot(path=str(QA/f'r12_button_editor_{width}.png'))
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),f'Body horizontal overflow: {width}'
  assert not errors,errors
  print('R1.2 Chromium static/mock workbench OK',width,flush=True)
  page.close()
 browser.close()
