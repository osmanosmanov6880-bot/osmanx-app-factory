"""Static Chromium event smoke for published pages with mocked API responses.
Separate from HTTP/API E2E: browser navigation is blocked by environment policy.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import re
ROOT=Path(__file__).resolve().parents[1]
QA=ROOT/'qa'; QA.mkdir(exist_ok=True)
HTML=(ROOT/'public/crm/index.html').read_text()
HTML=re.sub(r'<link[^>]+href="assets/app.css"[^>]*>','',HTML)
HTML=re.sub(r'<script[^>]+src="assets/[^\"]+"[^>]*></script>','',HTML)
CSS=(ROOT/'public/crm/app.css').read_text()
PAGES_JS=(ROOT/'public/crm/pages.js').read_text()
ENTITIES_JS=(ROOT/'public/crm/entities.js').read_text()
APP_JS=(ROOT/'public/crm/app.js').read_text()
MOCK='''
const blocks=[
 {id:'block-hero-01',type:'hero',eyebrow:'SERVICE EXCELLENCE',title:'Гости. Забота. Рост.',subtitle:'Один экран для всей команды.'},
 {id:'block-metric-01',type:'metric',metric:'clients_total',label:'Гости в базе'},
 {id:'block-text-01',type:'text',title:'Блок знаний',body:'<img src=x onerror=alert(1)>'},
 {id:'block-form-01',type:'form',entity:'clients',title:'Добавить гостя',fields:['full_name','phone','source'],submitLabel:'Сохранить гостя'},
 {id:'block-table-01',type:'table',entity:'clients',title:'Последние гости',columns:['full_name','phone','source']},
 {id:'block-action-01',type:'button',label:'Задачи команды',action:'navigate:tasks',style:'secondary'}
];
window.history.replaceState=()=>{};
window.mock={clients:[{id:'a',full_name:'Анна',phone:'+7 999 111 22 33',source:'walkin'},{id:'b',full_name:'Марат',phone:'+7 999 222 33 44',source:'referral'}],calls:[]};
const PROJECT={id:'00000000-0000-4000-8000-000000000001',name:'ATELIER · Restaurant CRM',type:'crm',industry:'restaurant',modules:['auth','clients','analytics','tasks','payments'],settings:{accent:'#99b8ff',primaryAction:'new_client',currency:'RUB'},requiresSetupToken:false};
window.fetch=async (url,options={})=>{
 const path=String(url);const method=options.method||'GET';window.mock.calls.push(method+' '+path);
 const res=(obj,code=200)=>new Response(JSON.stringify({ok:true,...obj}),{status:code,headers:{'Content-Type':'application/json'}});
 if(path==='/api/config')return res({config:PROJECT});
 if(path==='/api/session')return res({initialized:true,authenticated:true,user:{id:'admin',name:'Администратор',role:'admin',email:'admin@test.example'},csrf:'csrf'});
 if(path==='/api/entities')return res({entities:[]});
 if(path==='/api/pages')return res({pages:[{id:'page-01',slug:'service',title:'Контроль сервиса',description:'Гостевой опыт и операционные процессы',published:true,blocks}]});
 if(path==='/api/page-metrics')return res({metrics:{clients_total:window.mock.clients.length,visits_total:4,open_tasks:3,paid_minor:125000,repeat_share:50},currency:'RUB'});
 if(path==='/api/clients'&&method==='GET')return res({clients:window.mock.clients});
 if(path==='/api/clients'&&method==='POST'){
  const body=JSON.parse(options.body);window.mock.clients.push({id:'new-'+window.mock.clients.length,...body});return res({client:window.mock.clients.at(-1)},201);
 }
 if(path==='/api/tasks')return res({tasks:[]});
 if(path==='/api/analytics')return res({analytics:{currency:'RUB',totals:{clients:2,repeatShare:50,repeatClients:1,visitedClients:2,paidMinor:125000,openTasks:3,overdueTasks:0,visits:4},monthly:[],sourceBreakdown:[],latestTasks:[]}});
 if(path==='/api/users')return res({users:[]});
 return res({error:'Unknown: '+path},404);
};
'''
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server'])
 for width,height,name in [(1440,900,'crm_page_1440.png'),(390,844,'crm_page_390.png')]:
  page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(HTML)
  page.add_style_tag(content=CSS)
  page.add_script_tag(content=MOCK)
  page.add_script_tag(content=ENTITIES_JS)
  page.add_script_tag(content=PAGES_JS)
  page.add_script_tag(content=APP_JS)
  page.locator('#appScreen').wait_for(state='visible')
  page.locator('[data-view="page:service"]').click()
  page.locator('.page-hero').get_by_text('Гости. Забота. Рост.').wait_for(timeout=3000)
  page.locator('.page-table tbody tr').first.wait_for()
  assert page.locator('[data-metric="clients_total"]').inner_text()=='2'
  assert page.locator('.page-table tbody tr').count()==2
  assert page.locator('#customPageBody img').count()==0,'text must not become executable HTML'
  page.screenshot(path=str(QA/name.replace('crm_page_','crm_page_top_')),full_page=False)
  page.locator('form[data-custom-form="clients"] [name="full_name"]').fill('Новый гость')
  page.locator('form[data-custom-form="clients"] [name="source"]').select_option('social')
  page.locator('form[data-custom-form="clients"] button[type="submit"]').click()
  page.wait_for_function('window.mock.clients.length===3')
  page.locator('[data-metric="clients_total"]').get_by_text('3').wait_for()
  page.screenshot(path=str(QA/name),full_page=False)
  assert not errors,errors
  assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2'),f'root overflow at {width}px'
  page.close()
 browser.close()
print('CRM PUBLISHED PAGE MOCK SMOKE PASSED')
