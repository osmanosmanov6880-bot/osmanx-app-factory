"""R1.1 client CSV UI chromium mock-API test. Live HTTP tested in Node."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import re
R=Path(__file__).resolve().parents[1]
qa=R/'qa';qa.mkdir(exist_ok=True)
h=(R/'public/crm/index.html').read_text()
h=re.sub(r'<link[^>]+href="assets/app.css"[^>]*>','',h)
h=re.sub(r'<script[^>]+src="assets/[^\"]+"[^>]*></script>','',h)
css=(R/'public/crm/app.css').read_text()
js=[(R/f'public/crm/{f}.js').read_text() for f in ['entities','pages','app']]
mock='''
window.ox={rows:[],imports:0,calls:[]};
window.fetch=async(u,o={})=>{const path=String(u),method=o.method||'GET',data=o.body?JSON.parse(o.body):{};ox.calls.push({path,method,data});
const respond=(b,status=200)=>new Response(JSON.stringify(b),{status,headers:{'Content-Type':'application/json'}});
if(path==='/api/config')return respond({config:{id:'11111111-2222-4333-8444-555555555555',name:'Ресторан Премиум',modules:['auth','clients'],settings:{accent:'#a98865',primaryAction:'new_client',currency:'RUB'},type:'crm',industry:'restaurant'}});
if(path==='/api/session')return respond({initialized:true,authenticated:true,user:{id:'admin',name:'Администратор',email:'adm@clinic.test',role:'admin'},csrf:'token'});
if(path==='/api/entities')return respond({entities:[]});
if(path==='/api/pages')return respond({pages:[]});
if(path==='/api/clients')return respond({clients:ox.rows,limit:200});
if(path==='/api/clients/import-preview')return respond({summary:{total:1,ready:1,duplicates:0,invalid:0},examples:[{full_name:'Клиент',phone:'+79000000001'}],errors:[]});
if(path==='/api/clients/import') {ox.imports++;ox.rows.push({id:'aaaa-bbb',full_name:'Клиент',phone:'+79000000001',source:'walkin',visit_count:0,created_at:'2026-11-04'});return respond({created:1,duplicates:0,total:1},201);}
if(path==='/api/clients/export')return new Response('\\ufefffull_name,phone,email,source,notes\\r\\n"Клиент","+79000000001",,"walkin",""',{status:200,headers:{'Content-Type':'text/csv'}});
return respond({error:'Not mocked: '+path},404);
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 for width,height in [(1440,920),(390,844)]:
  page=browser.new_page(viewport={'width':width,'height':height},accept_downloads=True);page.set_default_timeout(8000)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('dialog',lambda dialog:dialog.accept())
  page.set_content(h);page.add_style_tag(content=css);page.add_script_tag(content=mock)
  for code in js:page.add_script_tag(content=code)
  page.locator('#appScreen').wait_for(state='visible')
  page.locator('#nav [data-view="clients"]').click()
  page.locator('#clientImport').click()
  page.locator('#clientCsvOverlay').wait_for(state='visible')
  page.locator('#clientCsvFile').set_input_files({'name':'clients.csv','mimeType':'text/csv','buffer':b'full_name,phone,email,source,notes\nClient,+79000000001,,walkin,Test\n'})
  page.wait_for_function("document.querySelector('#clientCsvPreview').textContent.includes('Готово к добавлению: 1')")
  page.screenshot(path=str(qa/f'r11_csv_{width}.png'))
  page.locator('#clientCsvCommit').click()
  page.wait_for_function('ox.imports===1')
  page.locator('#clientCsvOverlay').wait_for(state='hidden')
  assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+2'),f'Horizontal overflow {width}'
  assert not errors,errors
  print('R1.1 UI mock CSV import passed',width,flush=True)
  page.close()
 browser.close()
