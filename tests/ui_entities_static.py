"""Chromium UI interaction smoke with mocked API, not live HTTP browser E2E.
The separate Node tests cover real HTTP+SQLite migration/export behavior.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import re
ROOT=Path(__file__).resolve().parents[1]
QA=ROOT/'qa';QA.mkdir(exist_ok=True)
STUDIO=re.sub(r'<link[^>]+href="/assets/studio/app.css"[^>]*>','', (ROOT/'public/studio/index.html').read_text())
STUDIO=re.sub(r'<script[^>]+src="/assets/studio/app.js"[^>]*></script>','',STUDIO)
STUDIO_CSS=(ROOT/'public/studio/app.css').read_text()
EDITOR=(ROOT/'public/studio/editor.js').read_text().replace('export function initPageEditor','function initPageEditor')
ENTITIES=(ROOT/'public/studio/entities.js').read_text().replace('export function initEntityEditor','function initEntityEditor')
TEMPLATES=(ROOT/'public/studio/templates.js').read_text().replace('export function initTemplateLibrary','function initTemplateLibrary')
STUDIO_APP=(ROOT/'public/studio/app.js').read_text().replace("import { initPageEditor } from './editor.js';",'').replace("import { initEntityEditor } from './entities.js';",'')
STUDIO_APP=STUDIO_APP.replace("import { initTemplateLibrary } from './templates.js';",'const {initTemplateLibrary}=window;')
CRM=re.sub(r'<link[^>]+href="assets/app.css"[^>]*>','',(ROOT/'public/crm/index.html').read_text())
CRM=re.sub(r'<script[^>]+src="assets/[^"]+"[^>]*></script>','',CRM)
CRM_CSS=(ROOT/'public/crm/app.css').read_text()
CRM_ENTITIES=(ROOT/'public/crm/entities.js').read_text()
CRM_PAGES=(ROOT/'public/crm/pages.js').read_text()
CRM_APP=(ROOT/'public/crm/app.js').read_text()
MODEL='''
const supplier={id:'11111111-1111-4111-8111-111111111111',revision:1,slug:'suppliers',title:'Поставщики',description:'Управление контрагентами ресторана',access:{read:['admin','manager','staff'],write:['admin','manager']},fields:[{key:'company',label:'Компания',type:'text',required:true},{key:'phone',label:'Телефон',type:'text',required:false},{key:'active',label:'Работает',type:'boolean',required:true}]};
const order={id:'22222222-2222-4222-8222-222222222222',revision:1,slug:'orders',title:'Заказы',description:'Закупки, поставщики и контроль исполнения',access:{read:['admin','manager','staff'],write:['admin','manager']},fields:[{key:'title',label:'Номер заказа',type:'text',required:true},{key:'supplier',label:'Поставщик',type:'reference',target:'suppliers',required:true},{key:'state',label:'Статус',type:'select',options:['новый','закрыт'],required:true},{key:'quantity',label:'Количество',type:'integer',required:false},{key:'ordered_on',label:'Дата',type:'date',required:false}]};
window.mock={entities:[supplier,order],rows:[{id:'33333333-3333-4333-8333-333333333333',version:1,title:'ORD-001',supplier:'44444444-4444-4444-8444-444444444444',state:'новый',quantity:12,ordered_on:'2026-11-03',created_at:'2026-11-03T10:00:00Z',updated_at:'2026-11-03T10:00:00Z'}],calls:[]};
const PROJECT={id:'00000000-0000-4000-8000-000000000001',name:'ATELIER · Restaurant CRM',type:'crm',industry:'restaurant',modules:['auth','clients','analytics','tasks','payments'],settings:{accent:'#a5bdff',primaryAction:'new_client',currency:'RUB'},createdAt:'2026-11-03T10:00:00Z',updatedAt:'2026-11-03T10:00:00Z',entities:window.mock.entities,pages:[]};
window.history.replaceState=()=>{};
window.fetch=async (url,options={})=>{
 const path=String(url);const method=options.method||'GET';window.mock.calls.push(method+' '+path);
 const body=options.body?JSON.parse(options.body):{};
 const response=(o,status=200)=>new Response(JSON.stringify({ok:true,...o}),{status,headers:{'Content-Type':'application/json'}});
 if(path==='/api/studio/session')return response({initialized:true,authenticated:true,user:{id:'owner',name:'Владелец',email:'owner@test.example',role:'owner'},csrf:'csrf'});
 if(path==='/api/studio/projects'&&method==='GET')return response({projects:[PROJECT]});
 if(path==='/api/studio/projects/'+PROJECT.id&&method==='GET')return response({project:PROJECT});
 if(path.endsWith('/entities')&&method==='GET')return response({entities:window.mock.entities});
 if(path.endsWith('/entities')&&method==='POST'){
  const ent={...body,id:'99999999-9999-4999-8999-999999999999',revision:1};window.mock.entities.push(ent);return response({entity:ent},201);
 }
 if(path.match(/\/entities\/[a-f0-9-]+$/)&&method==='PATCH'){
  const id=path.split('/').pop(),at=window.mock.entities.findIndex(e=>e.id===id);
  window.mock.entities[at]={...window.mock.entities[at],...body,revision:window.mock.entities[at].revision+1};
  return response({entity:window.mock.entities[at]});
 }
 if(path==='/api/config')return response({config:{...PROJECT,requiresSetupToken:false}});
 if(path==='/api/session')return response({initialized:true,authenticated:true,user:{id:'admin',name:'Администратор',role:'admin',email:'admin@test.example'},csrf:'csrf'});
 if(path==='/api/entities'&&method==='GET')return response({entities:window.mock.entities});
 if(path==='/api/pages')return response({pages:[]});
 if(path.startsWith('/api/entities/suppliers/rows')&&method==='GET')return response({entity:supplier,rows:[{id:'44444444-4444-4444-8444-444444444444',company:'ATLANTIC FOODS'}],total:1});
 if(path.startsWith('/api/entities/orders/rows')&&method==='GET')return response({entity:order,rows:window.mock.rows,total:window.mock.rows.length});
 if(path==='/api/entities/orders/rows'&&method==='POST'){
  const row={...body.values,id:'66666666-6666-4666-8666-666666666666',version:1,created_at:'2026-11-03T10:00:00Z'};window.mock.rows.push(row);return response({row},201);
 }
 if(path==='/api/analytics')return response({analytics:{currency:'RUB',totals:{clients:0,repeatShare:0,repeatClients:0,visitedClients:0,paidMinor:0,openTasks:0,overdueTasks:0,visits:0},monthly:[],sourceBreakdown:[],latestTasks:[]}});
 if(path==='/api/users')return response({users:[]});
 return response({error:'Unknown: '+path},404);
};
'''
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server'])
 for width,height in [(1440,900),(390,844)]:
  page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(STUDIO);page.add_style_tag(content=STUDIO_CSS);page.add_script_tag(content=MODEL)
  page.add_script_tag(content='(()=>{'+EDITOR+'\nwindow.initPageEditor=initPageEditor;})();')
  page.add_script_tag(content='(()=>{'+ENTITIES+'\nwindow.initEntityEditor=initEntityEditor;})();')
  page.add_script_tag(content='(()=>{'+TEMPLATES+'\nwindow.initTemplateLibrary=initTemplateLibrary;})();')
  page.add_script_tag(content=STUDIO_APP)
  page.locator('.project-card').first.wait_for(timeout=5000)
  page.locator('.project-card').first.locator('summary').click()
  page.locator('[data-entities]').click();page.locator('#entityEditor').wait_for(state='visible')
  page.locator('.schema-field').first.wait_for()
  assert page.locator('#entityPreviewTitle').inner_text()=='Поставщики'
  page.locator('#entityAddField').click()
  field=page.locator('.schema-field').last
  field.locator('[data-prop=label]').fill('Контактное лицо')
  field.locator('[data-prop=key]').fill('contact_name')
  assert field.locator('[data-prop=key]').input_value()=='contact_name',field.locator('[data-prop=key]').input_value()
  page.locator('#entitySave').click()
  page.wait_for_function('window.mock.entities[0].revision===2')
  assert page.evaluate('window.mock.entities[0].fields.at(-1).key')=='contact_name', page.evaluate('window.mock.entities[0].fields.at(-1)')
  page.evaluate("document.querySelector('#entityEditor').scrollTop=0")
  page.wait_for_timeout(150)
  page.screenshot(path=str(QA/f'entity_studio_{width}.png'),full_page=False)
  assert not errors,errors
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 2'),f'studio overflow {width}'
  page.close()
  page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(CRM);page.add_style_tag(content=CRM_CSS);page.add_script_tag(content=MODEL)
  page.add_script_tag(content=CRM_ENTITIES);page.add_script_tag(content=CRM_PAGES);page.add_script_tag(content=CRM_APP)
  page.locator('#appScreen').wait_for(state='visible')
  page.locator('[data-view="entity:orders"]').click();page.get_by_text('ORD-001').first.wait_for()
  page.locator('[data-entity-create]').click()
  page.locator('[data-entity-form] [name=title]').fill('ORD-002')
  page.locator('[data-entity-form] [name=supplier]').select_option('44444444-4444-4444-8444-444444444444')
  page.locator('[data-entity-form] [name=state]').select_option('новый')
  page.locator('[data-entity-form] [name=quantity]').fill('7')
  page.locator('[data-entity-form] [type=submit]').click()
  page.wait_for_function('window.mock.rows.length===2')
  page.get_by_text('ORD-002').first.wait_for()
  page.screenshot(path=str(QA/f'entity_crm_{width}.png'),full_page=False)
  assert not errors,errors
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 2'),f'crm overflow {width}'
  page.close()
 browser.close()
print('ENTITY STUDIO+CRM MOCK BROWSER SMOKE PASSED at 1440 and 390px')
