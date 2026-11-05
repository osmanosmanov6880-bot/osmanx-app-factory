"""Real factory and browser interaction; DNS response mocked to avoid external network.
Not proof of actual public hosting or live TLS."""
import os, subprocess, tempfile, socket, time, json, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
QA=ROOT/'qa'; QA.mkdir(exist_ok=True)
with socket.socket() as sock:
 sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
origin=f'http://127.0.0.1:{port}'
temp=tempfile.TemporaryDirectory(prefix='osmanx-r24-browser-')
env=os.environ.copy();env.update(PORT=str(port),HOST='127.0.0.1',DATA_DIR=temp.name,NODE_NO_WARNINGS='1')
proc=subprocess.Popen(['node','server.mjs'],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)

def api(path,payload=None,cookie=None,csrf=None):
 headers={}
 if payload is not None:headers['Content-Type']='application/json'
 if cookie:headers['Cookie']=cookie
 if csrf:headers['X-CSRF-Token']=csrf
 req=urllib.request.Request(origin+path,headers=headers,data=None if payload is None else json.dumps(payload).encode(),method='GET' if payload is None else 'POST')
 with urllib.request.urlopen(req,timeout=10) as response:
  return json.loads(response.read()),response.headers
try:
 for _ in range(100):
  try:
   api('/api/health');break
  except Exception:time.sleep(.1)
 else:raise AssertionError('Node server did not start')
 data,headers=api('/api/studio/setup',{'email':'admin-r24@test.example','name':'Owner','password':'R24_secure_testing_password'})
 cookie=headers['Set-Cookie'].split(';')[0]
 created,_=api('/api/studio/projects',{'type':'crm','industry':'restaurant','name':'OSMANX Demo Studio','modules':['auth','clients','tasks','analytics','payments'],'settings':{'accent':'#386f61','primaryAction':'new_client','currency':'RUB'}},cookie=cookie,csrf=data['csrf'])
 project_id=created['project']['id']
 with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
  for width,height in [(1440,900),(390,844)]:
   context=browser.new_context(viewport={'width':width,'height':height})
   context.add_cookies([{'name':'ox_studio','value':cookie.split('=',1)[1],'domain':'127.0.0.1','path':'/'}])
   page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
   def mock_dns(route):
    response={'ok':True,'deployment':{'domain':'crm.acme.co','serverIp':None,'records':{'A':['8.8.8.8'],'AAAA':[]},'checks':[{'id':'domain','status':'ok','title':'Domain name','detail':'crm.acme.co'},{'id':'dns-records','status':'ok','title':'Public DNS records','detail':'8.8.8.8'}],'bundleReady':True,'publishReady':True,'dnsChecked':True}}
    route.fulfill(status=200,content_type='application/json',body=json.dumps(response))
   page.route('**/deployment/preflight?*',mock_dns)
   page.goto(origin,wait_until='domcontentloaded',timeout=15000)
   page.locator(f'[data-project-workbench="{project_id}"]').wait_for(state='visible')
   page.locator(f'[data-project-workbench="{project_id}"]').click()
   page.locator('#workbenchOverlay').wait_for(state='visible')
   page.locator('#oxwTabs [data-oxw-tab="release"]').click()
   page.locator('[data-oxw-action="open-deployment"]').click()
   page.locator('#deploymentOverlay').wait_for(state='visible')
   page.locator('#deployDownload').is_disabled()
   page.locator('#deployDomain').fill('crm.acme.co')
   page.locator('#deployCheck').click()
   page.locator('#deployDownload').wait_for(state='enabled')
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),f'horizontal overflow at {width}'
   assert page.locator('#deployResult .ox-deploy-checkrow').count()==2
   page.screenshot(path=str(QA/f'r24_deploy_{width}.png'),full_page=False)
   assert not errors,errors
   print('R2.4 Chromium wizard LIVE app + mocked DNS: PASS',width,flush=True)
   context.close()
  browser.close()
finally:
 proc.terminate()
 try:proc.wait(timeout=8)
 except subprocess.TimeoutExpired:proc.kill()
 temp.cleanup()
