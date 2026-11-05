"""R1.0 mocked API Chromium UI: independent of the real HTTP integration suite."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import base64,re,faulthandler
faulthandler.enable()
faulthandler.dump_traceback_later(25,repeat=False)
ROOT=Path(__file__).resolve().parents[1]
QA=ROOT/'qa';QA.mkdir(exist_ok=True)

def inline_studio():
 h=(ROOT/'public/studio/index.html').read_text()
 h=re.sub(r'<link[^>]+href="/assets/studio/app.css"[^>]*>','',h)
 h=re.sub(r'<script[^>]+src="/assets/studio/app.js"[^>]*></script>','',h)
 css=(ROOT/'public/studio/app.css').read_text()
 media={}
 for f in (ROOT/'public/studio/media').iterdir():
  if f.suffix in ('.jpg','.png'):
   media[f.name]='data:'+('image/png' if f.suffix=='.png' else 'image/jpeg')+';base64,'+base64.b64encode(f.read_bytes()).decode()
   css=css.replace('/assets/studio/media/'+f.name,media[f.name])
 h=h.replace('/assets/studio/media/profile-avatar.png',media['profile-avatar.png'])
 editor=(ROOT/'public/studio/editor.js').read_text().replace('export function initPageEditor','function initPageEditor')
 entities=(ROOT/'public/studio/entities.js').read_text().replace('export function initEntityEditor','function initEntityEditor')
 templates=(ROOT/'public/studio/templates.js').read_text().replace('export function initTemplateLibrary','function initTemplateLibrary')
 app=(ROOT/'public/studio/app.js').read_text().replace("import { initPageEditor } from './editor.js';",'const {initPageEditor}=window;').replace("import { initEntityEditor } from './entities.js';",'const {initEntityEditor}=window;').replace("import { initTemplateLibrary } from './templates.js';",'const {initTemplateLibrary}=window;')
 mock='''
const projects=[
{id:'11111111-2222-4333-8444-555555555555',name:'Dental Premium',type:'crm',industry:'dental',modules:['auth','clients','tasks','analytics','payments'],settings:{accent:'#bc9665',currency:'RUB',primaryAction:'new_client'},createdAt:'2026-11-04T00:00:00.000Z'},
{id:'22222222-3333-4444-8555-666666666666',name:'Auto Service',type:'crm',industry:'auto',modules:['auth','clients','tasks'],settings:{accent:'#bc9665',currency:'RUB',primaryAction:'new_client'},createdAt:'2026-11-03T00:00:00.000Z'}];
window.mock={projects,created:[],calls:[]};
window.fetch=async(u,o={})=>{const path=String(u),method=o.method||'GET',data=o.body?JSON.parse(o.body):{};mock.calls.push({path,method,data});
const respond=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
if(path==='/api/studio/session')return respond({authenticated:true,initialized:true,user:{name:'Владелец'},csrf:'token'});
if(path==='/api/studio/projects'&&method==='GET')return respond({projects:mock.projects});
if(path==='/api/studio/projects'&&method==='POST'){
 const p={...mock.projects[0],...data,id:'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',createdAt:new Date().toISOString()};mock.created.push(p);mock.projects.unshift(p);return respond({project:p},201);
}
if(path.includes('/diagnostics'))return respond({summary:{errors:0,warnings:1},checks:[{key:'pages',level:'ok',title:'Страницы готовы',detail:'Стартовая страница опубликована'},{key:'payments',level:'warning',title:'Учёт платежей',detail:'Реальные банковские списания не подключены'}]});
if(path.startsWith('/api/studio/projects/')&&method==='GET'){
 const id=path.split('/')[4];const p=mock.projects.find(x=>x.id===id)||mock.projects[0];return respond({project:{...p,entities:[{slug:'patients',title:'Пациенты'},{slug:'appointments',title:'Записи'}],pages:[{slug:'workspace',published:true}]}});
}
return respond({error:'Not mocked: '+path},404);
};
'''
 return h,css,mock,editor,entities,templates,app,media

def studio(browser):
 h,css,mock,editor,entities,templates,app,media=inline_studio()
 for width,height in [(1440,900),(390,844)]:
  page=browser.new_page(viewport={'width':width,'height':height});page.set_default_timeout(7000);print('START UI',width,flush=True)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(h);page.add_style_tag(content=css);page.add_script_tag(content=mock)
  page.add_script_tag(content='(()=>{'+editor+'\nwindow.initPageEditor=initPageEditor})();')
  page.add_script_tag(content='(()=>{'+entities+'\nwindow.initEntityEditor=initEntityEditor})();')
  page.add_script_tag(content='(()=>{'+templates+'\nwindow.initTemplateLibrary=initTemplateLibrary})();')
  page.add_script_tag(content=app)
  page.locator('.project-card').first.wait_for(state='visible');print('CARDS',width,flush=True)
  print('CLICK HUB',width,flush=True);page.locator('[data-project-hub]').first.click()
  page.locator('#projectHubOverlay').wait_for(state='visible')
  assert page.locator('.hub-action').count()>=6
  page.locator('[data-hub-action="check"]').click()
  page.locator('#hubDiagnostics').wait_for(state='visible');print('DIAG OK',width,flush=True)
  page.screenshot(path=str(QA/f'r10_project_hub_{width}.png'))
  page.locator('#projectHubClose').click();print('HUB CLOSED',width,flush=True)
  page.locator('[data-start-type="crm"]').click()
  page.locator('#projectIndustry').select_option('dental')
  page.locator('#projectName').fill('Новая стоматология')
  assert page.locator('#blueprintName').inner_text()=='Стоматология · CRM'
  page.screenshot(path=str(QA/f'r10_industry_wizard_{width}.png'))
  print('WIZARD',width,flush=True);page.locator('#builderNext').click();page.locator('#builderNext').click();page.locator('#createProject').click()
  page.wait_for_function('mock.created.length===1')
  assert page.evaluate('mock.created[0].industry')=='dental'
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),'Studio overflow '+str(width)
  assert not errors,errors
  page.close()

def crm(browser):
 h=(ROOT/'public/crm/index.html').read_text()
 h=re.sub(r'<link[^>]+href="assets/app.css"[^>]*>','',h)
 h=re.sub(r'<script[^>]+src="assets/[^\"]+"[^>]*></script>','',h)
 css=(ROOT/'public/crm/app.css').read_text()
 mock='''
location.hash='#automations';
history.replaceState=()=>{}; // about:blank mock has opaque origin; real HTTP origin allows replaceState
window.mock={rules:[],calls:[]};
window.fetch=async(u,o={})=>{const path=String(u),method=o.method||'GET',body=o.body?JSON.parse(o.body):null;mock.calls.push({path,method,body});
const out=(obj,status=200)=>new Response(JSON.stringify({ok:true,...obj}),{status,headers:{'Content-Type':'application/json'}});
if(path==='/api/config')return out({config:{id:'00000000-0000-4000-8000-000000000001',name:'Dental Premium',type:'crm',industry:'dental',modules:['auth','clients','analytics','tasks','payments'],settings:{accent:'#bfa16b',primaryAction:'new_client',currency:'RUB'},requiresSetupToken:false}});
if(path==='/api/session')return out({initialized:true,authenticated:true,user:{id:'admin',name:'Администратор',role:'admin',email:'admin@example.test'},csrf:'token'});
if(path==='/api/entities')return out({entities:[{slug:'appointments',title:'Записи на приём',fields:[{key:'status',label:'Статус',type:'select',options:['Запланирована','Подтверждена','Завершена']}],access:{read:['admin','manager','staff'],write:['admin','manager']}}]});
if(path==='/api/pages')return out({pages:[]});
if(path==='/api/automations'&&method==='GET')return out({automations:mock.rules,capabilities:{events:['client_created','visit_created','entity_created'],action:'create_task',entities:[{slug:'appointments',title:'Записи на приём',fields:[{key:'status',label:'Статус',type:'select',options:['Запланирована','Подтверждена','Завершена']},{key:'doctor',label:'Специалист',type:'text'}]}]}});
if(path==='/api/automations'&&method==='POST'){
 mock.rules.push({id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',enabled:1,...body});return out({automation:mock.rules.at(-1)},201);
}
if(path==='/api/automations/runs')return out({runs:[]});
return out({error:'No mock for '+path},404);
};
'''
 for width,height in [(1440,900),(390,844)]:
  page=browser.new_page(viewport={'width':width,'height':height});page.set_default_timeout(7000);print('START UI',width,flush=True)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(h);page.add_style_tag(content=css);page.add_script_tag(content=mock)
  page.add_script_tag(content=(ROOT/'public/crm/entities.js').read_text())
  page.add_script_tag(content=(ROOT/'public/crm/pages.js').read_text())
  page.add_script_tag(content=(ROOT/'public/crm/app.js').read_text())
  page.locator('#appScreen').wait_for(state='visible');print('CRM APP',width,flush=True)
  page.locator('#view-automations').wait_for(state='visible');print('CRM AUTOMATION',width,flush=True)
  try:
   page.wait_for_function("document.querySelector('#automationEntity').options.length>0")
  except Exception:
   print('AUTOMATION DEBUG',width,page.evaluate("({calls:mock.calls,view:document.querySelector('#breadcrumb')?.textContent,toast:document.querySelector('#toast')?.textContent,options:document.querySelector('#automationEntity')?.innerHTML})"),'ERRORS',errors,flush=True)
   raise
  page.locator('#automationEvent').select_option('entity_created')
  assert page.locator('#automationEntityOptions').is_visible()
  page.locator('#automationConditionField').select_option('status')
  assert page.locator('#automationConditionChoice').is_visible()
  page.locator('#automationConditionChoice').select_option('Подтверждена')
  page.locator('#automationName').fill('Подготовка кабинета')
  page.locator('#automationTitle').fill('Подготовить кабинет')
  page.screenshot(path=str(QA/f'r10_automation_builder_{width}.png'),full_page=False)
  page.locator('#automationForm [type=submit]').click()
  page.wait_for_function('mock.rules.length===1')
  assert page.evaluate('mock.rules[0].condition_value')=='Подтверждена'
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),'CRM overflow '+str(width)
  assert not errors,errors
  page.close()

with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 studio(browser);crm(browser);browser.close()
print('R1.0 mocked-API Chromium UI: hub, diagnostics, dental wizard, conditional workflows 1440/390 PASS')
