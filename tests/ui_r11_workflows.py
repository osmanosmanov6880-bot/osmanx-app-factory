"""R1.1 workflow-studio Chromium interaction check using mock API. Not a live-HTTP browser E2E."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import re,base64
ROOT=Path(__file__).resolve().parents[1]
QA=ROOT/'qa';QA.mkdir(exist_ok=True)
html=(ROOT/'public/studio/index.html').read_text()
html=re.sub(r'<link[^>]+href="/assets/studio/app.css"[^>]*>','',html)
html=re.sub(r'<script[^>]+src="/assets/studio/app.js"[^>]*></script>','',html)
css=(ROOT/'public/studio/app.css').read_text()
for file in (ROOT/'public/studio/media').iterdir():
 if file.suffix not in ('.png','.jpg'):continue
 uri='data:'+('image/png' if file.suffix=='.png' else 'image/jpeg')+';base64,'+base64.b64encode(file.read_bytes()).decode()
 css=css.replace('/assets/studio/media/'+file.name,uri)
 html=html.replace('/assets/studio/media/'+file.name,uri)
files={name:(ROOT/f'public/studio/{name}.js').read_text() for name in ['editor','entities','templates','workflows','app']}
for name,fn in [('editor','initPageEditor'),('entities','initEntityEditor'),('templates','initTemplateLibrary'),('workflows','initWorkflowStudio')]:
 files[name]=files[name].replace('export function '+fn,'function '+fn)
 files['app']=files['app'].replace(f"import {{ {fn} }} from './{name}.js';",f'const {{{fn}}}=window;')
 mock=r'''
window.ox={rules:[],events:[],project:{id:'11111111-2222-4333-8444-555555555555',name:'Клиника Премиум',type:'crm',industry:'dental',modules:['auth','clients','tasks','analytics','payments'],settings:{accent:'#c9a473',currency:'RUB',primaryAction:'new_client'},createdAt:'2026-11-04T00:00:00.000Z',pages:[{title:'Обзор',slug:'main',blocks:[],published:true}],entities:[{slug:'patients',title:'Пациенты',fields:[{key:'full_name',label:'Имя',type:'text'}]},{slug:'appointments',title:'Записи',fields:[{key:'doctor',label:'Врач',type:'text'},{key:'status',label:'Статус',type:'select',options:['Запланирована','Подтверждена']},{key:'date',label:'Дата',type:'date'}]}]}};
window.fetch=async(u,o={})=>{const path=String(u),method=o.method||'GET',data=o.body?JSON.parse(o.body):{};ox.events.push({path,method,data});
const ret=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json'}});
if(path==='/api/studio/session')return ret({authenticated:true,initialized:true,user:{name:'Владелец'},csrf:'x'});
if(path==='/api/studio/projects'&&method==='GET')return ret({projects:[(({pages,entities,...rest})=>rest)(ox.project)]});
if(path==='/api/studio/projects/'+ox.project.id&&method==='GET')return ret({project:{...ox.project,automationPresets:ox.rules}});
if(path===`/api/studio/projects/${ox.project.id}/workflows`&&method==='GET')return ret({workflows:ox.rules});
if(path===`/api/studio/projects/${ox.project.id}/workflows`&&method==='POST'){const w={...data,id:'22222222-3333-4444-8555-666666666666',revision:1};ox.rules.push(w);return ret({workflow:w},201);}
if(path.endsWith('/workflow-preview')&&method==='POST')return ret({wouldRun:true,taskTitle:'Подготовить кабинет для Пример',priority:data.rule.priority,dueDays:data.rule.due_days});
return ret({error:'Mock missing: '+path},404);
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 for width,height in [(1440,920),(390,844)]:
  page=browser.new_page(viewport={'width':width,'height':height});page.set_default_timeout(9000)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(html);page.add_style_tag(content=css);page.add_script_tag(content=mock)
  for name,fn in [('editor','initPageEditor'),('entities','initEntityEditor'),('templates','initTemplateLibrary'),('workflows','initWorkflowStudio')]:
   page.add_script_tag(content='(()=>{'+files[name]+f'\nwindow.{fn}={fn}'+'})();')
  page.add_script_tag(content=files['app'])
  page.locator('[data-project-hub]').first.wait_for(state='visible')
  page.locator('[data-project-hub]').first.click()
  page.locator('[data-hub-action="workflows"]').click()
  page.locator('#workflowOverlay').wait_for(state='visible')
  page.locator('#workflowName').fill('Подготовить кабинет')
  page.locator('#workflowEntity').select_option('appointments')
  page.locator('#workflowCondition').select_option('status')
  page.locator('#workflowValue').select_option('Подтверждена')
  page.locator('#workflowTask').fill('Подготовить кабинет для {{doctor}}')
  page.locator('#workflowPriority').select_option('high')
  page.locator('#workflowDays').fill('2')
  page.locator('#workflowSimulate').click()
  page.wait_for_function("document.querySelector('#workflowPreview').textContent.includes('Сработает')")
  page.locator('#workflowSave').click()
  page.wait_for_function('ox.rules.length===1')
  page.locator('.ox-workflow-card').first.wait_for(state='visible')
  assert page.locator('.ox-workflow-card').count()==1
  assert page.evaluate("ox.rules[0].condition_value")=='Подтверждена'
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+2'),f'Document overflow {width}'
  assert page.evaluate("document.querySelector('#workflowOverlay').scrollWidth<=document.querySelector('#workflowOverlay').clientWidth+2"),f'Overlay overflow {width}'
  assert not errors,errors
  page.wait_for_timeout(220)
  page.screenshot(path=str(QA/f'r11_workflows_{width}.png'),full_page=False)
  print('R1.1 UI mock workflow designer OK',width,flush=True)
  page.close()
 browser.close()
