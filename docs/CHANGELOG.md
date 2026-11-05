## R1.3 — 2026-11-04

- Палитра с drag-and-drop вставкой и структурной сеткой 12 колонок, мобильный стек.
- `layout` для блоков CRM и сайта, серверная валидация и экспорт.
- Пользовательский счётчик записей с проверкой серверных разрешений.
- Лимит 5/10/20 для таблиц, настраиваемое уведомление для форм.
- Отмена и повтор действий, упрощённая мобильная палитра.
- 31 Node.js тест, Chromium UI QA и проверка автономной CRM.

## 0.9.0 — 2026-11-04
- CRM automation rules, task triggers, run log, server transactions and role checks.
- 2 new tests and Russian UI for rules.
- Prior features retained.

# R0.8 / 2026-11-04

- Private immutable reusable templates (CRM and website).
- Owner-only template CRUD, verified portable JSON, import/export.
- One-click clean project duplication, generated new IDs, no tenant records.
- Deterministic pre-export configuration diagnostics with honest warnings.
- Russian dark-template library UI, search, responsive cards and keyboard flow.
- Windows one-click startup helper; 15/15 Node tests and Chromium UI smoke.

---

## R0.5 / Website Factory (2026-11-04)

Реализованы публичные сайты с CMS, лидами, SEO, экспортом, резервными копиями и совместимостью существующей CRM. Подробности в [CHANGELOG_R05.md](CHANGELOG_R05.md).

# Changelog

## R0.4 — 2026-11-04 — Versioned Releases, Backups & Recovery

- Added immutable per-project release snapshots in Studio SQLite with per-project version sequences and SHA-256 source snapshot hashes.
- Added release owner API and release manager modal in the Russian Studio UI; download each version independently.
- Added self-describing standalone source ZIP `manifest.json` with SHA-256 file hashes and project identity.
- Added strict STORE-only ZIP parser with name/bounds/CRC checks to prevent traversals and corrupted packages.
- Added standalone `ops.mjs plan|backup|verify|update|restore|recover`; offline lock gate, schema preflight on a SQLite backup clone, guarded code apply and code+DB rollback snapshots.
- Added consistent SQLite backup, verification and offline restore for Factory `studio.sqlite` and all project CRM databases.
- Added tests for immutable releases, real CRUD data retention through v1->v2, full restore, lock enforcement, local edits, CRC tampering and Factory recovery.
- Added desktop/mobile mocked-browser release UI QA screenshots.
- Scope constraint: update only R0.4 engine release to compatible R0.4 engine release, not automatic R0.3 migration or cloud update.



## R0.2 — 2026-11-03 — Visual Page Builder

### Implemented
- Persistent `project_pages` SQLite table with revisions, unique slugs, draft/published state and ordered pages.
- Strict shared page schema and normalizer; allowlisted component types, actions, metrics, entities, fields and columns; module dependencies enforced.
- One starter `Контроль сервиса` page generated for every new restaurant CRM project; existing databases upgrade non-destructively.
- New owner-only page CRUD API with CSRF protection, optimistic revision matching and cross-project checks.
- Full-screen Studio editor with block palette, page list, property inspector, keyboard-accessible selection, drag ordering and up/down controls.
- Live no-data preview, desktop/mobile preview width controls, dark responsive styles.
- Published page navigation in CRM; live metrics, safe HTML-escaped text, read-only tables and working client/task forms.
- Reuse of secure existing CRM APIs for creating records; no eval, arbitrary HTML, SQL or arbitrary API actions.
- Project ZIP source export includes the exact page configuration; standalone CRM retains pages and clean database.
- New HTTP/schema tests, optional Chromium tests with mocked API, screenshots and page builder documentation.

### Intentionally not delivered
- Generic visual database builder, arbitrary UI layout grid, public cloud SaaS deployment, real PSP transactions and refunds.

## R0.1 — 2026-11-03 — Initial Restaurant CRM MVP

- Dependency-free local Node+SQLite factory and standalone restaurant CRM.
- Factory auth and project settings; isolated CRM databases and separate accounts.
- Clients, visits, tasks, manual payments, analytics, RBAC, ZIP source export and HTTP integration tests.

## R0.3 — Universal Entity Builder · 2026-11-03

- Added protected `project_entities` in Studio SQLite, CRUD editor routes with revision conflict checks.
- Added schema compiler and type validation for text, longtext, integer, number, boolean, date, select and reference.
- Implemented physical custom SQLite tables, per-entity foreign keys, additive migration and schema snapshots.
- Added server-side generic rows API with permissions, typed values, pagination, search, optimistic concurrency and archive.
- Added 3-column Russian Data Studio UI and generated CRM data sections with actual forms/records.
- Integrated custom form/table data sources and button actions into R0.2 Page Builder.
- Standalone export includes field definitions, code and published pages, excluding customer records.
- Added `tests/entities.test.mjs` with SQL validation, schema migration, RBAC, CSRF, references, page bindings and independent ZIP tests.
- Added `tests/ui_entities_static.py` for mocked-browser UI tests and screenshots, 1440/390 widths.
- Updated demo CRM with 2 custom tables and 3 published pages.
