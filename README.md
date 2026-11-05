# OSMANX APP FACTORY R3.7 Preview — безопасные релизы и Docker-приёмка

> **Объединённая Preview-сборка:** R3.7 + независимый набор PostgreSQL Signed Transition Kit R13. Сервер, CRM и сайты по-прежнему работают на SQLite. PostgreSQL не включён в runtime. Настоящий PostgreSQL E2E и production-переход не проверены. См. [`docs/BRANCH_CONSOLIDATION_R37_PG_R13.md`](docs/BRANCH_CONSOLIDATION_R37_PG_R13.md).


Продолжение локальной инженерной ветки R1.3 → R3.7. Четыре крупных блока: блокировка обновления с защитой от повторного использования PID на Linux; проверка всех публичных DNS A/AAAA и HTTPS с привязкой к идентификатору выпуска; обезличенный операторский отчёт об инциденте; синтетический Docker E2E с HTTP-нагрузкой и проверкой SQLite после SIGTERM/SIGKILL. Дизайн OBSIDIAN сохранён. 138/138 автоматических тестов Node.js пройдены. Docker и публичный HTTPS на VPS в текущей среде **не выполнялись**.

Новые команды: `node deploy/edge-audit.mjs --dns-only`, `node deploy/edge-audit.mjs --live`, `node deploy/incident-evidence.mjs --out=/private/report.json`, `npm run test:r37`, `npm run docker:e2e:r37` (только Linux с Docker), `npm run acceptance:r37`.

Подробная техническая документация: [RELEASE_R37_PREVIEW.md](docs/RELEASE_R37_PREVIEW.md).

---

# OSMANX APP FACTORY R3.6 Preview — container restart safety and signed diagnostics

This local engineering continuation adds 4 code blocks: Linux PID/start-time lock ownership across Docker restarts; private, bounded runtime HTTP status counters for standalone CRM/sites; opt-in, Ed25519-signed Fleet v3 telemetry in OBSIDIAN (legacy v1/v2 reports still accepted); and a synthetic-only Docker restart/SQLite persistence CI scenario. All prior modules are retained. No public VPS/Docker execution is claimed. R3.6 Preview still originates from R1.3, not the unavailable original R2.3. See `docs/RELEASE_R36_PREVIEW.md` for operations, tests and limits.

Run `node server.mjs` then open `http://127.0.0.1:4173`. For regression: `npm run check && npm test && npm run test:r36`. The standalone Fleet agent optionally includes private aggregates with `snapshot --out=/private/status.json --telemetry`. No automatic external data transfer occurs.

---

# OSMANX APP FACTORY R3.5 - isolated release acceptance and verified fleet evidence

Local development preview on the R1.3 source base with cumulative R2.4-R3.5 changes. The approved OBSIDIAN UI is preserved.

Four implemented blocks: bounded isolated Node regression, explicit signed v2 HTTPS/Docker reports (backward-compatible offline v1), owner-only fleet portfolio with rollback detection, and fail-closed Docker cleanup plus GitHub Actions acceptance definitions. No customer rows or private signing keys are exported to the factory.

Start: `node server.mjs` (Node 22.16+). Tests: `npm run check && npm test && npm run test:isolated`. Details and verified limitations: [docs/RELEASE_R35_PREVIEW.md](docs/RELEASE_R35_PREVIEW.md). No public VPS deployment or completed remote Docker CI is claimed. The original R2.3 branch is still not merged.

---

# OSMANX APP FACTORY R3.3 — устойчивая публикация (engineering preview)

Инженерное развитие R3.2 на базе R1.3. Дизайн OBSIDIAN сохранён. Четыре крупных изменения: запросы CRM/сайта корректно завершаются до закрытия SQLite; операторский журнал обновления валидируется и записывается на диск; после реального SIGKILL восстанавливается устаревшая блокировка; доступны тесты параллельных HTTP-запросов и аварийного возврата к прошлой версии с настоящим SQLite.

- Локальная проверка: `npm run check && npm test`.
- Нагрузочный синтетический тест: `npm run load:r33`.
- Четыре сценария реального SIGKILL и восстановления: `npm run crash:r33`.
- Подписанный выпуск + восстановление + нагрузка + прерывания: `npm run acceptance:r33 -- --out=/private/r33-report.json`.
- Независимые клиентские примеры: `npm run samples:r33 -- /tmp/r33_samples`, затем `npm run verify:samples:r33 -- /tmp/r33_samples`.

**Не подтверждены:** реальный Docker/VPS, публичный HTTPS и интеграция оригинального R2.3. Не используйте автоматическое восстановление для неизвестного состояния клиентской базы или после неопределённого открытия публичного шлюза. Подробно: [docs/RELEASE_R33_PREVIEW.md](docs/RELEASE_R33_PREVIEW.md).

---

# R3.2 Engineering Preview — четыре крупных блока

Продолжение ранее проверенного R3.1 Preview: **много-ключевая ротация Ed25519**, **репетиция восстановления SQLite без изменения рабочей базы**, **машинный отчёт готовности публикации**, **автоматизированная offline/Docker-приёмка**. Тёмный OBSIDIAN сохранён.

Запуск фабрики: `node server.mjs` → http://127.0.0.1:4173 (Node.js 22.16+). Проверки: `npm run check`, `npm test`, `npm run acceptance:r32`, `python3 tests/ui_r32_deploy_static.py`. Полный отчёт: [`docs/RELEASE_R32_PREVIEW.md`](docs/RELEASE_R32_PREVIEW.md).

**Границы утверждений:** локальный инженерный релиз на кодовой линии R1.3; исходники альтернативной R2.3 не объединены. Docker-цикл на GitHub Actions и публичный VPS ещё не подтверждены. При смене ключей не переписывайте `.osmanx-trust` из ZIP и не распространяйте закрытый ключ.

---

# OSMANX APP FACTORY — R3.1 Preview: safe forward resume and HTTPS identity

