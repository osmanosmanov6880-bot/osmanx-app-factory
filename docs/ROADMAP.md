# После релиза R0.5

Выполнено: второй blueprint «Корпоративный сайт», редактор публичных страниц, CMS, лиды, SEO, ZIP-экспорт, офлайн-бэкап и сохранение CRM R0.4. Следующее: R0.6 — layout/grid, медиа, доменные блоки, безопасное standalone-site обновление; реальный браузерный E2E на доступной машине, затем отраслевые шаблоны и промышленная эксплуатация. Нельзя заявлять production-ready до HTTPS, антиспама, privacy-review и нагрузочного тестирования.

---

# Roadmap — toward a reusable product factory

## Delivered in MVP 0.1

- Full-stack local factory, one real restaurant CRM blueprint, owner access and project list.
- Five selectable modules; separate per-project databases; server-side role checks.
- Guest CRUD/archive and visits, tasks, manual payment ledger, transparent analytics.
- Theme accent and primary button action selector.
- Independent ZIP code export with clean local database bootstrap.
- HTTP integration test covering standalone export.

## Next development phases (not implemented)

### R0.2 — Reliability and data operations

Schema migrations, data export/import, paginated tables, duplicate-contact handling, client history timeline, validated backup+restore, durable login throttling, password resets and application health monitoring.

### R0.3 — Visual page editor

Drag-and-drop component tree, responsive constraints, reusable themes, page schemas, keyboard accessibility, undo/redo, safe actions editor (navigate/create/update/confirm/notify), server-validated action definitions and editor preview.

### R0.4 — Schema-driven module system

Metadata schema for entities, field relations, generated CRUD and migrations, dependency resolver, versioned templates and safe updates to previously exported projects. Migration away from Node's experimental SQLite binding.

### R0.5 — More independent products

Corporate website with forms and CMS, booking service, store starter. Each must pass an end-to-end build/export acceptance test before appearing as supported in the factory UI.

### R0.6 — Production SaaS infrastructure

PostgreSQL, hardened auth, isolation review, domain/TLS automation, CI/CD, queued jobs, backups, observability, billing for factory usage, audit and security reviews.

### R0.7 — Official external integrations

POS connectors with reconciled data; optional official PSP gateway adapter with checkout, verified webhooks, idempotency, refund processing and authorization. Payment features must stay explicitly in manual-ledger mode until that separate integration is implemented and verified.

## Product principle

**Avoid rebuilding commodity features from zero.** Every module has a data contract, authorization contract, UI contract and generated export contract. New vertical templates are configurations on common modules wherever possible, not duplicated applications. Keep a full-source export available as an alternative to perpetual vendor lock-in.

---
## R0.2 delivered on 2026-11-03

A validated visual page builder is implemented: seven blocks, strict page schema, client/task forms, published CRM pages, owner CRUD APIs and standalone ZIP support. See [PAGE_BUILDER.md](PAGE_BUILDER.md) for accepted schema and endpoints.

## R0.3 proposed engineering milestones

1. Generic data entities with field validation, schema migrations and safe relationship editor.
2. Responsive grid constraints and visual action flows (`event -> condition -> action`) with permission checks.
3. Template versioning and safe reusable component updates across projects.
4. Browser E2E with real HTTP server on an unrestricted browser runtime, visual regression checks.
5. Backups/restoration, performance tests, stronger security operations, accessibility improvement.

**Do not claim websites, stores, cloud deployment or payment acquiring are complete at R0.2.**

## R0.3 completed locally

- Physical user-defined SQLite tables, 8 validated field types, add-only migrations and foreign-key references.
- Studio entity designer, generated CRM CRUD pages, Page Builder entity bindings and full ZIP export.
- Real HTTP integration tests and Chromium mock-API UI checks.

## R0.4 priority candidates

1. **Template versioning and update diff** for exported CRM, including backup and rollback gates.
2. Schema UI relation experience: searchable reference selectors, friendly labels, validation of permission dependencies, reference list pagination.
3. Visual form field rules, conditional blocks and workflow builder with an allowlisted rule engine (no arbitrary JS).
4. Production-readiness: supported DB adapter, backup/restore exercises, credential recovery, pagination and load tests.
5. More business templates only after a reusable foundation is stable; prioritize one complete website/booking blueprint over shallow catalogs.


## R0.4 implemented locally — 2026-11-04

Immutable versioned snapshots, signed-*looking but not cryptographically signed* SHA-256 manifests, the offline compatible-release installer, SQLite backup/restore, guarded recovery and Factory database snapshots are implemented and tested. These remain manual processes with downtime and no cloud storage. See [RELEASES_AND_BACKUPS.md](RELEASES_AND_BACKUPS.md).

### Revised R0.5 / R0.6 order

1. Real independent website blueprint with editable CMS data and contact forms (no fake placeholder sections).
2. Generalized module manifests/dependency graph and data migration registry; guarded import from old R0.3 standalone instances.
3. Improve Data Studio relations, UX and page editor, accessibility and full mock/real browser coverage.
4. Scheduled encrypted offsite backups, signed release provenance, crash-atomic delivery infrastructure, supported DB adapter and structured telemetry.
5. Only then consider live SaaS platform infrastructure, multi-tenant hosting, payments and official POS integration.
