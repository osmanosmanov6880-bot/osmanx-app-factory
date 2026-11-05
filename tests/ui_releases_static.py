"""Chromium interface smoke with mocked HTTP; real HTTP is covered by Node tests."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
qa=root/'qa';qa.mkdir(exist_ok=True)
html=(root/'public/studio/index.html').read_text()
html=re.sub(r'<link[^>]+href="/assets/studio/app.css"[^>]*>','',html)
html=re.sub(r'<script[^>]+src="/assets/studio/app.js"[^>]*></script>','',html)
css=(root/'public/studio/app.css').read_text()
editor=(root/'public/studio/editor.js').read_text().replace('export function initPageEditor','function initPageEditor')
entities=(root/'public/studio/entities.js').read_text().replace('export function initEntityEditor','function initEntityEditor')
TEMPLATES=(root/'public/studio/templates.js').read_text().replace('export function initTemplateLibrary','function initTemplateLibrary')
app=(root/'public/studio/app.js').read_text().replace("import { initPageEditor } from './editor.js';",'').replace("import { initEntityEditor } from './entities.js';",'')
app=app.replace("import { initTemplateLibrary } from './templates.js';",'const {initTemplateLibrary}=window;')
mock='''
const PID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const project={id:PID,name:'OSMANX RESTO PRIME',type:'crm',industry:'restaurant',modules:['auth','clients','analytics','tasks','payments'],settings:{accent:'#91aaff',primaryAction:'new_client',currency:'RUB'},createdAt:'2026-11-03T11:00:00Z',updatedAt:'2026-11-03T11:00:00Z',entities:[],pages:[]};
window.mock={releases:[],calls:[]};
window.fetch=async(url,options={})=>{
 const path=String(url),method=options.method||'GET';window.mock.calls.push(method+' '+path);
 const body=options.body?JSON.parse(options.body):{};
 const reply=(data,status=200)=>new Response(JSON.stringify({ok:true,...data}),{status,headers:{'Content-Type':'application/json'}});
 if(path==='/api/studio/session')return reply({initialized:true,authenticated:true,user:{name:'Demo Owner',role:'owner',id:'admin',email:'owner@example.com'},csrf:'fake'});
 if(path==='/api/studio/projects')return reply({projects:[project]});
 if(path.endsWith('/releases')&&method==='GET')return reply({releases:window.mock.releases});
 if(path.endsWith('/releases')&&method==='POST'){
  const release={id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',sequence:1,notes:body.notes,createdAt:'2026-11-04T09:00:00Z',snapshotSha256:'abcde1234567890123456789'};
  window.mock.releases.unshift(release);return reply({release},201);
 }
 return reply({error:'unsupported '+path},404);
};
'''
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server'])
    for width,height in [(1440,900),(390,844)]:
        page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
        errors=[];page.on('pageerror',lambda err:errors.append(str(err)))
        page.set_content(html);page.add_style_tag(content=css);page.add_script_tag(content=mock)
        page.add_script_tag(content='(()=>{'+editor+'\nwindow.initPageEditor=initPageEditor;})();')
        page.add_script_tag(content='(()=>{'+entities+'\nwindow.initEntityEditor=initEntityEditor;})();')
        page.add_script_tag(content='(()=>{'+TEMPLATES+'\nwindow.initTemplateLibrary=initTemplateLibrary;})();')
        page.add_script_tag(content=app)
        page.locator('.project-card').first.wait_for()
        page.locator('.project-card').first.locator('summary').click()
        page.locator('[data-releases]').first.click()
        page.locator('#releasesOverlay').wait_for(state='visible')
        assert page.locator('#releaseHeading').inner_text().startswith('\u0420\u0435\u043b\u0438\u0437\u044b')
        page.locator('#releaseNotes').fill('Schema and roles v1')
        page.locator('#releaseCreate').click()
        page.get_by_text('Schema and roles v1').first.wait_for()
        assert page.locator('.release-item').count()==1
        assert page.locator('.release-item a').first.get_attribute('href').endswith('/export')
        page.screenshot(path=str(qa/f'releases_{width}.png'),full_page=False)
        assert not errors,errors
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 2'),f'overflow {width}'
        page.close()
    browser.close()
print('RELEASE MANAGER UI MOCK PASSED 1440px and 390px')