R3.1 extends the **R1.3-based engineering preview** R3.0. OBSIDIAN is unchanged. A failed/uncertain gateway activation previously forced manual intervention. Administrators can now **explicitly keep the verified signed new version**, retaining client writes, instead of risking restoration of an old database snapshot. The system never silently rolls back SQLite after possible gateway exposure.

On the VPS, after investigating the `manual-review-required` incident:

```bash
node deploy/upgrade.mjs status
node deploy/upgrade.mjs resume --confirm
node deploy/verify-live.mjs --live
```

`resume` requires the externally pinned Ed25519 release public key, a matching signed installed release, local Docker health checks, and explicit consent. It does **not** recover a broken/unsigned release by force. `verify-live --live` checks TLS plus the **service, project UUID and release sequence** returned from the real app; a wrong application returning HTTP 200 is rejected. The server health endpoint carries no customer records.

Local automated tests include a real localhost TLS handshake and standalone CRM/site HTTP boot. **Actual Docker Engine and publicly trusted HTTPS were not available in the local engineering environment.** A GitHub Actions workflow at `.github/workflows/r31-release-acceptance.yml` is included for real Docker CI, but must be run and its evidence reviewed separately. This is not a certified production SaaS release, and the missing original R2.3 source has not been integrated.

See [the full R3.1 engineering report](docs/RELEASE_R31_PREVIEW.md).

---

# OSMANX APP FACTORY R3.0 PREVIEW — проверка подписей Ed25519

**Реальный код, инженерная ветка от R1.3.** В R3.0 добавлены офлайн-подпись клиентского ZIP, закрепление публичного ключа на VPS и блокировка неподписанных/чужих обновлений до остановки приложения. Подпись не делает код безопасным сама по себе. Интерфейс OBSIDIAN не переработан; в мастер добавлена инструкция, ключи никогда не загружаются в браузер. `package.json` остаётся `1.3.0`, так как оригинальный архив R2.3 не найден. Публичного деплоя не выполнялось.

**Запуск:** `node server.mjs` → http://127.0.0.1:4173 (Node.js 22.16+). **Тесты:** `npm run check && npm test`.

**Подпись:** `node scripts/release_sign.mjs keygen --private=/secure/private.pem --public=/secure/public.pem`, затем `node scripts/release_sign.mjs sign input.zip --private=/secure/private.pem --out=signed.zip` и `node scripts/release_sign.mjs verify signed.zip --public=/secure/public.pem`. Не храните private.pem в проекте.

**Инструкции и ограничения:** [docs/RELEASE_R30_PREVIEW.md](docs/RELEASE_R30_PREVIEW.md). Реальный Docker-test подготовлен для CI, но в локальной среде Docker недоступен: `npm run docker:e2e:r30` — выполняйте только в изолированной среде с Docker.

---

# OSMANX APP FACTORY R2.9 Preview — контролируемый выпуск

**Обновление:** после запуска новой версии CRM/сайта Docker-адаптер останавливает внешний шлюз Caddy, выполняет три последовательные проверки здоровья и перезапусков и вновь включает шлюз только после успеха. Неустойчивый сервис вызывает откат к прежнему коду и резервной копии SQLite. Для администратора доступны `node deploy/rollout-observe.mjs observe` и `history`, локальные отчёты исключены из Git и Docker-сборки. Полная инструкция: [`docs/RELEASE_R29_PREVIEW.md`](docs/RELEASE_R29_PREVIEW.md).

**Проверено локально:** 69 Node.js тестов, 6 автономных приложений с HTTP 200 и OBSIDIAN в Chromium (тестовый API). **Не проверено:** настоящий Docker в данной среде, публичный HTTPS, промышленная эксплуатация. **Внимание:** это R1.3-based Preview с функциями R2.4–R2.9, оригинальный исходный архив R2.3 не был найден; `package.json` остаётся `1.3.0`.

---

# OSMANX APP FACTORY R2.8 — Offline Migration Verification Preview

**This is a real, locally tested engineering improvement over the R2.7 Preview derived from R1.3.** It is NOT the original R2.3 repository or a production-ready SaaS. The approved dark OBSIDIAN UI has not been changed.

The R2.8 migration tool can resume an interrupted backup **only** with explicit `--retry-backups`, retaining partial snapshots rather than silently deleting them. Its new `verify` command confirms the old source volume, sealed host backup and new target volume match, including checksums, file metadata and SQLite integrity. Journal validation now rejects forged volume names and path traversal before destructive recovery. Writes to the migration journal and copied backup files are flushed to disk where supported; this improves durability but cannot guarantee survival of every hardware failure.

For a previously migrated kit, on the **stopped Linux Docker host**:

```bash
node deploy/volume-migrate.mjs status
node deploy/volume-migrate.mjs verify
```

For a partial backup, **only after investigation**:

```bash
node deploy/volume-migrate.mjs recover --confirm --recreate-targets --retry-backups
node deploy/volume-migrate.mjs verify
```

The Factory includes an opt-in, isolated Docker Engine integration runner that creates fresh Docker volumes and synthetic SQLite data, tests migration and an injected recovery, and cleans up only its owned volumes. On an equipped Linux host: `docker pull node:22-bookworm-slim && npm run docker:e2e`. In this development environment Docker Engine and the Docker socket are unavailable, so **real Docker execution remains unverified here**. Read `docs/RELEASE_R28_PREVIEW.md` for required safety conditions and evidence limits.

---

# OSMANX APP FACTORY — R2.7 Preview / Защита миграции томов

**Кодовая база:** R1.3 + инженерные дополнения R2.4–R2.7. Оригинальный архив R2.3 по-прежнему недоступен; это не релиз официальной линии R2.3. Дизайн OBSIDIAN не изменён.

R2.7 добавляет мастер миграции старых Docker Compose volumes (формат R2.4/v1 → v2): только при совпадении проекта, домена, движка и подтверждённых меток Docker. Миграция требует остановить оба стека, сохраняет отдельный снимок данных, сравнивает содержимое по SHA-256, проверяет SQLite и переносит данные в тома со стабильным именем. Есть журнал, статус и восстановление после прерывания. Никаких внешних запросов в процессе копирования.

