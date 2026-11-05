"""Interactive Chromium QA of actual R1.3 Studio editor, using local mocked endpoints.
Server-side integration and standalone ZIP are verified by Node tests separately.
"""
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
MOCK=r'''
window.state={notifications:[],calls:[],project:{id:'11111111-2222-4333-8444-555555555555',type:'crm',name:'OSMANX · Стоматология',industry:'dental',modules:['auth','clients','tasks','analytics','payments'],settings:{accent:'#d4b18b',currency:'RUB',primaryAction:'new_client'},entities:[
 {slug:'patients',title:'Пациенты',fields:[{key:'full_name',label:'ФИО',type:'text',required:true},{key:'phone',label:'Телефон',type:'text',required:true},{key:'consent',label:'Согласие',type:'boolean',required:false}],access:{read:['admin','manager','staff'],write:['admin','manager','staff']}}
]},pages:[{id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',title:'Рабочая панель',slug:'work-panel',description:'Все показатели клиники',published:true,revision:1,blocks:[
 {id:'hero-visual-0001',type:'hero',layout:'wide',eyebrow:'OSMANX · КЛИНИКА',title:'Управление без лишнего кода',subtitle:'Общий экран для команды.'},
 {id:'metric-visual-0001',type:'metric',layout:'half',metric:'clients_total',label:'Клиенты'},
 {id:'table-visual-0001',type:'table',layout:'wide',entity:'custom:patients',title:'Пациенты',columns:['full_name','phone'],limit:10}
]}]};
window.localApi=async function(path,options={}){
 const method=options.method||'GET';state.calls.push({path,method,body:options.body});
 if(path.endsWith('/pages')&&method==='GET')return {pages:state.pages};
 if(path.includes('/pages/')&&method==='PATCH'){
  const idx=state.pages.findIndex(p=>p.id===path.split('/').at(-1));
  const body=options.body;state.pages[idx]={...state.pages[idx],...body,revision:state.pages[idx].revision+1};
  return {page:state.pages[idx]};
 }
 if(path.endsWith('/pages')&&method==='POST'){
  const p={...options.body,id:'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',revision:1};state.pages.push(p);return {page:p};
 }
 throw Error('Unmocked request: '+method+' '+path);
};
'''
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
 for width,height in [(1440,930),(390,844)]:
  page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.set_content(HTML);page.add_style_tag(content=CSS);page.add_script_tag(content=MOCK)
  page.add_script_tag(content='(()=>{'+EDITOR+'\nwindow.initPageEditor=initPageEditor;})();')
  page.evaluate("window.editor=window.initPageEditor({api:window.localApi,toast:(text,isError)=>state.notifications.push({text,isError})})")
  page.evaluate('window.editor.open(state.project)')
  page.locator('#editorCanvas .editor-preview-block').first.wait_for()
  assert page.locator('#editorCanvas .editor-preview-block').count()==3
  if width==1440:
   page.locator('#editorPalette [data-add-block="text"]').drag_to(page.locator('#editorCanvas [data-block-index="1"]'))
  else:
   page.locator('#editorPalette [data-add-block="text"]').click()
  assert page.locator('#editorCanvas .editor-preview-block').count()==4, 'Palette must add a real block'
  page.locator('[data-block-prop="title"]').last.fill('Полезные сведения')
  page.locator('[data-block-prop="layout"]').select_option('half')
  assert page.locator('#editorCanvas .editor-preview-block.selected.ed-span-half').count()==1
  page.locator('#editorUndo').click()
  assert page.locator('#editorCanvas .editor-preview-block.selected.ed-span-wide').count()==1, 'Undo restores previous width'
  page.locator('#editorRedo').click()
  assert page.locator('#editorCanvas .editor-preview-block.selected.ed-span-half').count()==1, 'Redo restores half width'
  page.locator('[data-add-block="metric"]').click()
  page.locator('[data-block-prop="metric"]').select_option('entity_count')
  page.locator('[data-block-prop="entity"]').select_option('custom:patients')
  page.locator('[data-block-prop="layout"]').select_option('third')
  assert page.locator('#editorCanvas .editor-preview-block.selected.ed-span-third').count()==1
  page.locator('#editorSave').click()
  page.wait_for_function('state.pages[0].revision===2')
  blocks=page.evaluate('state.pages[0].blocks')
  assert any(b['type']=='metric' and b.get('metric')=='entity_count' and b.get('layout')=='third' for b in blocks),blocks
  assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+2'),f'Horizontal overflow: {width}'
  assert not errors,errors
  page.screenshot(path=str(QA/f'r13_visual_editor_{width}.png'),full_page=False)
  page.close();print('R1.3 visual editor interactive Chromium passed:',width,flush=True)
 browser.close()
