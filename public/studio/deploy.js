// Deployment wizard is intentionally preparation-only: never initiates remote deployment.
const T={
 title:'\u041f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f \u043f\u0440\u043e\u0435\u043a\u0442\u0430',
 subtitle:'\u041c\u0430\u0441\u0442\u0435\u0440 \u0434\u043e\u043c\u0435\u043d\u0430 \u0438 \u0441\u0435\u0440\u0432\u0435\u0440\u0430',
 domain:'\u0414\u043e\u043c\u0435\u043d',
 domainHint:'\u0411\u0435\u0437 https://, \u043f\u043e\u0440\u0442\u043e\u0432 \u0438 \u043f\u0443\u0442\u0435\u0439',
 ip:'IP-\u0430\u0434\u0440\u0435\u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u0430',
 ipHint:'\u041d\u0435\u043e\u0431\u044f\u0437\u0430\u0442\u0435\u043b\u044c\u043d\u043e. \u041d\u0443\u0436\u0435\u043d \u0434\u043b\u044f \u0441\u0440\u0430\u0432\u043d\u0435\u043d\u0438\u044f \u0441 DNS',
 check:'\u041f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c DNS',
 checking:'\u041f\u0440\u043e\u0432\u0435\u0440\u044f\u044e DNS...',
 bundle:'\u0421\u043a\u0430\u0447\u0430\u0442\u044c \u043a\u043e\u043c\u043f\u043b\u0435\u043a\u0442',
 bundleHint:'Docker Compose + HTTPS + \u0440\u0435\u0437\u0435\u0440\u0432\u043d\u044b\u0435 \u043a\u043e\u043f\u0438\u0438',
 caution:'\u041f\u0443\u0431\u043b\u0438\u043a\u0430\u0446\u0438\u044f \u043d\u0430 VPS \u0435\u0449\u0451 \u043d\u0435 \u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d\u0430',
 prompt:'\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u0434\u043e\u043c\u0435\u043d \u0438 \u043f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u0435\u0433\u043e',
 ready:'\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d\u0430. \u041c\u043e\u0436\u043d\u043e \u0441\u043a\u0430\u0447\u0430\u0442\u044c \u0430\u0440\u0445\u0438\u0432.',
 dnsWarn:'\u0414\u043e \u0437\u0430\u043f\u0443\u0441\u043a\u0430 \u043d\u0443\u0436\u043d\u043e \u0443\u0441\u0442\u0440\u0430\u043d\u0438\u0442\u044c \u043f\u0440\u0435\u0434\u0443\u043f\u0440\u0435\u0436\u0434\u0435\u043d\u0438\u044f DNS.',
 step1:'01 \u0414\u043e\u043c\u0435\u043d',
 step2:'02 \u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430',
 step3:'03 \u0412\u044b\u043f\u0443\u0441\u043a',
 instruction:'\u041f\u043e\u0441\u043b\u0435 \u0441\u043a\u0430\u0447\u0438\u0432\u0430\u043d\u0438\u044f',
 instructionDetail:'1. \u041f\u0435\u0440\u0435\u043d\u0435\u0441\u0442\u0438 \u043d\u0430 VPS. 2. \u0421\u043e\u0437\u0434\u0430\u0442\u044c .env. 3. \u0417\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u044c Docker Compose.',
 noHttp:'DNS-\u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430 \u043d\u0435 \u0434\u0435\u043b\u0430\u0435\u0442 HTTP-\u0437\u0430\u043f\u0440\u043e\u0441\u043e\u0432.',
 close:'\u0417\u0430\u043a\u0440\u044b\u0442\u044c',
 ok:'\u0413\u043e\u0442\u043e\u0432\u043e',warning:'\u041f\u0440\u0435\u0434\u0443\u043f\u0440\u0435\u0436\u0434\u0435\u043d\u0438\u0435',error:'\u041e\u0448\u0438\u0431\u043a\u0430',
 downloaded:'\u0417\u0430\u043f\u0443\u0449\u0435\u043d\u043e \u0441\u043a\u0430\u0447\u0438\u0432\u0430\u043d\u0438\u0435. \u0421\u0435\u0440\u0432\u0435\u0440 \u0435\u0449\u0451 \u043d\u0435 \u043e\u043f\u0443\u0431\u043b\u0438\u043a\u043e\u0432\u0430\u043d.',
 backupTitle:'\u0420\u0435\u0437\u0435\u0440\u0432\u043d\u044b\u0435 \u043a\u043e\u043f\u0438\u0438 \u0438 HTTPS',
 releaseTitle:'\u0412\u0435\u0440\u0441\u0438\u044f \u043f\u0440\u043e\u0435\u043a\u0442\u0430',
 releaseLatest:'\u0422\u0435\u043a\u0443\u0449\u0430\u044f \u043a\u043e\u043d\u0444\u0438\u0433\u0443\u0440\u0430\u0446\u0438\u044f (\u043d\u043e\u0432\u0430\u044f \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0430)',
 releaseSaved:'\u0421\u043e\u0445\u0440\u0430\u043d\u0451\u043d\u043d\u044b\u0439 \u0432\u044b\u043f\u0443\u0441\u043a',
 releaseHelp:'\u0414\u043b\u044f \u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u044f \u0434\u0435\u0439\u0441\u0442\u0432\u0443\u044e\u0449\u0435\u0439 CRM \u0438\u043b\u0438 \u0441\u0430\u0439\u0442\u0430 \u0432\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d\u043d\u0443\u044e \u0432\u0435\u0440\u0441\u0438\u044e \u0441 \u043d\u043e\u0432\u044b\u043c \u043d\u043e\u043c\u0435\u0440\u043e\u043c.',
 upgradeGuide:'\u041e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u0435 \u0438 \u043e\u0442\u043a\u0430\u0442',
 upgradeDescription:'\u041f\u0435\u0440\u0435\u0434 \u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u0435\u043c \u0441\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u0435 \u0432\u044b\u043f\u0443\u0441\u043a \u0432 \u0440\u0430\u0437\u0434\u0435\u043b\u0435 \xab\u0412\u044b\u043f\u0443\u0441\u043a\u0438\xbb, \u0441\u043a\u0430\u0447\u0430\u0439\u0442\u0435 ZIP \u0441 \u0442\u0435\u043c \u0436\u0435 \u0434\u043e\u043c\u0435\u043d\u043e\u043c \u0438 \u043f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u043d\u0430 \u0441\u0435\u0440\u0432\u0435\u0440\u0435. \u0421\u0438\u0441\u0442\u0435\u043c\u0430 \u043e\u0441\u0442\u0430\u043d\u043e\u0432\u0438\u0442 \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u0435, \u0441\u043e\u0437\u0434\u0430\u0441\u0442 \u043a\u043e\u043f\u0438\u044e \u0438 \u0432\u0435\u0440\u043d\u0451\u0442 \u0441\u0442\u0430\u0440\u0443\u044e \u0432\u0435\u0440\u0441\u0438\u044e \u043f\u0440\u0438 \u043e\u0448\u0438\u0431\u043a\u0435 \u0437\u0430\u043f\u0443\u0441\u043a\u0430.',
 site:'\u0421\u0430\u0439\u0442'
};
const F={
 summary:'R3.6 \u00b7 \u041a\u043e\u043d\u0442\u0440\u043e\u043b\u044c \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043e\u043a',
 detail:'\u0422\u043e\u043b\u044c\u043a\u043e \u043f\u043e\u0434\u043f\u0438\u0441\u0430\u043d\u043d\u044b\u0435 \u043e\u0444\u043b\u0430\u0439\u043d-\u043e\u0442\u0447\u0451\u0442\u044b, \u0431\u0435\u0437 \u0434\u0430\u043d\u043d\u044b\u0445 \u043a\u043b\u0438\u0435\u043d\u0442\u043e\u0432.',
 unknown:'\u041d\u0435\u0442 \u0437\u0430\u0433\u0440\u0443\u0436\u0435\u043d\u043d\u044b\u0445 \u043e\u0442\u0447\u0451\u0442\u043e\u0432',
 ok:'\u041f\u043e\u0434\u043f\u0438\u0441\u044c \u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d\u0430',
 warning:'\u0415\u0441\u0442\u044c \u043f\u0440\u0435\u0434\u0443\u043f\u0440\u0435\u0436\u0434\u0435\u043d\u0438\u044f',
 critical:'\u041d\u0430\u0439\u0434\u0435\u043d\u044b \u043e\u0448\u0438\u0431\u043a\u0438',
 stale:'\u041e\u0442\u0447\u0451\u0442 \u0443\u0441\u0442\u0430\u0440\u0435\u043b',
 key:'\u041f\u0443\u0431\u043b\u0438\u0447\u043d\u044b\u0439 \u043a\u043b\u044e\u0447 (PEM)',
 pin:'\u0417\u0430\u043a\u0440\u0435\u043f\u0438\u0442\u044c \u043a\u043b\u044e\u0447',
 rotate:'\u0417\u0430\u043c\u0435\u043d\u0438\u0442\u044c \u0440\u0430\u043d\u0435\u0435 \u0437\u0430\u043a\u0440\u0435\u043f\u043b\u0451\u043d\u043d\u044b\u0439 \u043a\u043b\u044e\u0447',
 report:'\u041f\u043e\u0434\u043f\u0438\u0441\u0430\u043d\u043d\u044b\u0439 \u043e\u0442\u0447\u0451\u0442 (JSON)',
 import:'\u0418\u043c\u043f\u043e\u0440\u0442\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u043e\u0442\u0447\u0451\u0442',
 imported:'\u041e\u0442\u0447\u0451\u0442 \u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d \u0438 \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d',
 pinned:'\u041a\u043b\u044e\u0447 \u0441\u043e\u0445\u0440\u0430\u043d\u0451\u043d',
 notrust:'\u041a\u043b\u044e\u0447 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0438 \u043d\u0435 \u0437\u0430\u043a\u0440\u0435\u043f\u043b\u0451\u043d',
 loading:'\u0417\u0430\u0433\u0440\u0443\u0436\u0430\u044e \u0441\u0442\u0430\u0442\u0443\u0441...',
 refresh:'\u041e\u0431\u043d\u043e\u0432\u0438\u0442\u044c',
 rollback:'\u041e\u0431\u043d\u0430\u0440\u0443\u0436\u0435\u043d \u043e\u0442\u043a\u0430\u0442 \u0432\u0435\u0440\u0441\u0438\u0438',
 httpsVerified:'HTTPS: \u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d',
 httpsNotChecked:'HTTPS: \u043d\u0435 \u043f\u0440\u043e\u0432\u0435\u0440\u0435\u043d',
 release:'\u0412\u044b\u043f\u0443\u0441\u043a',
 minutes:'\u043c\u0438\u043d \u043d\u0430\u0437\u0430\u0434',
 overview:'\u0412\u0441\u0435 \u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043a\u0438',
 overviewEmpty:'\u041f\u0440\u043e\u0435\u043a\u0442\u043e\u0432 \u043f\u043e\u043a\u0430 \u043d\u0435\u0442',
 overviewHead:'\u041e\u0431\u0437\u043e\u0440 \u043e\u0442\u0447\u0451\u0442\u043e\u0432',
 noReport:'\u043d\u0435\u0442 \u043e\u0442\u0447\u0451\u0442\u0430',
 telemetryHelp:'R3.6: --telemetry reads only local aggregated HTTP status counts (24h). No URLs, customer records or raw logs.',
 telemetryNone:'HTTP: not requested in the signed report',
 telemetryUnavailable:'HTTP: no reliable counters available',
 telemetryWindow:'\u0437\u0430 24 \u0447',
 requestsLabel:'\u0417\u0430\u043f\u0440\u043e\u0441\u044b',
 errorsLabel:'\u041e\u0448\u0438\u0431\u043a\u0438 5xx'
};
const checkTitles={domain:'\u0414\u043e\u043c\u0435\u043d',server:'IP-\u0430\u0434\u0440\u0435\u0441',dns:'DNS', 'dns-private':'DNS-\u0430\u0434\u0440\u0435\u0441\u0430 \u043d\u0435 \u043f\u0443\u0431\u043b\u0438\u0447\u043d\u044b', 'dns-records':'\u0417\u0430\u043f\u0438\u0441\u0438 DNS','server-match':'IP-\u0430\u0434\u0440\u0435\u0441 \u0438 DNS \u0440\u0430\u0437\u043b\u0438\u0447\u0430\u044e\u0442\u0441\u044f'};
const safe = s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function initDeployWizard({api,toast}) {
 const overlay=document.createElement('div');overlay.id='deploymentOverlay';overlay.className='ox-deploy-overlay';overlay.hidden=true;
 overlay.innerHTML=`<section class="ox-deploy-dialog" role="dialog" aria-modal="true" aria-labelledby="deployTitle" tabindex="-1">
   <header class="ox-deploy-head"><div><span class="ox-deploy-eyebrow">OSMANX / OBSIDIAN</span><h2 id="deployTitle">${T.title}</h2><p>${T.subtitle}</p></div><button type="button" class="ox-deploy-close" aria-label="${T.close}" data-close>&times;</button></header>
   <div class="ox-deploy-steps"><span>${T.step1}</span><span>${T.step2}</span><span>${T.step3}</span></div>
   <div class="ox-deploy-body"><p class="ox-deploy-project" id="deployProject"></p>
    <form id="deployForm" class="ox-deploy-form"><div class="ox-deploy-field"><label for="deployDomain">${T.domain}</label><input required id="deployDomain" autocomplete="off" spellcheck="false" placeholder="crm.company.ru" maxlength="253"/><small>${T.domainHint}</small></div>
    <div class="ox-deploy-field"><label for="deployServerIp">${T.ip}</label><input id="deployServerIp" autocomplete="off" spellcheck="false" placeholder="8.8.8.8"/><small>${T.ipHint}</small></div>
    <div class="ox-deploy-field ox-deploy-release"><label for="deployRelease">${T.releaseTitle}</label><select id="deployRelease"><option value="">${T.releaseLatest}</option></select><small>${T.releaseHelp}</small></div>
    <button class="ox-deploy-check" type="submit" id="deployCheck">${T.check}</button></form>
    <div class="ox-deploy-result" id="deployResult" aria-live="polite"><p>${T.prompt}</p></div>
    <div class="ox-deploy-download"><div><span class="ox-deploy-eyebrow">SELF-HOSTED / HTTPS</span><h3>${T.bundle}</h3><p>${T.bundleHint}</p><small>${T.caution}</small></div><button type="button" id="deployDownload" disabled>${T.bundle} <span aria-hidden="true">&darr;</span></button></div>
    <details class="ox-deploy-guide ox-fleet-panel" id="deployFleetPanel">
     <summary>${F.summary}</summary>
     <p>${F.detail} <code>node deploy/fleet-agent.mjs init --confirm</code> &rarr; <code>public</code> &rarr; <code>snapshot --out=/private/status.json</code>. <span>R3.6: <code>--telemetry</code> (HTTP counters, 24h).</span> Проверки <code>--docker</code> и <code>--live</code> запускаются только на VPS по явной команде.</p>
     <div class="ox-fleet-indicator" id="deployFleetStatus" role="status" aria-live="polite">${F.loading}</div>
     <div class="ox-fleet-telemetry" id="deployFleetTelemetry" aria-live="polite">${F.telemetryNone}</div>
     <div class="ox-fleet-row"><button type="button" class="ox-fleet-secondary" id="deployFleetRefresh">${F.refresh}</button><button type="button" class="ox-fleet-secondary" id="deployFleetOverviewButton">${F.overview}</button></div>
     <div class="ox-fleet-overview" id="deployFleetOverview" aria-live="polite" hidden></div>
     <label class="ox-fleet-label" for="deployFleetKey">${F.key}</label>
     <textarea id="deployFleetKey" rows="3" spellcheck="false" autocomplete="off" placeholder="-----BEGIN PUBLIC KEY-----"></textarea>
     <label class="ox-fleet-checkbox"><input type="checkbox" id="deployFleetRotate"/>${F.rotate}</label>
     <button type="button" class="ox-fleet-action" id="deployFleetPin">${F.pin}</button>
     <label class="ox-fleet-label" for="deployFleetReport">${F.report}</label>
     <textarea id="deployFleetReport" rows="4" spellcheck="false" autocomplete="off" placeholder='{"algorithm":"Ed25519",...}'></textarea>
     <button type="button" class="ox-fleet-action" id="deployFleetImport">${F.import}</button>
    </details>
    <details class="ox-deploy-guide"><summary>${T.instruction}</summary><p>${T.instructionDetail}</p><p><code>node deploy/prepare.mjs</code> &rarr; <code>node deploy/preflight.mjs</code> &rarr; <code>docker compose up -d --build</code></p></details>
    <details class="ox-deploy-guide"><summary>${T.backupTitle}</summary>
     <p>1. <code>docker compose stop app</code> &rarr; <code>docker compose --profile maintenance run --rm --no-deps maintenance backup</code></p>
     <p>2. <code>docker compose up -d app</code> &rarr; <code>node deploy/verify-live.mjs --live</code></p>
     <p>Создайте закрытую папку backups на сервере по инструкции из ZIP. Копии содержат персональные данные. При переходе с R2.4 требуется ручной перенос томов.</p>
    </details>
    <details class="ox-deploy-guide"><summary>${T.upgradeGuide}</summary><p>${T.upgradeDescription}</p><p><code>node deploy/upgrade.mjs plan NEW.zip</code> &rarr; <code>node deploy/upgrade.mjs apply NEW.zip --confirm</code></p><p><code>node deploy/upgrade.mjs recover --confirm</code> &mdash; если обновление прервалось.</p></details>
    <details class="ox-deploy-guide"><summary>R3.1 · Восстановление без потери записей</summary>
     <p>Если при открытии шлюза возник сбой, не восстанавливайте старую SQLite-базу: за это время могли появиться новые записи клиентов.</p>
     <p>Проверьте <code>node deploy/upgrade.mjs status</code>. После ручной проверки подписанной новой версии можно выполнить <code>node deploy/upgrade.mjs resume --confirm</code>: она проверит подпись, стабильность приложения и откроет шлюз, не переписывая данные.</p>
     <p>После запуска <code>node deploy/verify-live.mjs --live</code> проверит HTTPS и совпадение типа приложения, UUID проекта и номера выпуска. Это не автоматический публичный деплой.</p>
    </details>
    <details class="ox-deploy-guide"><summary>R3.2 · Безопасный выпуск и проверка восстановления</summary>
     <p>На VPS можно проверить манифесты, подпись издателя, приватность настроек и готовность к выпуску через <code>node deploy/doctor.mjs</code>. Для проверки Docker и публичного HTTPS нужны отдельные явные флаги <code>--docker --live</code>.</p>
     <p>Проверяйте резервную копию восстановлением в отдельное место: <code>maintenance drill BACKUP_ID</code>. Для смены ключа подписи используется закрытый от браузера <code>deploy/trust-policy.mjs</code> на сервере.</p>
     <p>Положительный отчёт не означает, что приложение опубликовано или прошло аудит безопасности.</p>
    </details>
    <details class="ox-deploy-guide"><summary>R3.0 · Подписанный выпуск</summary>
     <p>После скачивания ZIP подпишите его на своём защищённом компьютере через <code>node scripts/release_sign.mjs sign</code>. Не загружайте закрытый ключ в браузер, фабрику, Git или Docker.</p>
     <p>Закрепите публичный ключ на VPS в <code>.osmanx-trust/release-public.pem</code>. После этого обновления без проверенной подписи Ed25519 будут отклоняться до остановки приложения.</p>
     <p>Команды создания ключа, подписи и проверки приведены в <code>docs/RELEASE_R30_PREVIEW.md</code> основной фабрики. Сам экспорт из мастера остаётся неподписанным до офлайн-подписи.</p>
    </details>
    <p class="ox-deploy-privacy">${T.noHttp}</p>
   </div></section>`;
 document.body.appendChild(overlay);
 const el=id=>overlay.querySelector('#'+id);
 let current=null,validated=null,busy=false,generation=0,releaseTicket=0,fleetTicket=0;
 const fleetStatus=el('deployFleetStatus');
 function renderFleet(fleet){
  const message=!fleet?.trusted?F.notrust:!fleet.latest?F.unknown:
   (F[fleet.health]||F.ok)+' / '+F.release+' #'+fleet.latest.releaseSequence+' / '+fleet.ageMinutes+' '+F.minutes+
   ' / '+(fleet.evidence?.httpsVerified?F.httpsVerified:F.httpsNotChecked);
  fleetStatus.textContent=message;
  fleetStatus.dataset.health=fleet?.health||'unknown';
  const m=fleet?.telemetry;
  el('deployFleetTelemetry').textContent=!fleet?.latest?F.telemetryNone:
   m?.status==='observed'?F.requestsLabel+': '+Number(m.requests)+' / '+F.errorsLabel+': '+Number(m.serverErrors)+' ('+F.telemetryWindow+')':
   m?F.telemetryUnavailable:F.telemetryNone;
 }
 async function reloadFleet(){
  const projectId=current?.id,ticket=++fleetTicket;
  if(!projectId)return;
  fleetStatus.textContent=F.loading;
  try{const data=await api('/api/studio/projects/'+encodeURIComponent(projectId)+'/fleet');
   if(current?.id===projectId&&ticket===fleetTicket)renderFleet(data.fleet);
  }catch(error){if(current?.id===projectId&&ticket===fleetTicket)fleetStatus.textContent=error.message;}
 }
 async function fleetWrite(kind){
  const projectId=current?.id;if(!projectId)return;
  const button=el(kind==='trust'?'deployFleetPin':'deployFleetImport');
  if(button.disabled)return;button.disabled=true;
  try{
   const body=kind==='trust'?{publicKeyPem:el('deployFleetKey').value.trim(),rotate:el('deployFleetRotate').checked}:
    {packet:JSON.parse(el('deployFleetReport').value)};
   const path='/api/studio/projects/'+encodeURIComponent(projectId)+'/fleet/'+kind;
   await api(path,{method:'POST',body});
   if(current?.id===projectId){toast(kind==='trust'?F.pinned:F.imported);await reloadFleet();}
  }catch(error){toast(error.message,true)}finally{button.disabled=false}
 }
 el('deployFleetRefresh').addEventListener('click',reloadFleet);
 let portfolioTicket=0;
 el('deployFleetOverviewButton').addEventListener('click',async()=>{
  const target=el('deployFleetOverview');target.hidden=false;target.textContent=F.loading;
  const ticket=++portfolioTicket;
  try{
   const data=await api('/api/studio/fleet');if(ticket!==portfolioTicket||overlay.hidden)return;
   const rows=data.fleet?.rows||[];
   target.innerHTML='<strong>'+safe(F.overviewHead)+' ('+rows.length+')</strong>'+
     (rows.length?rows.map(x=>'<p class="ox-fleet-overview-entry"><strong>'+safe(x.name)+'</strong> / '+
       safe(x.type)+' / '+safe(F[x.health]||F.unknown)+' / '+
       (x.releaseSequence===null?safe(F.noReport):'#'+Number(x.releaseSequence))+
       (x.serverErrors===null?'':' / HTTP 5xx: '+Number(x.serverErrors))+'</p>').join(''):
       '<p>'+safe(F.overviewEmpty)+'</p>');
  }catch(e){if(ticket===portfolioTicket)target.textContent=e.message;}
 });
 el('deployFleetPin').addEventListener('click',()=>fleetWrite('trust'));
 el('deployFleetImport').addEventListener('click',()=>fleetWrite('import'));
 el('deployFleetPanel').addEventListener('toggle',()=>{if(el('deployFleetPanel').open)reloadFleet()});
 function reset(){generation++;validated=null;el('deployDownload').disabled=true;el('deployResult').textContent=T.prompt;}
 function close(){generation++;releaseTicket++;fleetTicket++;portfolioTicket++;overlay.hidden=true;current=null;validated=null;document.body.classList.remove('ox-deploy-open');}
 function open(project){current=project;validated=null;overlay.hidden=false;document.body.classList.add('ox-deploy-open');el('deployProject').textContent=project.name+' / '+(project.type==='site'?T.site:'CRM');el('deployDomain').value='';el('deployServerIp').value='';el('deployFleetKey').value='';el('deployFleetReport').value='';el('deployFleetRotate').checked=false;el('deployRelease').replaceChildren(new Option(T.releaseLatest,''));reset();const ticket=++releaseTicket;reloadFleet();el('deployDomain').focus({preventScroll:true});
  api(`/api/studio/projects/${encodeURIComponent(project.id)}/releases`).then(data=>{
   if(ticket!==releaseTicket||current?.id!==project.id)return;
   const list=Array.isArray(data.releases)?data.releases:[];
   for(const release of list)el('deployRelease').append(new Option(`${T.releaseSaved} #${release.sequence} - ${release.notes||release.createdAt||''}`,release.id));
  }).catch(()=>{});
 }
 el('deployDomain').addEventListener('input',reset);el('deployServerIp').addEventListener('input',reset);el('deployRelease').addEventListener('change',reset);
 el('deployForm').addEventListener('submit',async e=>{
  e.preventDefault();if(!current||busy)return;
  busy=true;el('deployCheck').disabled=true;el('deployCheck').textContent=T.checking;reset();const ticket=generation;
  const params=new URLSearchParams({domain:el('deployDomain').value,serverIp:el('deployServerIp').value,dns:'1'});
  if(el('deployRelease').value)params.set('releaseId',el('deployRelease').value);
  try{
   const id=current.id;
   const data=await api(`/api/studio/projects/${encodeURIComponent(id)}/deployment/preflight?${params}`);
   if(!current||current.id!==id||ticket!==generation)return;
   const d=data.deployment;validated={domain:d.domain,ip:el('deployServerIp').value,releaseId:el('deployRelease').value};
   const severe=d.checks.some(c=>c.status==='error'),warn=d.checks.some(c=>c.status==='warning');
   el('deployResult').innerHTML=`<p class="ox-deploy-status ${severe?'error':warn?'warning':'ok'}">${severe||warn?T.dnsWarn:T.ready}</p>`+d.checks.map(c=>`<div class="ox-deploy-checkrow"><span class="${safe(c.status)}">${c.status==='ok'?'&#10003;':c.status==='error'?'&times;':'!'}</span><div><strong>${safe(checkTitles[c.id]||c.title)}</strong><small>${safe(c.detail)}</small></div></div>`).join('');
   el('deployDownload').disabled=!d.bundleReady;
  }catch(error){el('deployResult').textContent=error.message;toast(error.message,true);}finally{busy=false;el('deployCheck').disabled=false;el('deployCheck').textContent=T.check;}
 });
 el('deployDownload').addEventListener('click',()=>{
  if(!current||!validated)return;
  const params=new URLSearchParams({domain:validated.domain});if(validated.releaseId)params.set('releaseId',validated.releaseId);
  const path=`/api/studio/projects/${encodeURIComponent(current.id)}/deployment/export?`+params;
  const anchor=document.createElement('a');anchor.href=path;anchor.download='';document.body.append(anchor);anchor.click();anchor.remove();toast(T.downloaded);
 });
 overlay.querySelector('[data-close]').addEventListener('click',close);
 overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!overlay.hidden){e.preventDefault();close();}});
 return {open,close};
}