**Важно:** этот этап не разворачивает приложение на VPS и не доказывает публичный HTTPS: Docker в этой тестовой среде недоступен. Docker-адаптер проверяется контрактными тестами и имитацией томов, а запуск автономных CRM/сайта — реальными Node.js HTTP-тестами. Перед коммерческой эксплуатацией обязательно выполните реальную репетицию с архивом данных заказчика на отдельном VPS.

См. [`docs/RELEASE_R27_PREVIEW.md`](docs/RELEASE_R27_PREVIEW.md), `deploy/DEPLOY.md` каждого клиентского комплекта и `deploy/volume-migrate.mjs`.

---

# OSMANX APP FACTORY R2.6 Preview - controlled client upgrades

**Engineering build:** R1.3 baseline with R2.4-R2.6 backported deployment features. The original R2.3 source archive is not available. This is NOT a verified integrated R2.6 release based on that archive. OBSIDIAN remains the approved design; `package.json` is deliberately still version 1.3.0.

New: versioned deployment-kit exports from persisted project releases, plan/apply/rollback/recover on the target VPS, offline SQLite safety backup, checksummed code snapshot, host Docker Compose health-gate, and preserved private `.env` and backup volumes. Upgrades are downtime-based and only support additive-compatible changes. See [R2.6 technical guide](docs/RELEASE_R26_PREVIEW.md).

Validated locally with Node.js tests and static Chromium mocked-API UI. No real Docker engine, cloud deployment or public TLS test is available in this environment. **Do not put this preview into production without independent deployment, backup/restore and security validation.**

---

# OSMANX APP FACTORY — R2.5 Preview / Безопасная публикация

Инженерное дополнение к R2.4 Preview: постоянное имя Docker Compose по UUID проекта, отдельный сервис резервного копирования/восстановления SQLite, проверка SHA-256 и открытой HTTPS-доступности по явной команде. Дизайн OBSIDIAN сохранён. **40/40 Node.js тестов пройдены.**

**Важно:** исходники R2.3 не найдены — это продолжение сохранённой базы **R1.3** с дополнениями R2.4/R2.5, а не гарантированно совместимый релиз исходного проекта R2.3. Публичная публикация НЕ выполнялась. Старые deployment ZIP R2.4 нельзя заменять без ручной миграции томов Docker.

Полный порядок установки, бэкапа, восстановления, ограничения и тесты: [RELEASE_R25_PREVIEW.md](docs/RELEASE_R25_PREVIEW.md).

---

# R2.4: мастер публикации (инженерная версия на базе R1.3)

Добавлен работающий мастер домена и DNS, подготовка Docker Compose + Caddy/HTTPS, генерация первичного секрета и проверка целостности архива. Дизайн OBSIDIAN сохранён. Это подготовка файлов для VPS, а не фактическая публикация.

Проверки: 34/34 Node.js и адаптивный Chromium с имитацией API. Сам исходный архив R2.3 здесь недоступен, поэтому совместимость с ним ещё не подтверждена. Полный отчёт: docs/RELEASE_R24_PREVIEW.md.

---
# OSMANX APP FACTORY R1.3 — ВИЗУАЛЬНАЯ СБОРКА ПРИЛОЖЕНИЙ

**Статус:** функциональный локальный MVP; не публичный SaaS. **Дизайн:** OBSIDIAN (тёмный графит / тёплое золото), русскоязычный интерфейс. **Стек:** Node.js >=22.16, встроенная SQLite, без npm-зависимостей.

## Запуск

Из папки `OSMANX_APP_FACTORY_MVP` выполните `node server.mjs` и откройте `http://127.0.0.1:4173`. На Windows можно запустить `START_OSMANX_WINDOWS.cmd` (не тестировался непосредственно на Windows).

## Что нового в R1.3

1. **Реальная сетка.** Перетащите элемент из левой библиотеки в нужный блок или в конец страницы. Можно переставлять уже добавленные блоки. Через настройки выберите ширину: 100%, 50%, 33% (для крупных блоков доступно 100% или 50%). На телефонах всё выстраивается вертикально.
2. **Отмена / повтор.** Кнопки ↶ ↷ и сочетания Ctrl+Z / Ctrl+Y, когда фокус не находится в текстовом поле. История ограничена 35 шагами и не сохраняется после закрытия редактора. Обязательно сохраните страницу перед выходом.
3. **Привязка данных.** Показатель «Количество записей из таблицы» получает актуальное значение из защищённого API готовой CRM. Администратор может выбрать пользовательскую сущность. Таблица поддерживает 5, 10 или 20 отображаемых записей. Форма показывает настраиваемое уведомление после успешного сохранения.
4. **Единый результат.** Ширина и привязки сохраняются в серверной конфигурации, приватном шаблоне, релизе и самостоятельном ZIP. Та же сетка работает в CRM и корпоративном сайте.
5. **Первые шаблоны.** Для стоматологии, автосервиса, салона красоты и магазина одежды предусмотрен счётчик записей отраслевой таблицы. Для сайта — пара колонок с редактируемым содержимым.

## Как собрать новую страницу

Откройте **Проекты → Мастерская → Страницы → Изменить**. Перетащите блок из библиотеки на холст, выберите его и настройте справа ширину и данные. Нажмите **Сохранить**. Для проверки нажмите **Открыть CRM** или **Открыть сайт**. Затем в мастерской перейдите в **Выпуск** и экспортируйте ZIP. В автономной CRM данные создаются отдельно и не копируются из фабрики.

## Проверка

