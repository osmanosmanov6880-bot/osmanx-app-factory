# R0.5 · Website modules

Новый тип `site` поддерживает обязательные `auth` (вход в CMS) и `cms` (публикация страниц), опционально `leads` (публичная форма + SQLite список обращений). Роли сайта: `admin`. Блоки сайта: `hero`, `text`, `features`, `button`, `form`, `divider`. Остальные модули `clients`, `tasks`, `analytics`, `payments` по-прежнему используются только CRM. Контакты сайта не являются эквайрингом.

---

# Modules and access rights

The selected Restaurant CRM blueprint currently supports **five** real modules:

| Module | Data and business behaviour | Dependencies |
| --- | --- | --- |
| `auth` | Login, initial admin, manager/staff accounts, sessions | Mandatory |
| `clients` | Guest cards, archive, sources, visit history | `auth` |
| `analytics` | Repeat visits, guest counts, manual payment totals, task counts | `auth` + `clients` |
| `tasks` | Tasks, assignment, priorities, deadlines, state changes | `auth` |
| `payments` | **Manual ledger**, amount/currency/method/status, idempotency | `auth` |

Factory dropdown currently supports only `crm` and `restaurant`. Other app categories exist on the long-term roadmap but are **not** represented as working options.

## Roles

| Operation | Admin | Manager | Staff |
| --- | :---: | :---: | :---: |
| Guest/visit read+write | ✓ | ✓ | ✓ |
| Task read+write | ✓ | ✓ | ✓ |
| View or update manual payment ledger | ✓ | ✓ | — |
| View analytics | ✓ | ✓ | — |
| View team members | ✓ | ✓ | ✓ |
| Create manager/staff | ✓ | — | — |
| View audit log | ✓ | — | — |

Permissions are always verified in the HTTP API; hiding a navigation item is not treated as authorization.

## Accounting semantics

Payment states: `pending` → `paid` or `cancelled`; `paid` → `refunded`. The last transition only **marks a manual accounting entry as refunded**. It does not trigger any bank/card operation. Unique idempotency keys prevent duplicate creation and detect mismatched replay requests.

`paidMinor` is a total of manual operations in status `paid` **for one currency**. `repeatShare` is the percentage of guests with at least two recorded visits among guests with at least one recorded visit. It is not cohort retention, predictive analytics, or verified POS revenue.

---
## R0.2 pages and module-dependent blocks

- `auth`: mandatory and enables published page access plus navigation to dashboard.
- `clients`: client forms, client tables, visit navigation, client and visit counters.
- `tasks`: task forms, task tables, task navigation and open-task counter.
- `analytics`: repeat visitor share (admin/manager only; requires `clients`).
- `payments`: manual payment navigation, new-ledger-record action and paid ledger amount (admin/manager only).

Disabling a module while a saved page depends on it is rejected by the project update validator. This avoids broken buttons silently appearing after module removal.

## R0.3 Data Studio

The configurable **custom entities** subsystem is available to all CRM projects and depends on `auth`. It does not require the existing fixed `clients` or `tasks` modules. Entity-level read/write role arrays are enforced per endpoint. The subsystem generates physical SQLite tables, typed CRUD, basic search/pagination and forms/tables in both the CRM navigation and published custom pages. Its schema is exported separately from runtime data. Full limits and field rules: `docs/DATA_STUDIO.md`.
