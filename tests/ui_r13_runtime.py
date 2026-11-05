"""R1.3 Chromium render smoke: actual browser runtimes with explicitly mocked data APIs."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import re
ROOT=Path(__file__).resolve().parents[1];QA=ROOT/'qa';QA.mkdir(exist_ok=True)
CRM_CSS=(ROOT/'public/crm/app.css').read_text()
CRM_JS=(ROOT/'public/crm/pages.js').read_text()
SITE_CSS=(ROOT/'public/site/site.css').read_text()
SITE_HTML=(QA/'r13_demo_site.html').read_text()
SITE_HTML=re.sub(r'<link rel="stylesheet" href="[^"]+">','',SITE_HTML)
CRM_MOCK=r'''
window.Entities=[{slug:'patients',title:'Пациенты',access:{read:['admin','manager','staff'],write:['admin','manager','staff']},fields:[{key:'full_name',label:'Имя пациента',type:'text'},{key:'phone',label:'Телефон',type:'text'}]}];
window.crmr={calls:[],page:{title:'Управление клиникой',slug:'office',description:'Готовые показатели и список пациентов',published:true,blocks:[
 {id:'hero-r13',type:'hero',layout:'wide',eyebrow:'OSMANX',title:'Контроль сервиса',subtitle:'Ваши данные — в одном месте.'},
 {id:'metric-patients',type:'metric',layout:'half',metric:'entity_count',entity:'custom:patients',label:'Всего пациентов'},
 {id:'metric-guests',type:'metric',layout:'half',metric:'clients_total',label:'Гостей'},
 {id:'table-patients',type:'table',layout:'wide',title:'Пациенты клиники',entity:'custom:patients',columns:['full_name','phone'],limit:5}
 ]}};
window.crmEntityRuntime={display:(val)=>val,input:()=>'',references:()=>({}),valuesFrom:()=>({})};
window.mockApi=async(path,options={})=>{
 crmr.calls.push(path);
 if(path==='/api/page-metrics')return {metrics:{clients_total:9},currency:'RUB'};
 if(path==='/api/entities/patients/rows?limit=1')return {total:17,rows:[]};
 if(path==='/api/entities/patients/rows?limit=5')return {total:17,rows:Array.from({length:5},(_,i)=>({full_name:'Пациент '+(i+1),phone:'+7 900 000 00 0'+i}))};
 throw Error('Unexpected endpoint: '+path);
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 for width,height in [(1440,930),(390,844)]:
  # Isolated CRM page interpreter with the same CSS/JS assets exported to each standalone CRM.
  page=browser.new_page(viewport={'width':width,'height':height});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="padding:28px;background:#101116"><main id="crm"></main></body></html>')
  page.add_style_tag(content=CRM_CSS);page.add_script_tag(content=CRM_MOCK);page.add_script_tag(content=CRM_JS)
  page.evaluate("window.crmPageRuntime.mount({root:document.getElementById('crm'),page:crmr.page,api:mockApi,navigate:()=>{},openClient:()=>{},openTask:()=>{},openVisit:()=>{},openPayment:()=>{},toast:()=>{},privileged:()=>true,formatMoney:v=>String(v),entities:window.Entities,role:'admin',pages:[crmr.page]})")
  page.locator('[data-entity-count]').filter(has_text='17').wait_for(timeout=8000)
  assert page.locator('[data-table-block="table-patients"] tr').count()==5
  a=page.locator('.page-layout-half').nth(0).bounding_box();b=page.locator('.page-layout-half').nth(1).bounding_box()
  if width==1440:assert abs(a['y']-b['y'])<3 and b['x']>a['x'],'Half-width metrics should share a desktop row'
  else:assert b['y']>a['y']+a['height']-2,'Mobile metrics should stack'
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),f'CRM overflow {width}'
  assert not errors,errors
  page.screenshot(path=str(QA/f'r13_crm_layout_{width}.png'));page.close()
  # Actual static HTML exported by the corporate-site page renderer.
  site=browser.new_page(viewport={'width':width,'height':height});site.set_content(SITE_HTML);site.add_style_tag(content=SITE_CSS)
  half=site.locator('.site-span-half');assert half.count()>=2
  a=half.nth(0).bounding_box();b=half.nth(1).bounding_box()
  if width==1440:assert abs(a['y']-b['y'])<3 and b['x']>a['x'],'Site halves side by side'
  else:assert b['y']>=a['y']+a['height']-2,'Site stacked on mobile'
  assert site.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),f'Site overflow {width}'
  site.screenshot(path=str(QA/f'r13_site_layout_{width}.png'));site.close()
  print('R1.3 runtime layout QA passed:',width,flush=True)
 browser.close()