- `npm run check` — синтаксическая проверка Node и браузерных JS.
- `npm test` — 31 серверный и интеграционный тест, включая создание проекта, SQLite, валидацию, ZIP и независимый запуск.
- `python3 tests/ui_r13_grid.py` — drag-and-drop, отмена/повтор, изменение ширины и привязки данных в Chromium с моделируемыми API (1440 и 390 px).
- `python3 tests/ui_r13_runtime.py` — CRM и сайт с адаптивной сеткой на двух ширинах; данные CRM моделируются, бизнес-API отдельно проверены тестами Node.
- `node scripts/verify_package.mjs путь/к/экспорту.zip` — локальная проверка контрольных сумм.

Подробности и ограничения: [`docs/RELEASE_R13.md`](docs/RELEASE_R13.md). Полный browser-to-real-HTTP E2E и production-аудит безопасности ещё не проведены.

---

## Предыдущий выпуск R1.2 (сохраняется для истории)


**Локальная работающая платформа** для создания автономных CRM и корпоративных сайтов. Язык интерфейса — русский, дизайн — утверждённая тёмная OBSIDIAN. Разработка ведётся на основе R1.1, прежние функции не удалены. Для запуска нужен **Node.js 22.16 или новее**; `npm install` не требуется.

## Как пользоваться

1. Распакуйте архив, в папке `OSMANX_APP_FACTORY_MVP` выполните `node server.mjs` или на Windows запустите `START_OSMANX_WINDOWS.cmd`.
2. Откройте `http://127.0.0.1:4173`; создайте администратора и выберите **CRM-система** (пять отраслей) либо **Корпоративный сайт**.
3. В меню проекта нажмите **Мастерская**. Слева появятся шесть разделов: **Главное, Страницы, Данные, Кнопки, Сценарии, Выпуск**. Для сайта показываются только применимые разделы.
4. Во вкладке **Кнопки** выберите действие и откройте редактор именно этой кнопки. Настройте переход на свою страницу, уведомление, подтверждение или права видимости для ролей.
5. Во вкладке **Выпуск** проверьте проект. Если опубликованная страница ссылается на удалённую или неопубликованную страницу, экспорт будет заблокирован до исправления. После успешной проверки скачайте автономный ZIP.
6. Распакуйте клиентский ZIP, выполните `node run.mjs`; CRM по умолчанию открывается по `http://127.0.0.1:4180`, сайт — по `http://127.0.0.1:4181`.

## Большие изменения R1.2

- **Единая мастерская:** один рабочий экран для структуры страниц, пользовательских таблиц, действий кнопок, сценариев и диагностики. Быстрая публикация страниц, включение/выключение сценариев, точечный переход в редактирование блока.
- **Новые действия кнопок:** переход на опубликованную страницу CRM, показ уведомления, необязательное подтверждение перед действием. У каждого действия можно указать видимые роли (администратор, управляющий, сотрудник). Права на операцию проверяются на сервере CRM отдельно; скрытие элемента не является авторизацией.
- **Безопасность структуры:** строгий allowlist действий вместо произвольного JavaScript/SQL/API; проверка внутренних ссылок; запрет выдачи ZIP при конфигурационной ошибке; обычные старые страницы проходят нормализацию по новой схеме.
- **Оформление:** мастерская и редактор страниц согласованы с тёмным OBSIDIAN; проверены экран компьютера 1440 px и телефона 390 px.
- **Шесть автономных примеров:** 5 отраслевых CRM с готовым сценарием и действиями кнопок плюс корпоративный сайт; чистые базы создаются отдельно при первом запуске.

## Проверка

- `npm run check && npm test` — **28/28 тестов Node.js**, включая реальные запросы HTTP, SQLite, права владельца, проверки ссылок, независимый ZIP.
- `python3 tests/ui_r12_workbench.py` — Chromium на 1440/390 px; проверены открытие мастерской, вкладки, переключение публикации, переход к настройке кнопки. **API в этом UI-тесте моделируются**. Полный браузерный E2E к живому локальному HTTP не подтверждён из-за ограничений Chromium в тестовой среде.
- 6 отдельных ZIP извлечены и проверены запуском собственных серверов с ответом `200 OK`; проверены манифесты и отсутствие рабочих данных.

**Ограничения прежнего выпуска:** R1.2 — локальный MVP, не публичная промышленная SaaS-платформа. Нет облачного деплоя, готового эквайринга/реального возврата платежей, отправки SMS и e-mail, свободного pixel-perfect drag-and-drop, генератора нативных приложений или автоматического распространения сценариев в уже работающие экземпляры. Для медицинских или финансовых персональных данных необходимы отдельные юридические, инфраструктурные и безопасностные проверки.

Подробный отчёт — [RELEASE_R12.md](docs/RELEASE_R12.md); ограничения — [PROJECT_STATUS.md](docs/PROJECT_STATUS.md).

---

# OSMANX APP FACTORY R1.1 — СЦЕНАРИИ, CSV И БЕЗОПАСНЫЙ ЭКСПОРТ

**Функциональный локальный конструктор** CRM для пяти сфер бизнеса и корпоративных сайтов. Интерфейс — русский, стиль OBSIDIAN, исходники без обязательных npm-зависимостей. **Требуется Node.js 22.16+.**

### Запуск

1. Распакуйте проект, откройте папку `OSMANX_APP_FACTORY_MVP`.
2. Запустите `node server.mjs` (Windows: двойной щелчок `START_OSMANX_WINDOWS.cmd`).
3. Перейдите на `http://127.0.0.1:4173`, создайте администратора и CRM/сайт.
4. В **Мастерской проекта → Сценарии для шаблона** настраивайте повторно используемые правила. Внутри CRM на странице **Клиенты** можно загрузить CSV с предпросмотром.
5. Сохраните проект как шаблон либо экспортируйте автономный ZIP. Извлеките его и запустите `node run.mjs` без фабрики.

### Основные новшества R1.1

- **Бизнес-сценарии в шаблонах:** событие → условие → задача, предпросмотр без побочных эффектов, перенос в копии/шаблоны/релизы/ZIP и установка в новую CRM без клиентских данных.
- **Перенос контактов:** CSV импорт с подсчётом ошибок, исключением дубликатов и подтверждением. Экспорт с защитой от Excel-формул. Поддержка кириллицы.
- **Проверка исходных ZIP:** `node scripts/verify_package.mjs /путь/к/архиву.zip` — сверка SHA-256 и обязательных файлов, проверка на runtime-файлы.
- **Демонстрационные CRM пяти отраслей:** по одному работающему сценарию в новых независимых примерах.

