"""Static Chromium rendering and interactive checks using mocked API (NOT full real-HTTP browser E2E)."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import base64,re
ROOT=Path(__file__).resolve().parents[1]
QA=ROOT/'qa'; QA.mkdir(exist_ok=True)
html=(ROOT/'public/studio/index.html').read_text()
html=re.sub(r'<link[^>]+href="/assets/studio/app.css"[^>]*>','',html)
html=re.sub(r'<script[^>]+src="/assets/studio/app.js"[^>]*></script>','',html)
css=(ROOT/'public/studio/app.css').read_text()
media={}
for f in (ROOT/'public/studio/media').iterdir():
 if f.suffix in ('.jpg','.png'):
  mime='image/png' if f.suffix=='.png' else 'image/jpeg'
  media[f.name]='data:'+mime+';base64,'+base64.b64encode(f.read_bytes()).decode()
for name,url in media.items():
 css=css.replace('/assets/studio/media/'+name,url)
html=html.replace('/assets/studio/media/profile-avatar.png',media['profile-avatar.png'])
editor=(ROOT/'public/studio/editor.js').read_text().replace('export function initPageEditor','function initPageEditor')
entities=(ROOT/'public/studio/entities.js').read_text().replace('export function initEntityEditor','function initEntityEditor')
TEMPLATES=(ROOT/'public/studio/templates.js').read_text().replace('export function initTemplateLibrary','function initTemplateLibrary')
app=(ROOT/'public/studio/app.js').read_text().replace("import { initPageEditor } from './editor.js';",'const {initPageEditor}=window;').replace("import { initEntityEditor } from './entities.js';",'const {initEntityEditor}=window;')
app=app.replace("import { initTemplateLibrary } from './templates.js';",'const {initTemplateLibrary}=window;')
mock='''
const p1={id:'11111111-2222-4333-8444-555555555555',name:'Ресторан «Элегант»',type:'crm',industry:'restaurant',modules:['auth','clients','analytics','tasks','payments'],settings:{accent:'#98774a',primaryAction:'new_client',currency:'RUB'},createdAt:'2026-11-03T11:00:00.000Z'};
const p2={...p1,id:'22222222-3333-4444-8555-666666666666',type:'site',name:'OSMANX Studio',modules:['auth','cms','leads'],createdAt:'2026-11-02T11:00:00.000Z'};
const p3={...p1,id:'33333333-4444-4555-8666-777777777777',name:'Фитнес-клуб Prime',createdAt:'2026-11-01T11:00:00.000Z'};
window.mock={projects:[p1,p2,p3],created:[],calls:[]};
window.fetch=async(u,o={})=>{
 const path=String(u),method=o.method||'GET',b=o.body?JSON.parse(o.body):{};mock.calls.push({path,method,b});
 const ok=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
 if(path==='/api/studio/session')return ok({initialized:true,authenticated:true,user:{name:'Осман'},csrf:'qa-token'});
 if(path==='/api/studio/projects'&&method==='GET')return ok({projects:mock.projects});
 if(path==='/api/studio/projects'&&method==='POST'){
  const p={...p1,...b,id:'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',createdAt:new Date().toISOString()};
  mock.created.push(p);mock.projects.unshift(p);return ok({project:p},201);
 }
 if(path.startsWith('/api/studio/projects/')&&method==='GET')return ok({project:{...mock.projects[0],pages:[],entities:[]}});
 return ok({error:'unsupported '+method+' '+path},404);
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
 for width,height in [(1672,941),(1440,900),(390,844)]:
  page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
  errs=[];page.on('pageerror',lambda err:errs.append(str(err)))
  page.set_content(html)
  page.add_style_tag(content=css)
  page.add_script_tag(content=mock)
  page.add_script_tag(content='(()=>{'+editor+'\nwindow.initPageEditor=initPageEditor;})();')
  page.add_script_tag(content='(()=>{'+entities+'\nwindow.initEntityEditor=initEntityEditor;})();')
  page.add_script_tag(content='(()=>{'+TEMPLATES+'\nwindow.initTemplateLibrary=initTemplateLibrary;})();')
  page.add_script_tag(content=app)
  page.locator('.project-card').first.wait_for(state='visible',timeout=15000)
  page.evaluate('''(images) => {for(const img of document.querySelectorAll('.project-cover img')){const filename=img.src.split('/').pop();if(images[filename])img.src=images[filename]}}''',media)
  page.locator('.project-cover img').first.evaluate('(img)=>img.decode()')
  page.screenshot(path=str(QA/f'approved_dashboard_{width}.png'),full_page=False)
  if width==1672:
   page.evaluate('state.projects=[];renderProjects()')
   assert page.locator('.starter-card').count()==3
   page.evaluate("""(images) => {for(const img of document.querySelectorAll('.project-cover img')){const filename=img.src.split('/').pop();if(images[filename])img.src=images[filename]}}""",media)
   page.screenshot(path=str(QA/'approved_first_run_1672.png'),full_page=False)
   page.locator('[data-demo-type="site"]').first.click()
   assert page.locator('#overviewView').is_visible()
   assert page.locator('#projectType').input_value()=='site'
   page.locator('#wizardDismiss').click()
   page.evaluate('state.projects=mock.projects;renderProjects()')
  assert page.locator('#heroHeading').is_visible()
  assert page.locator('#crmCount').inner_text()=='2'
  assert page.locator('#siteCount').inner_text()=='1'
  assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 2'),f'Overflow {width}: '+str(page.evaluate('document.documentElement.scrollWidth'))
  # search and reset, list toggle
  page.locator('#globalSearch').fill('OSMANX Studio')
  assert page.locator('.project-card').count()==1
  page.locator('#globalSearch').fill('')
  assert page.locator('.project-card').count()==3
  page.locator('#projectsListView').click()
  assert 'list-layout' in page.locator('#projectsList').get_attribute('class')
  page.locator('#projectsGridView').click()
  # creation via first tile
  page.locator('[data-start-type="crm"]').click()
  assert page.locator('#overviewView').is_visible()
  page.screenshot(path=str(QA/f'approved_builder_{width}.png'),full_page=False)
  assert page.locator('#projectType').input_value()=='crm'
  page.locator('#projectName').fill('Новое кафе')
  page.locator('#builderNext').click()
  assert page.locator('[data-wizard-panel="2"]').is_visible()
  page.locator('#builderNext').click()
  assert page.locator('[data-wizard-panel="3"]').is_visible()
  page.locator('#createProject').click()
  page.wait_for_function('mock.created.length===1')
  page.locator('#overviewView').wait_for(state='hidden',timeout=6000)
  assert page.locator('.project-card').count()==4
  assert page.locator('#projectCount').inner_text()=='4'
  page.locator('.project-card').first.locator('summary').click()
  assert page.locator('.project-card').first.get_by_text('Скачать исходники (ZIP)').is_visible()
  page.locator('.project-card').first.locator('[data-settings]').click()
  assert page.locator('#settingsOverlay').is_visible()
  page.locator('#closeSettings').click()
  if width==1440:
   page.locator('[data-start-type="site"]').click()
   assert page.locator('#projectType').input_value()=='site'
   page.locator('#projectName').fill('Студия дизайна')
   page.locator('#builderNext').click()
   assert page.locator('#siteModuleList').is_visible()
   page.locator('#builderNext').click()
   page.locator('#projectTagline').fill('Дизайн и архитектура')
   page.locator('#createProject').click()
   page.wait_for_function('mock.created.length===2')
   page.locator('#overviewView').wait_for(state='hidden',timeout=6000)
   assert page.evaluate('mock.created[1].type')=='site'
  assert not errs,errs
  print(f'{width}px: premium screen, search, responsive no overflow, list, working CRM builder and rendered projects PASS')
  page.close()
 browser.close()
