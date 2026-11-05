"""Chromium desktop and mobile click tests with mocked Studio APIs.
The sandbox blocks Chromium -> localhost. Independent Node HTTP tests verify live server behavior."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import base64,re
ROOT=Path(__file__).resolve().parents[1];QA=ROOT/'qa';QA.mkdir(exist_ok=True)
html=(ROOT/'public/studio/index.html').read_text()
html=re.sub(r'<link[^>]+href="/assets/studio/app.css"[^>]*>','',html)
html=re.sub(r'<script[^>]+src="/assets/studio/app.js"[^>]*></script>','',html)
css=(ROOT/'public/studio/app.css').read_text()
media=ROOT/'public/studio/media'
for f in media.iterdir():
 if f.suffix.lower() not in ('.png','.jpg'):continue
 url='data:image/'+('png' if f.suffix.lower()=='.png' else 'jpeg')+';base64,'+base64.b64encode(f.read_bytes()).decode()
 css=css.replace('/assets/studio/media/'+f.name,url)
 html=html.replace('/assets/studio/media/'+f.name,url)
modules=[('editor','initPageEditor'),('entities','initEntityEditor'),('templates','initTemplateLibrary'),('workflows','initWorkflowStudio'),('workbench','initProjectWorkbench'),('deploy','initDeployWizard')]
files={name:(ROOT/f'public/studio/{name}.js').read_text() for name,_ in modules}
app=(ROOT/'public/studio/app.js').read_text()
for name,func in modules:
 files[name]=files[name].replace('export function '+func,'function '+func)
 app=app.replace(f"import {{ {func} }} from './{name}.js';",f'const {{{func}}}=window;')
assert 'import ' not in app.split('const $=')[0],app.split('const $=')[0]
mock='''
window.osmanxMock={project:{id:'11111111-2222-4333-8444-555555555555',name:'OSMANX Clinic CRM',type:'crm',industry:'dental',modules:['auth','clients','tasks','analytics','payments'],settings:{accent:'#c7ab86',currency:'RUB',primaryAction:'new_client'},createdAt:'2026-11-04T00:00:00Z',pages:[{id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',title:'Home',slug:'home',blocks:[],published:true,revision:1}],entities:[],automationPresets:[]},requests:[]};
window.fetch=async (url,options={})=>{
 const path=String(url);osmanxMock.requests.push(path);
 let payload={ok:true};
 if(path==='/api/studio/session')payload={authenticated:true,initialized:true,user:{name:'Owner'},csrf:'token'};
 else if(path==='/api/studio/projects')payload={projects:[osmanxMock.project]};
 else if(path.endsWith('/workbench'))payload={project:osmanxMock.project,diagnostics:{summary:{exportReady:true,errors:0,warnings:0},checks:[{level:'ok',title:'Config valid',detail:'Checks passed'}]},releases:[]};
 else if(path.startsWith('/api/studio/projects/')&&path.includes('/deployment/preflight?'))payload={deployment:{domain:'crm.acme.co',serverIp:null,bundleReady:true,publishReady:true,dnsChecked:true,records:{A:['8.8.8.8'],AAAA:[]},checks:[{id:'domain',status:'ok',title:'Domain name',detail:'crm.acme.co'},{id:'dns-records',status:'ok',title:'Public DNS',detail:'8.8.8.8'}]}};
 else if(path.startsWith('/api/studio/projects/'))payload={project:osmanxMock.project};
 else payload={error:'Missing mock '+path};
 return new Response(JSON.stringify(payload),{status:payload.error?404:200,headers:{'content-type':'application/json'}});
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
 for width,height in ((1440,900),(390,844)):
  page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1);page.set_default_timeout(12000)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(html);page.add_style_tag(content=css);page.add_script_tag(content=mock)
  for name,func in modules:
   page.add_script_tag(content='(()=>{'+files[name]+f'\nwindow.{func}={func};'+'})();')
  page.add_script_tag(content=app)
  page.locator('[data-project-workbench]').first.wait_for(state='visible')
  page.locator('[data-project-workbench]').first.click()
  page.locator('#workbenchOverlay').wait_for(state='visible')
  page.locator('#oxwTabs [data-oxw-tab="release"]').click()
  page.locator('[data-oxw-action="open-deployment"]').click()
  page.locator('#deploymentOverlay').wait_for(state='visible')
  assert page.locator('#deployDownload').is_disabled()
  page.locator('#deployDomain').fill('crm.acme.co')
  page.locator('#deployCheck').click()
  page.wait_for_function("!document.getElementById('deployDownload').disabled")
  assert page.locator('#deployResult .ox-deploy-checkrow').count()==2
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),f'overflow: {width}'
  page.screenshot(path=str(QA/f'r24_deploy_{width}.png'))
  assert not errors,errors
  page.keyboard.press('Escape')
  page.locator('#deploymentOverlay').wait_for(state='hidden')
  print('R2.4 static Chromium wizard: PASS',width,flush=True)
  page.close()
 browser.close()
