"""R0.6 premium onboarding acceptance in Chromium with mocked API (not real browser HTTP)."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
QA=ROOT/'qa';QA.mkdir(exist_ok=True)
HTML=(ROOT/'public/studio/index.html').read_text()
HTML=re.sub(r'<link[^>]+href="/assets/studio/app.css"[^>]*>','',HTML)
HTML=re.sub(r'<script[^>]+src="/assets/studio/app.js"[^>]*></script>','',HTML)
CSS=(ROOT/'public/studio/app.css').read_text()
EDITOR=(ROOT/'public/studio/editor.js').read_text().replace('export function initPageEditor','function initPageEditor')
ENTITIES=(ROOT/'public/studio/entities.js').read_text().replace('export function initEntityEditor','function initEntityEditor')
TEMPLATES=(ROOT/'public/studio/templates.js').read_text().replace('export function initTemplateLibrary','function initTemplateLibrary')
APP=(ROOT/'public/studio/app.js').read_text().replace("import { initPageEditor } from './editor.js';","const {initPageEditor}=window;").replace("import { initEntityEditor } from './entities.js';","const {initEntityEditor}=window;")
APP=APP.replace("import { initTemplateLibrary } from './templates.js';",'const {initTemplateLibrary}=window;')
MOCK='''
const project={id:'11111111-2222-4333-8444-555555555555',name:'ATELIER RESTAURANT',type:'crm',industry:'restaurant',modules:['auth','clients','analytics','tasks','payments'],settings:{accent:'#386f61',primaryAction:'new_client',currency:'RUB'},createdAt:'2026-11-01T00:00:00.000Z'};
window.mock={projects:[project],created:[],calls:[]};
window.fetch=async(u,o={})=>{
 const path=String(u),method=o.method||'GET',b=o.body?JSON.parse(o.body):{};mock.calls.push({path,method,b});
 const ok=(j,status=200)=>new Response(JSON.stringify(j),{status,headers:{'Content-Type':'application/json'}});
 if(path==='/api/studio/session')return ok({initialized:true,authenticated:true,user:{name:'Владелец'},csrf:'token'});
 if(path==='/api/studio/projects'&&method==='GET')return ok({projects:mock.projects});
 if(path==='/api/studio/projects'&&method==='POST'){
  const p={...project,...b,id:'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',createdAt:new Date().toISOString()};mock.created.push(p);mock.projects.unshift(p);return ok({project:p},201);
 }
 if(path.startsWith('/api/studio/projects/')&&method==='GET')return ok({project:{...project,pages:[],entities:[]}});
 return ok({error:'Unsupported '+method+' '+path},404);
};
'''
with sync_playwright() as playwright:
 browser=playwright.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 for width,height in [(1440,960),(390,844)]:
  page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
  errors=[];page.on('pageerror',lambda err:errors.append(str(err)))
  page.set_content(HTML)
  page.add_style_tag(content=CSS)
  page.add_script_tag(content=MOCK)
  page.add_script_tag(content='(()=>{'+EDITOR+'\nwindow.initPageEditor=initPageEditor;})();')
  page.add_script_tag(content='(()=>{'+ENTITIES+'\nwindow.initEntityEditor=initEntityEditor;})();')
  page.add_script_tag(content='(()=>{'+TEMPLATES+'\nwindow.initTemplateLibrary=initTemplateLibrary;})();')
  page.add_script_tag(content=APP)
  page.locator('.project-card').first.wait_for()
  assert page.get_by_text('Какой продукт создаём?').is_visible()
  assert page.get_by_text('Функциональные модули').count()==0
  assert page.locator('#builderBack').is_hidden()
  assert page.locator('#createProject').is_hidden()
  page.screenshot(path=str(QA/f'atelier_overview_{width}.png'),full_page=False)
  page.locator('[data-type-choice="site"]').click()
  assert page.locator('#projectType').input_value()=='site'
  assert 'Корпоративный сайт' in page.locator('#blueprintName').inner_text()
  page.locator('#builderNext').click()
  assert page.locator('[data-wizard-panel="2"]').is_visible()
  assert page.locator('#siteModuleList').is_visible()
  page.screenshot(path=str(QA/f'atelier_modules_{width}.png'),full_page=False)
  page.locator('#builderNext').click()
  assert page.locator('[data-wizard-panel="3"]').is_visible()
  page.locator('#projectTagline').fill('Архитектура и дизайн')
  page.locator('#createProject').click()
  page.wait_for_function('mock.created.length===1')
  assert page.evaluate('mock.created[0].type')=='site'
  assert page.evaluate('mock.created[0].settings.tagline')=='Архитектура и дизайн'
  page.get_by_text('Здесь появятся ваши проекты').count()==0
  page.locator('.project-card').first.locator('summary').click()
  assert page.locator('.project-card').first.get_by_text('Скачать исходники (ZIP)').is_visible()
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 2'),f'Horizontal overflow at {width}'
  assert not errors,errors
  page.close()
 browser.close()
print('R0.6 premium studio: 1440/390; type selection, wizard, site creation, project actions and overflow passed (mocked HTTP).')
