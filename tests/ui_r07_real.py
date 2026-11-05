from playwright.sync_api import sync_playwright
from pathlib import Path
p=Path('/mnt/data/OSMANX_APP_FACTORY_R07/OSMANX_APP_FACTORY_MVP/qa')
p.mkdir(exist_ok=True)
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server'])
 page=browser.new_page(viewport={'width':1672,'height':941})
 try:
  response=page.goto('http://127.0.0.1:4273/',wait_until='domcontentloaded',timeout=12000)
  print('BROWSER RESPONSE:',response.status if response else None)
  page.locator('#authScreen').wait_for(state='visible',timeout=5000)
  print('AUTH:',page.locator('#authTitle').inner_text())
  page.locator('#authName').fill('Тестовый владелец')
  page.locator('#authEmail').fill('admin@osmanx.local')
  page.locator('#authPassword').fill('Osmanx-Test-Password-2026!')
  page.locator('#authSubmit').click()
  page.locator('#dashboardRoot').wait_for(state='visible',timeout=12000)
  print('REAL BROWSER LOGGED IN',page.locator('#heroHeading').inner_text())
  page.screenshot(path=str(p/'r07_dashboard_real_1672.png'),full_page=False)
 except Exception as e:
  print('BROWSER LIMITATION:',str(e)[:600])
  page.screenshot(path=str(p/'r07_error.png'),full_page=False)
 browser.close()
