"""Rendered website + CMS visual interaction test with in-browser mock HTTP.
Real server/SQLite/ZIP integration is covered separately by tests/site.test.mjs.
Chromium cannot navigate to localhost under this sandbox policy.
"""
from pathlib import Path
import json, subprocess
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
qa=root/'qa';qa.mkdir(exist_ok=True)
sample=root/'examples'/'site-demo-config.json'
model_js="""
import {readFileSync} from 'node:fs';
import {renderWebsite} from './src/site/model.mjs';
const p=JSON.parse(readFileSync(process.argv[1],'utf8'));
console.log(renderWebsite(p.pages.find(x=>x.slug===process.argv[2]),p.pages,p,''));
"""
def render(slug):
    r=subprocess.run(['node','--input-type=module','-e',model_js,str(sample),slug],capture_output=True,text=True,cwd=root,check=True)
    return r.stdout
css=(root/'public/site/site.css').read_text()
site_js=(root/'public/site/site.js').read_text()
admin_html=(root/'public/site/admin.html').read_text()
admin_css=(root/'public/site/admin.css').read_text()
admin_js=(root/'public/site/admin.js').read_text()
project=json.loads(sample.read_text())
mock="""
const pageData=JSON.parse(window.__PAGES_JSON__);
window.calls=[];
window.fetch=async(url,options={})=>{
 const path=String(url),method=options.method||'GET',body=options.body?JSON.parse(options.body):{};
 window.calls.push(method+' '+path);
 const data=(obj,status=200)=>new Response(JSON.stringify({ok:true,...obj}),{status,headers:{'Content-Type':'application/json'}});
 if(path==='/api/site/session')return data({initialized:true,authenticated:true,user:{id:'admin',name:'Test Admin'},csrf:'testcsrf'});
 if(path==='/api/site/overview')return data({overview:{leads:3,newLeads:2,publishedPages:3}});
 if(path==='/api/site/pages'&&method==='GET')return data({pages:pageData});
 if(path==='/api/site/leads'&&method==='GET')return data({leads:[{id:'a',name:'Иван',phone:'+79990000000',email:'client@example.test',message:'Хочу новый сайт',page_slug:'contacts',created_at:'2026-11-04T10:00:00Z',status:'new'}],total:1});
 if(path==='/api/site/settings')return data({settings:{name:'OSMANX ATELIER',settings:{accent:'#d0a976',tagline:'Решения для бизнеса',contactEmail:'hello@example.com'}}});
 if(path.includes('/api/site/pages/')&&method==='PATCH')return data({page:{...body,id:path.split('/').pop(),revision:body.revision+1}});
 if(path==='/api/site/leads'&&method==='POST')return data({message:'Обращение принято'},201);
 if(path.includes('/api/site/leads/')&&method==='PATCH')return data({updated:path.split('/').pop()});
 return data({error:'Unsupported '+method+' '+path},404);
};
""".replace('window.__PAGES_JSON__',json.dumps(json.dumps(project['pages'],ensure_ascii=False)))
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
    for width,height in [(1440,900),(390,844)]:
        p=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
        errors=[];p.on('pageerror',lambda err:errors.append(str(err)))
        p.set_content(render('home'));p.add_style_tag(content=css)
        assert p.locator('.hero h1').inner_text().startswith('Решения')
        assert p.locator('.feature').count()==3
        assert p.evaluate('document.documentElement.scrollWidth <= innerWidth + 2'), 'site overflow '+str(width)
        p.screenshot(path=str(qa/f'site_home_{width}.png'),full_page=True)
        p.set_content(render('contacts'));p.add_style_tag(content=css)
        p.add_script_tag(content="window.fetch=async()=>new Response(JSON.stringify({ok:true}),{status:201,headers:{'Content-Type':'application/json'}})")
        p.add_script_tag(content=site_js)
        p.locator('[name=name]').fill('Test Guest');p.locator('[name=phone]').fill('+79998887766')
        p.locator('[type=submit]').click()
        p.get_by_text('Спасибо! Сообщение успешно отправлено.').wait_for()
        p.screenshot(path=str(qa/f'site_contact_{width}.png'),full_page=True)
        assert not errors,errors
        p.close()
        p=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
        errors=[];p.on('pageerror',lambda err:errors.append(str(err)))
        p.set_content(admin_html);p.add_style_tag(content=admin_css)
        p.add_script_tag(content=mock);p.add_script_tag(content=admin_js)
        p.locator('#dashboard .stat strong').first.wait_for()
        assert p.locator('#statLeads').inner_text()=='3'
        p.locator('[data-tab=pages]').click()
        p.locator('[data-edit-page]').first.wait_for()
        p.locator('[data-edit-page]').first.click()
        p.locator('#pageEditTitle').wait_for()
        assert p.locator('.block-card').count()>0
        p.locator('#pageTitle').fill('Главная — новая')
        p.locator('#savePage').click()
        p.get_by_text('Страница сохранена').wait_for()
        p.screenshot(path=str(qa/f'site_cms_editor_{width}.png'),full_page=True)
        assert p.evaluate('document.documentElement.scrollWidth <= innerWidth + 2'),'admin overflow '+str(width)
        assert not errors,errors
        p.close()
    browser.close()
print('Website and CMS Chromium mock interaction passed 1440px + 390px (not real HTTP browser E2E)')