### Контроль качества

`npm run check && npm test` — **26/26 Node.js тестов успешно**. Chromium-проверки интерфейсов выполняются отдельно с моделируемыми API на 1440/390px; полноценный браузерный E2E с живым сервером не подтверждён.

**Ограничения:** это локальный MVP, не публичный SaaS. Настоящие платежи, отправка SMS/email, нативные мобильные приложения, облачная публикация и automatic update существующих бизнес-правил не реализованы. Медицинские/финансовые данные без отдельного юридического и безопасностного аудита не обрабатывайте.

Подробности: [RELEASE_R11.md](docs/RELEASE_R11.md), [PROJECT_STATUS.md](docs/PROJECT_STATUS.md).

---

# OSMANX APP FACTORY R1.0 — ПЯТЬ ОТРАСЛЕЙ И ЕДИНАЯ МАСТЕРСКАЯ

**Реально работающий локальный конструктор CRM и корпоративных сайтов** с темным интерфейсом OBSIDIAN, русскими подписями и независимым ZIP-экспортом.

## Начать за три шага

1. Установите **Node.js 22.16+**. В папке `OSMANX_APP_FACTORY_MVP` выполните `node server.mjs` или на Windows откройте `START_OSMANX_WINDOWS.cmd`.
2. Откройте **http://127.0.0.1:4173**. Создайте администратора фабрики и проект типа **CRM**, выбрав сферу: ресторан, стоматология, автосервис, салон красоты или магазин одежды. Корпоративный сайт по-прежнему доступен отдельным типом продукта.
3. Откройте **Мастерскую** проекта, настройте страницы и таблицы. В CRM откройте **Автоматизации** для цепочки «новая запись → проверка значения поля → задача». Из меню проекта можно экспортировать **самостоятельный ZIP**.

Все таблицы и начальные страницы этих пяти отраслей создаются в базе фабрики; новые CRM из ZIP запускаются с **чистой локальной базой данных**. Для standalone CRM: `node run.mjs`, затем **http://127.0.0.1:4180**. Отдельные отраслевые ZIP можно собрать командой `node scripts/build_industry_sample.mjs dental /полный/путь/dental.zip` (вместо dental: restaurant, auto, beauty, retail).

## Четыре полноценных этапа выпуска

- **Отраслевые пакеты:** связанная схема, формы и опубликованная главная страница для пяти направлений. Для стоматологии — только контактные сведения и расписание; медицинские карты, диагнозы и клинические данные не предусмотрены.
- **Автоматизации R1.0:** правила без программирования: создание клиента, визит или запись в пользовательской таблице; для новых записей возможно точное условие по полю, срок задачи, переменные `{{doctor}}` в названии. Журнал срабатываний, отключение и серверные права администратора/менеджера.
- **Единая мастерская:** открывает страницы, сущности, команду, автоматизации, диагностику, версии, экспорт; не скрывает действующие функции предыдущих релизов.
- **Доставка и контроль:** миграции таблиц старых версий, перенос независимых настроек через шаблоны, ZIP без записей клиентов, прогон 21/21 Node-теста, Chromium UI с моделируемыми API на 1440/390 px. Поставка не требует `npm install`.

**Ограничения:** R1.0 — локальный MVP, не SaaS production. Нет облачной публикации/управления доменами, провайдера реальных платежей, нативных Android/iOS-приложений, полноценной визуальной сетки и универсального workflow canvas. Автоматизации пока создают только задачи в CRM, не отправляют SMS/почту, не работают по расписанию. Рабочие правила хранятся в базе CRM, а не копируются в шаблон нового проекта. Медицинское/персональное использование требует отдельной юридической, приватностной и безопасностной подготовки.

**Проверка:** `npm run check && npm test`; `python3 tests/ui_r10_new.py` (требует Playwright/Chromium) — UI с моделируемыми ответами. Настоящие HTTP/SQLite/ZIP сценарии покрыты Node-тестами отдельно; браузерный HTTP E2E из этого окружения не подтверждён из-за ограничения доступа к localhost.

Подробнее: [RELEASE_R10.md](docs/RELEASE_R10.md), [PROJECT_STATUS.md](docs/PROJECT_STATUS.md).

---

# OSMANX APP FACTORY R0.9 — ШАБЛОНЫ И ПОВТОРНОЕ ИСПОЛЬЗОВАНИЕ

**Работающая локальная фабрика CRM и сайтов.** В R0.9 добавлены личные
многоразовые шаблоны, независимые копии проектов, перенос конфигурации JSON
и проверка проекта перед экспортом. Тёмный дизайн OBSIDIAN R0.7 сохранён.

## Простой запуск

**Windows:** распакуйте ZIP, откройте папку `OSMANX_APP_FACTORY_MVP` и запустите
`START_OSMANX_WINDOWS.cmd` двойным щелчком. Нужен Node.js 22.16+.

**В терминале:** `node server.mjs`, затем `http://127.0.0.1:4173`.

Ничего устанавливать через npm не требуется. Для проверки исходников:
`npm run check && npm test`.

## Как больше не создавать каждую CRM с нуля

1. Создайте CRM или сайт, настройте страницы, модули и сущности.
2. Откройте меню `...` в карточке проекта -> **Сохранить как шаблон**.
3. Нажмите **Шаблоны** в левом меню, выберите шаблон, введите имя нового клиента
   и нажмите **Создать проект**.
4. Система создаст независимый проект с теми же функциями, схемой и страницами,
   но без паролей, клиентских записей и платежей.
5. Настройте внешний вид и нажмите **Скачать исходники (ZIP)**.

Также есть **Создать копию** без сохранения шаблона, **Проверить проект**,
поиск по библиотеке, **Экспорт JSON / Импорт JSON**.

