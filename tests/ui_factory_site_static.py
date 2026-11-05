"""Factory website option and dual-purpose page editor in Chromium with mocked API.
HTTP/SQLite/ZIP test lives in site.test.mjs. This test checks interactive UI only.
"""
from pathlib import Path
import re,json
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
pid='cccccccc-cccc-4ccc-8ccc-cccccccccccc';pageid='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
mock=f"""
const PID='{pid}';
const PAGE_ID='{pageid}';
const page={{id:PAGE_ID,title:'Главная',slug:'home',description:'SEO description',published:true,revision:1,blocks:[
 {{id:'hero-website-0001',type:'hero',eyebrow:'КОМПАНИЯ',title:'Премиальный сайт',subtitle:'Разработано в фабрике'}},
 {{id:'features-site-001',type:'features',title:'Наш подход',items:[{{title:'Преимущество',body:'Описание'}}]}},
 {{id:'button-site-0001',type:'button',label:'Написать нам',href:'/contacts',style:'primary'}}
]}};
const project={{id:PID,name:'OSMANX WEB PRIME',type:'site',industry:'business',modules:['auth','cms','leads'],settings:{{accent:'#d0a976',tagline:'',contactEmail:''}},createdAt:'2026-11-04T00:00:00Z',updatedAt:'2026-11-04T00:00:00Z',pages:[page],entities:[]}};
window.fake={{projects:[],page,calls:[]}};
window.fetch=async(url,options={{}})=>{{
 const path=String(url),method=options.method||'GET',body=options.body?JSON.parse(options.body):{{}};
 fake.calls.push(method+' '+path);
 const reply=(data,status=200)=>new Response(JSON.stringify({{ok:true,...data}}),{{status,headers:{{'Content-Type':'application/json'}}}});
 if(path==='/api/studio/session')return reply({{initialized:true,authenticated:true,user:{{name:'Factory Owner',role:'owner',id:'owner'}},csrf:'CSRF'}});
 if(path==='/api/studio/projects'&&method==='GET')return reply({{projects:fake.projects}});
 if(path==='/api/studio/projects'&&method==='POST'){{if(body.type!=='site')return reply({{error:'Not site'}},400);fake.projects=[project];return reply({{project}},201);}}
 if(path==='/api/studio/projects/'+PID)return reply({{project}});
 if(path==='/api/studio/projects/'+PID+'/pages'&&method==='GET')return reply({{pages:[fake.page]}});
 if(path==='/api/studio/projects/'+PID+'/pages/'+PAGE_ID&&method==='PATCH'){{fake.page={{...body,id:PAGE_ID,revision:2}};return reply({{page:fake.page}});}}
 return reply({{error:'Unsupported '+method+' '+path}},404);
}};
"""
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
    for width,height in [(1440,900),(390,844)]:
        p=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
        errors=[];p.on('pageerror',lambda err:errors.append(str(err)))
        p.set_content(html);p.add_style_tag(content=css);p.add_script_tag(content=mock)
        p.add_script_tag(content='(()=>{'+editor+'\nwindow.initPageEditor=initPageEditor;})();')
        p.add_script_tag(content='(()=>{'+entities+'\nwindow.initEntityEditor=initEntityEditor;})();')
        p.add_script_tag(content='(()=>{'+TEMPLATES+'\nwindow.initTemplateLibrary=initTemplateLibrary;})();')
        p.add_script_tag(content=app)
        p.locator('[data-start-type=site]').click()
        assert p.locator('#projectIndustry').input_value()=='business'
        p.locator('#builderNext').click()
        assert p.locator('#siteModuleList').is_visible()
        assert not p.locator('#crmModuleList').is_visible()
        p.locator('#builderNext').click()
        p.locator('#createProject').click()
        p.locator('.project-card').first.wait_for()
        assert p.evaluate('fake.projects[0].type')=='site'
        p.locator('.project-card').first.locator('summary').click()
        p.locator('[data-editor]').first.click()
        p.locator('#pageEditor').wait_for(state='visible')
        assert p.locator('[data-add-block=features]').count()>=1
        p.locator('[data-add-block=form]').first.click()
        assert p.locator('#editorCanvas .editor-preview-block').count()==4
        p.locator('#editorInspector [data-block-prop=title]').last.fill('Оставьте заявку')
        p.locator('#editorSave').click()
        p.get_by_text('Страница сайта сохранена.').wait_for()
        assert p.locator('#editorStatus').inner_text().startswith('Сохранено')
        assert p.evaluate('document.documentElement.scrollWidth <= innerWidth + 2'),f'Studio overflow at {width}'
        p.screenshot(path=str(qa/f'site_factory_editor_{width}.png'),full_page=False)
        assert not errors,errors
        p.close()
    browser.close()
print('Factory site choice + page editor passed Chromium mock interactions 1440px / 390px')
