"""Visual QA of R0.9 automation pane. Static sample data, not an HTTP E2E."""
from pathlib import Path
from playwright.sync_api import sync_playwright
import re
root=Path(__file__).resolve().parents[1]
html=(root/'public/crm/index.html').read_text(encoding='utf-8')
html=re.sub(r'<script[^>]*>.*?</script>','',html,flags=re.S)
html=re.sub(r'<link[^>]*>','',html)
css=(root/'public/crm/app.css').read_text(encoding='utf-8')
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
 for w,h in [(1440,900),(390,844)]:
  page=browser.new_page(viewport={'width':w,'height':h})
  page.set_content(html)
  page.add_style_tag(content=css)
  page.evaluate('''() => {document.getElementById('appScreen').hidden=false; document.getElementById('view-dashboard').hidden=true;document.getElementById('view-automations').hidden=false;document.getElementById('sideProjectName').textContent='Ресторан Элегант';document.getElementById('breadcrumb').textContent='Автоматизации';document.getElementById('automationList').innerHTML='<div class="automation-item"><div><strong>Первый контакт</strong><p>Новый клиент → Позвонить гостю · Высокий приоритет</p></div><div class="automation-actions"><button class="button outline small">Отключить</button><button class="button outline small">Удалить</button></div></div>';document.getElementById('automationRuns').innerHTML='<div class="automation-item"><div><strong>Первый контакт</strong><p>04.11.2026, 10:30 · Создана задача</p></div></div>';document.querySelectorAll('.view').forEach(x=>{if(x.id!=='view-automations')x.hidden=true});document.querySelector('[data-view="automations"]').classList.add('active');}''')
  assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth+2'),f'Overflow on {w}px'
  page.screenshot(path=str(root/'qa'/f'r09_automations_{w}.png'),full_page=True)
 browser.close()
print('Automation static visual smoke PASS 1440/390')