Подробности: [TEMPLATES_R08.md](docs/TEMPLATES_R08.md).

**Ограничения:** пока имеются два типа продукта — Restaurant CRM и корпоративный
сайт. Другие отрасли и нативные приложения не генерируются. Эквайринг
не подключён. Публичной облачной публикации нет. Это MVP, не готовая
международная SaaS-платформа.

---

# OSMANX APP FACTORY R0.7 — OBSIDIAN

**Approved design implemented in working code, not an image.** The Russian-language Studio home screen now follows the dark graphite/gold dashboard reference shared by the owner. Old R0.6 source and functionality remain in this repository.

## Quick start (Windows/macOS/Linux)

1. Install **Node.js 22.16+**.
2. From the `OSMANX_APP_FACTORY_MVP` directory execute `node server.mjs`.
3. Open `http://127.0.0.1:4173` and create the first administrator. The factory initializes its own SQLite database.
4. Select **CRM-система** or **Сайт**, complete the three-step builder, open the resulting project or export its standalone ZIP from the project menu.

No `npm install` is needed. To run automated regression tests: `npm run check && npm test`.

The dashboard contains three **clearly labeled starter templates** if you have no saved projects; these are examples, not imported customer records. "Мобильное приложение" and full visual automation remain future features. The local screenshot avatar and `OSMANX Pro` label are visual reference placeholders, not an installed payment system.

## Visual QA

- `qa/approved_dashboard_1672.png` — 1672×941 screenshot of the coded dashboard using simulated projects
- `qa/approved_first_run_1672.png` — first-run screen with zero real projects
- `qa/approved_dashboard_1440.png` and `qa/approved_dashboard_390.png` — responsive checks
- `qa/approved_builder_1672.png` — real editable three-step wizard UI using simulated API replies
- `docs/DESIGN_R07_OBSIDIAN.md` — fidelity notes, implementation, tests and limits

**Verification boundary:** all 13 Node.js tests pass; Chromium mock-API interaction checks pass at desktop, laptop and mobile sizes. Chromium was blocked from connecting to a real localhost HTTP server by environment policy, so a complete browser E2E cannot be claimed here.

---

# R0.6 / ATELIER — новое оформление и пошаговое создание

**Первый запуск:** `node server.mjs` → http://127.0.0.1:4173 (Node.js 22.16+).

Конструктор полностью переработан на русском языке: выбор типа приложения крупными карточками, шаги «Основа → Возможности → Оформление», крупные поля, понятная навигация и управление проектами без перегрузки. Код API, модели SQLite, CRM, CMS и экспорт остались рабочими. Технические детали: [DESIGN_R06.md](docs/DESIGN_R06.md).

---

# OSMANX APP FACTORY · R0.5 — CRM + Website Factory

**Новый релиз R0.5:** в фабрике есть **два типа проекта** — Restaurant CRM и **Корпоративный сайт**. Сайт генерируется из трёх страниц с настоящим HTML, CMS, сохранением обращений в SQLite, SEO, резервированием и автономным ZIP. На все основные действия существуют работающие API. R0.4 CRM и управление версиями сохранены.

## Что нового в R0.5 — корпоративные сайты

1. Запустите `node server.mjs`, откройте http://127.0.0.1:4173, войдите владельцем.
2. В поле **Тип приложения** выберите **Корпоративный сайт**, задайте имя, оставьте модули `auth`, `cms`, `leads` и нажмите **Создать сайт**.
3. В проекте доступны **Открыть сайт**, **Редактор страниц**, **Панель CMS**, **Релизы**, **Экспорт ZIP**.
4. В редакторе собирайте страницы из блоков `hero`, `text`, `features`, `button`, `form`, `divider`. Сохраните и опубликуйте.
5. Первого администратора сайта создайте через CMS, оставаясь авторизованным владельцем Studio; для standalone-сайта откройте `/admin` локально.
6. Для автономного сайта скачайте ZIP, распакуйте и запустите `node run.mjs` → http://127.0.0.1:4181; CMS: http://127.0.0.1:4181/admin.

Новый пример: `node scripts/build_site_sample.mjs ./demo-company.zip`. Офлайн-бэкап **сайта** при остановленном сервере: `node ops.mjs backup`, `node ops.mjs verify BACKUP_ID`, `node ops.mjs restore BACKUP_ID --confirm`.

**Публичная публикация пока не выполнена** и не является частью этого локального MVP. Настройка домена, TLS/HTTPS, пароль и безопасный `SETUP_TOKEN`, корпоративная антиспам-защита, законная обработка контактов и внешние зашифрованные бэкапы требуют отдельной работы. Сайт без `PUBLIC_SITE_URL=https://...` намеренно запрещает поисковую индексацию. В CMS нет медиа-загрузки. Для сайтов пока нет безопасного автообновления исходников; CRM R0.4 поддерживает только совместимые ручные обновления.

Подробная техническая инструкция — [WEBSITE_FACTORY.md](docs/WEBSITE_FACTORY.md). Проверки — [PROJECT_STATUS.md](docs/PROJECT_STATUS.md).

---

## Сохранённые возможности R0.4 — CRM и релизы

**Рабочая локальная фабрика CRM и сайтов** со структурированным редактором страниц **и универсальным конструктором данных**. Всё работает без `npm install`: Node.js 22.16+ (встроенная `node:sqlite`), JavaScript, HTML/CSS, SQLite. Интерфейсы на русском. Это **функциональный инженерный MVP, а не готовая мировая облачная платформа**.

## R0.4: immutable releases and safe maintenance

A new **Releases** action in each project creates immutable v1/v2/v3 snapshots of the configured CRM (including pages and Data Studio schemas). Download the ZIP for a published release rather than a draft when deploying a real client. The new exported CRM includes `ops.mjs`, a checksummed `manifest.json`, offline **plan**, **backup**, **update**, **verify**, **restore**, and **recover** commands. Database records are not bundled in exports.

