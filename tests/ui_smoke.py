"""Optional browser smoke test; requires Python Playwright + Chromium, not needed for app runtime."""
import os, subprocess, tempfile, time, urllib.request, pathlib
from playwright.sync_api import sync_playwright

ROOT=pathlib.Path(__file__).resolve().parents[1]
ARTIFACTS=ROOT/'qa'
ARTIFACTS.mkdir(exist_ok=True)
PORT=4197
base=f'http://127.0.0.1:{PORT}'
with tempfile.TemporaryDirectory(prefix='osmanx-ui-') as data_dir:
    env={**os.environ,'PORT':str(PORT),'HOST':'127.0.0.1','DATA_DIR':data_dir,'NODE_NO_WARNINGS':'1'}
    server=subprocess.Popen(['node','server.mjs'],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        for attempt in range(45):
            try:
                urllib.request.urlopen(base+'/api/health',timeout=1)
                break
            except Exception:
                time.sleep(.15)
        else:
            raise RuntimeError('Server did not start')
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
            context=browser.new_context(viewport={'width':1500,'height':950},device_scale_factor=1)
            page=context.new_page()
            errors=[]
            page.on('pageerror', lambda e:errors.append(str(e)))
            page.goto(base+'/',wait_until='networkidle')
            page.locator('#authName').fill('Owner Demo')
            page.locator('#authEmail').fill('owner@demo.example')
            page.locator('#authPassword').fill('SecurePassword12345!')
            page.locator('#authSubmit').click()
            page.locator('#studioScreen').wait_for(state='visible')
            page.screenshot(path=str(ARTIFACTS/'studio_desktop.png'),full_page=True)
            page.locator('#projectName').fill('ATELIER • Restaurant CRM')
            page.locator('#builderNext').click()
            page.locator('#builderNext').click()
            page.locator('#createProject').click()
            page.locator('.project-card').first.wait_for(state='visible')
            with page.expect_popup() as popup:
                page.locator('.project-card a.open-link').first.click()
            crm=popup.value
            crm.on('pageerror',lambda e:errors.append('CRM '+str(e)))
            crm.locator('#authScreen').wait_for(state='visible')
            crm.locator('#authName').fill('Restaurant Owner')
            crm.locator('#authEmail').fill('admin@restaurant.example')
            crm.locator('#authPassword').fill('SecurePassword12345!')
            crm.locator('#authSubmit').click()
            crm.locator('#appScreen').wait_for(state='visible')
            crm.screenshot(path=str(ARTIFACTS/'crm_dashboard_desktop.png'),full_page=True)
            crm.locator('#mainAction').click()
            crm.locator('#f_full_name').fill('Анна Магомедова')
            crm.locator('#f_phone').fill('+7 999 123-45-67')
            crm.locator('#f_source').select_option('referral')
            crm.locator('#dialogSubmit').click()
            crm.locator('[data-view=clients]').click()
            crm.get_by_text('Анна Магомедова').first.wait_for()
            crm.locator('[data-action=visit]').first.click()
            crm.locator('#dialogSubmit').click()
            crm.locator('[data-action=visit]').first.click()
            crm.locator('#dialogSubmit').click()
            crm.locator('[data-view=payments]').click()
            crm.locator('#addPayment').click()
            crm.locator('#f_amount').fill('2450.50')
            crm.locator('#f_method').select_option('terminal')
            crm.locator('#dialogSubmit').click()
            crm.get_by_text('2 450,50',exact=False).first.wait_for()
            crm.locator('[data-view=analytics]').click()
            crm.get_by_text('100%',exact=False).first.wait_for()
            crm.screenshot(path=str(ARTIFACTS/'crm_analytics_desktop.png'),full_page=True)
            crm.locator('[data-view=dashboard]').click()
            crm.screenshot(path=str(ARTIFACTS/'crm_dashboard_populated.png'),full_page=True)
            mobile_context=browser.new_context(viewport={'width':390,'height':844},device_scale_factor=1,storage_state=context.storage_state())
            mobile=mobile_context.new_page()
            mobile.on('pageerror',lambda e:errors.append('mobile '+str(e)))
            mobile.goto(crm.url,wait_until='networkidle')
            mobile.locator('#appScreen').wait_for(state='visible')
            mobile.screenshot(path=str(ARTIFACTS/'crm_mobile.png'),full_page=True)
            assert mobile.evaluate('document.documentElement.scrollWidth <= window.innerWidth+2'),'mobile horizontal overflow'
            assert not errors, errors
            print('UI SMOKE OK:',', '.join(x.name for x in sorted(ARTIFACTS.glob('*.png'))))
            browser.close()
    finally:
        server.terminate()
        try: server.wait(timeout=4)
        except subprocess.TimeoutExpired: server.kill()
