"""R0.8 interactive Chromium checks with mocked API. No real HTTP/browser E2E claim."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import base64,re
ROOT=Path(__file__).resolve().parents[1]
QA=ROOT/'qa';QA.mkdir(exist_ok=True)
html=(ROOT/'public/studio/index.html').read_text()
html=re.sub(r'<link[^>]+href="/assets/studio/app.css"[^>]*>','',html)
html=re.sub(r'<script[^>]+src="/assets/studio/app.js"[^>]*></script>','',html)
css=(ROOT/'public/studio/app.css').read_text()
media={}
for file in (ROOT/'public/studio/media').iterdir():
 if file.suffix in ('.png','.jpg'):
  mime='image/png' if file.suffix=='.png' else 'image/jpeg'
  media[file.name]='data:'+mime+';base64,'+base64.b64encode(file.read_bytes()).decode()
for filename,url in media.items():css=css.replace('/assets/studio/media/'+filename,url)
html=html.replace('/assets/studio/media/profile-avatar.png',media['profile-avatar.png'])
editor=(ROOT/'public/studio/editor.js').read_text().replace('export function initPageEditor','function initPageEditor')
entities=(ROOT/'public/studio/entities.js').read_text().replace('export function initEntityEditor','function initEntityEditor')
templates=(ROOT/'public/studio/templates.js').read_text().replace('export function initTemplateLibrary','function initTemplateLibrary')
app=(ROOT/'public/studio/app.js').read_text()
for file,symbol in [('editor.js','initPageEditor'),('entities.js','initEntityEditor'),('templates.js','initTemplateLibrary')]:
 app=app.replace(f"import {{ {symbol} }} from './{file}';",f'const {{{symbol}}}=window;')
mock='''
const seed={id:'11111111-2222-4333-8444-555555555555',name:'Ресторан «Элегант»',type:'crm',industry:'restaurant',modules:['auth','clients','analytics','tasks','payments'],settings:{accent:'#ad9774',primaryAction:'new_client',currency:'RUB'},createdAt:'2026-11-04T00:00:00.000Z'};
window.mock={projects:[seed],templates:[],calls:[],count:0};
window.fetch=async(url,opts={})=>{
 const path=String(url),method=opts.method||'GET',body=opts.body?JSON.parse(opts.body):{};
 mock.calls.push({path,method,body});
 const ok=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
 if(path==='/api/studio/session')return ok({authenticated:true,initialized:true,user:{name:'Осман'},csrf:'csrf-token'});
 if(path==='/api/studio/projects'&&method==='GET')return ok({projects:mock.projects});
 if(path==='/api/studio/templates'&&method==='GET')return ok({templates:mock.templates});
 if(path==='/api/studio/templates'&&method==='POST'){
   const template={id:'22222222-3333-4444-8555-666666666666',name:body.name,description:body.description,type:'crm',createdAt:new Date().toISOString()};
   mock.templates.unshift(template);return ok({template},201);
 }
 if(path.includes('/api/studio/templates/')&&path.endsWith('/projects')&&method==='POST'){
   const next={...seed,id:'33333333-4444-4555-8666-777777777777',name:body.name,createdAt:new Date().toISOString()};
   mock.projects.unshift(next);return ok({project:next},201);
 }
 if(path.includes('/api/studio/projects/')&&path.endsWith('/clone')&&method==='POST'){
   const next={...seed,id:'44444444-5555-4666-8777-888888888888',name:body.name,createdAt:new Date().toISOString()};
   mock.projects.unshift(next);return ok({project:next},201);
 }
 if(path.includes('/api/studio/projects/')&&path.endsWith('/diagnostics')&&method==='GET')return ok({summary:{exportReady:true,errors:0,warnings:1},checks:[{key:'configuration',level:'ok',title:'Config valid',detail:'All good'},{key:'payments',level:'warning',title:'Manual ledger',detail:'Not acquiring'}]});
 return ok({error:'unsupported '+path+' '+method},404);
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
 for width,height in [(1672,941),(390,844)]:
  page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(html);page.add_style_tag(content=css);page.add_script_tag(content=mock)
  for src,symbol in [(editor,'initPageEditor'),(entities,'initEntityEditor'),(templates,'initTemplateLibrary')]:
   page.add_script_tag(content='(()=>{'+src+f'\nwindow.{symbol}={symbol};'+'})();')
  page.add_script_tag(content=app)
  page.locator('.project-card').first.wait_for(state='visible')
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),f'Dashboard overflow {width}'
  page.locator('#navBlueprint').click();assert page.locator('#templatesOverlay').is_visible()
  page.get_by_text('Здесь будет ваша библиотека').wait_for(state='visible',timeout=7000)
  page.locator('#templatesClose').click()
  page.locator('.project-card').first.locator('summary').click()
  page.locator('[data-template-save]').first.click()
  assert page.locator('#templateSaveForm').is_visible()
  page.locator('#templateSaveName').fill('Золотой шаблон ресторана')
  page.locator('#templateSaveSubmit').click()
  page.locator('.ox-template-card').first.wait_for(state='visible')
  assert page.locator('.ox-template-card').count()==1
  assert page.locator('#templatesCount').inner_text()=='1 шаблон'
  page.screenshot(path=str(QA/f'r08_templates_{width}.png'),full_page=False)
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),f'Template modal overflow {width}'
  page.locator('[data-template-name]').first.fill('Вторая точка')
  page.locator('[data-template-create]').first.click()
  page.wait_for_function('mock.projects.length===2')
  page.locator('#templatesOverlay').wait_for(state='hidden',timeout=7000)
  page.locator('.project-card').first.locator('summary').click()
  page.locator('[data-project-clone]').first.click()
  assert page.locator('#projectCopyOverlay').is_visible()
  page.locator('#copyName').fill('Третья точка')
  page.locator('#copySubmit').click()
  page.wait_for_function('mock.projects.length===3')
  page.locator('.project-card').first.locator('summary').click()
  page.locator('[data-project-check]').first.click()
  page.locator('.ox-diagnostic').first.wait_for(state='visible')
  assert page.locator('.ox-diagnostic').count()==2
  assert 'Экспорт доступен' in page.locator('#diagnosticsSummary').inner_text()
  page.screenshot(path=str(QA/f'r08_diagnostics_{width}.png'),full_page=False)
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),f'Diagnostics overflow {width}'
  assert not errors,errors
  print(f'{width}px: project templates, create from template, duplicate, diagnostics, responsive PASS')
  page.close()
 browser.close()