```bash
# Inside an exported CRM, with its server stopped:
node ops.mjs plan /path/to/next-release.zip
node ops.mjs backup
node ops.mjs update /path/to/next-release.zip --confirm
node ops.mjs verify BACKUP_ID
node ops.mjs restore BACKUP_ID --confirm
```

For the factory itself, stop `node server.mjs` and use `node scripts/factory_maintenance.mjs backup`. Restoration and detailed prerequisites: [Releases & Backups](docs/RELEASES_AND_BACKUPS.md). Engine upgrades and destructive migrations are intentionally unsupported. Do not use these tools as a substitute for managed production backups or security review.

## Быстрый запуск

```bash
node --version     # 22.16.0 или новее
node server.mjs
```

Откройте **http://127.0.0.1:4173**. Создайте владельца фабрики (пароль 12–128 символов), затем CRM-проект типа «Ресторан» с модулями `auth`, `clients`, `analytics`, `tasks`, `payments`.

На карточке проекта доступны **три действия**:

1. **База данных** — новая мастерская Data Studio для пользовательских таблиц и полей.
2. **Редактор страниц** — сборка страниц из блоков, добавление форм и таблиц на пользовательские данные.
3. **Открыть CRM** / **Экспорт ZIP** — живые данные и полностью независимая сборка исходников.

## Конструктор базы данных: пример за 5 минут

1. В карточке проекта нажмите **База данных** → **+**.
2. Создайте таблицу `suppliers` («Поставщики») с полями `company` (text, обязательно), `phone` (text), `active` (boolean, обязательно). Нажмите **Сохранить схему**.
3. Создайте `orders` («Заказы») с полями `title` (text, обязательно), `supplier` (reference → `suppliers`, обязательно), `state` (select: «Новый», «В работе», «Закрыт», обязательно), `quantity` (integer). Сохраните.
4. Откройте CRM, создайте первого администратора. В меню появились **Поставщики** и **Заказы**. Добавьте поставщика, затем свяжите его с заказом.
5. В редакторе страниц создайте страницу `purchases`. Добавьте **Форма** с источником `orders` и **Таблица** с источником `orders`. Укажите все обязательные поля формы, опубликуйте.
6. Обновите CRM: опубликованная страница и новый реестр доступны сотрудникам согласно ролям.
7. Нажмите **Экспорт ZIP** в фабрике, распакуйте и запустите `node run.mjs` из экспортированной папки. Откройте http://127.0.0.1:4180. Создайте нового администратора — собственные таблицы и страницы присутствуют, но **клиентские записи из исходной CRM отсутствуют**.

### Поля и правила

| Тип | Пример | Хранение в SQLite |
|---|---|---|
| `text` | Название | TEXT (до 240 знаков) |
| `longtext` | Комментарий | TEXT (до 4000 знаков) |
| `integer` | Количество; сумма **в копейках** | INTEGER, безопасное целое |
| `number` | Коэффициент | REAL, **не для денег** |
| `boolean` | Активен | INTEGER 0/1 |
| `date` | Дата заказа | TEXT, формат `YYYY-MM-DD` |
| `select` | Статус | TEXT, только разрешённые значения |
| `reference` | Поставщик заказа | TEXT UUID + SQLite FOREIGN KEY |

Ограничения релиза: максимум **12** пользовательских сущностей на проект и **24** поля на сущность. После создания нельзя менять код сущности, удалять существующие поля, изменять их тип/обязательность или цель связи. Допускается **добавить необязательное поле**, переименовать его подпись и **дополнять** значения списков. Схема мигрирует в рабочую SQLite-базу автоматически. Архивирование записей не удаляет их физически.

### Разрешения

`admin` всегда имеет доступ. Настройте просмотр для `staff` и запись для `manager` / `staff`. Эти роли применяются сервером к каждому запросу; отсутствие кнопки в интерфейсе не заменяет авторизацию. Все формы отправляют JSON с CSRF-токеном. Встроенные модули оплаты и аналитики имеют собственные ограничения.

## API пользовательских данных

Список схем: `GET /api/entities` (после входа в CRM).

| Метод | URL | Назначение |
|---|---|---|
| GET | `/api/entities/:slug/rows?limit=25&offset=0&q=...` | Список, поиск и пагинация |
| POST | `/api/entities/:slug/rows` | Создать запись с `values` |
| GET | `/api/entities/:slug/rows/:uuid` | Прочитать запись |
| PATCH | `/api/entities/:slug/rows/:uuid` | Изменить запись с `version` |
| DELETE | `/api/entities/:slug/rows/:uuid` | Поместить запись в архив с `version` |

Пример тела POST для `orders`:

```json
{"values":{"title":"Закупка № 17","supplier":"UUID существующего поставщика","state":"Новый","quantity":7}}
```

Все методы изменения требуют входа, разрешения на запись и правильного `X-CSRF-Token`; новые записи проходят проверку типов, вариантов списков и ссылочной целостности. PATCH/DELETE защищены конфликтами версий HTTP 409. Идентификаторы столбцов проходят строгую проверку; пользовательский SQL и JavaScript не исполняются.

Схема редактируется владельцем фабрики через:

- `GET /api/studio/projects/:projectId/entities`
- `POST /api/studio/projects/:projectId/entities`
- `PATCH /api/studio/projects/:projectId/entities/:entityId` (требуется `revision`)

Безопасное удаление сущностей и переработка старых полей будут отдельными задачами; такой функции пока нет.

## Две независимые базы

```text
Studio data/studio.sqlite             CRM data/projects/<UUID>.sqlite
- владельцы                           - отдельные пользователи и сессии
- конфигурации проектов              - гости, визиты, задачи, платежный журнал
- блоки опубликованных страниц       - custom_suppliers, custom_orders, ...
- описания сущностей                 - записи пользовательских таблиц

ZIP-экспорт → config/project.json + src/common + src/crm + public/crm + run.mjs
  └── Запускается отдельно; создаёт новую data/crm.sqlite без записей первой CRM
```

### Экспорт и готовая демонстрация

В каталоге репозитория есть `scripts/build_sample.mjs`: он собирает самостоятельную CRM с тремя страницами, таблицами `suppliers` и `orders`, связью между ними и чистой базой при запуске:

```bash
node scripts/build_sample.mjs ./demo-restaurant.zip
```

Для запуска экспортированного ZIP распакуйте его в отдельную папку и выполните `node run.mjs` (порт 4180). Данные CRM, пароли и cookie в ZIP **не входят**. Настройки и схема входят как снимок на момент экспорта. Начиная с R0.4 обновление опубликованного ZIP применяется вручную через `ops.mjs` (только совместимые релизы R0.4, после проверки и резервного копирования).

## Тестирование

```bash
npm run check   # проверка синтаксиса Node + браузерного JS
npm test        # реальные HTTP, auth/RBAC, SQLite миграции, Page Builder и ZIP
```

Дополнительная проверка интерфейса в Chromium с **моделируемыми API-ответами** (при наличии Python Playwright и Chromium):

```bash
python tests/ui_entities_static.py
```

Она проверяет форму схемы, создание нового поля, сохранение, создание записи в CRM, десктоп/мобильную ширину и ошибки JavaScript. Реальное API, SQLite и ZIP тестируются **отдельно** тестами Node. Полный браузерный E2E с настоящим HTTP по локальному адресу в данной среде не выполнен.

## Файлы проекта

```text
server.mjs                          Фабрика + CRM маршрутизатор
src/common/entities.mjs            Контракт схемы и проверка изменений
src/crm/entities.mjs               Миграции SQLite, CRUD, роли, фильтры
src/studio/routes.mjs              Создание и настройка проектов/схем
src/studio/schema.sql              Таблицы Studio и project_entities
public/studio/entities.js          Data Studio: редактор схем
public/studio/editor.js            Визуальный редактор страниц
public/crm/entities.js             Генерируемые формы и таблицы CRM
public/crm/pages.js                Опубликованные страницы и custom actions
src/studio/export.mjs              Экспорт кода, релиза и manifest.json в ZIP
src/studio/releases.mjs            Неизменяемые версии проектов
src/common/operations.mjs          Контролируемые обновления и восстановление самостоятельной CRM
scripts/factory_maintenance.mjs    Резервные копии всей фабрики
scripts/build_sample.mjs           Готовая автономная CRM для проверки
tests/entities.test.mjs            Настоящие тесты новой модели данных
qa/entity_studio_*.png             Интерфейс Studio в Chromium (mock API)
qa/entity_crm_*.png                Интерфейс CRM в Chromium (mock API)
docs/                              Архитектура, план, безопасность, статус
```

## Честные ограничения

- **Реализованы два типа проекта: Restaurant CRM и корпоративный сайт.** Интернет-магазины, другие отраслевые шаблоны, SaaS для множества клиентов и нативные мобильные приложения ещё не генерируются.
- **Платежи — ручной учёт**, не приём денежных средств и не реальные возвраты.
- Конструктор страниц структурированный, не pixel-perfect drag-and-drop; нет произвольного workflow-графа, облачного хостинга, импортов CSV, multi-provider API коннекторов, автоматических бэкапов и облачной доставки обновлений. Локальные backup/restore и контролируемое обновление R0.4 реализованы.
- Встроенный `node:sqlite` в Node 22 остаётся экспериментальным. Для коммерческого multi-tenant SaaS нужна отдельная миграция на поддерживаемую БД/клиент, нагрузочные тесты, операционная готовность, аудит приватности и безопасности.
- По умолчанию слушает **127.0.0.1**, публичное развёртывание без настройки TLS, защиты установки, мониторинга и резервных копий не рекомендуется.

Подробности: [Data Studio](docs/DATA_STUDIO.md), [Статус](docs/PROJECT_STATUS.md), [Архитектура](docs/ARCHITECTURE.md), [Проверки](docs/TESTING.md), [Безопасность](docs/SECURITY.md).


## R0.9 — автоматизации CRM

В Restaurant CRM появился пункт **Автоматизации** (доступ администратора и менеджера).
Правила создают **внутреннюю задачу**, когда добавлен клиент или зарегистрирован визит. Действие происходит на сервере внутри транзакции SQLite; повторная обработка того же события не дублирует задачу. Есть включение/выключение, удаление и журнал последних 100 срабатываний. Правила сохраняются в базе конкретной CRM и попадают в резервную копию этой CRM.

**Важно:** правила конкретной установленной CRM не экспортируются в универсальный шаблон проекта, поскольку хранятся в её рабочей базе. В экспортированном приложении конструктор автоматизаций присутствует, но список правил изначально пуст. Нет отправки email/SMS, фоновых очередей, таймеров, платёжных действий, произвольного кода, создания задач по изменениям пользовательских сущностей. Для правил нужны модули clients и tasks. Это локальный MVP, не сервис для безопасного размещения медицинских персональных данных.

---

## R3.4 PREVIEW: signed offline client fleet diagnostics

Each exported CRM/site now includes `deploy/fleet-agent.mjs`. The installer can generate an Ed25519 identity (`init --confirm`), display its public key (`public`) and export a private signed JSON snapshot (`snapshot --out=/private/report.json`). No customer data, hostnames or secrets are included. The report must be saved **outside** the app installation directory.

In OBSIDIAN, open the project deployment wizard and expand the fleet status panel. Pin the installation public key once, then manually import the signed JSON. The factory rejects tampered, foreign, old and replayed reports. Explicit key rotation clears old reports. This is manual offline verification, **not continuous remote monitoring**.

Run `npm run check && npm test`, `npm run acceptance:r34`, `python3 tests/ui_r34_fleet_static.py`. For actual isolated Docker acceptance use `npm run docker:e2e:r34` on a Linux Docker runner. Current local environment cannot run Docker. See `docs/RELEASE_R34_PREVIEW.md` for detailed limitations and instructions.
