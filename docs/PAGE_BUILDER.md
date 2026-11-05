# Visual page builder — R0.2

## Problem this solves

Instead of reprogramming page UI and common handlers for every restaurant CRM, the factory stores **validated declarative page configurations**. The same config is interpreted by the Studio preview, served to authenticated CRM staff, and embedded into an autonomous source ZIP. The CRM stays operational if the factory is removed.

## New SQL structure

```sql
CREATE TABLE project_pages (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 slug TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
 blocks_json TEXT NOT NULL,
 position INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(project_id,slug)
);
```

`CREATE TABLE IF NOT EXISTS` means pre-existing R0.1 databases receive this new table on restart. Existing R0.1 projects get **zero pages** and can create their first one in the editor; projects created in R0.2 start with a `Контроль сервиса` example page. No existing CRM guest data is migrated or erased.

## Shared page contract

`src/common/pages.mjs` defines validation and canonical normalization. Example:

```json
{
  "title": "Контроль сервиса",
  "slug": "service",
  "description": "Операционная панель",
  "published": true,
  "blocks": [
    {"id":"hero-demo-001","type":"hero","eyebrow":"RESTAURANT", "title":"Ваши гости", "subtitle":"Локальные данные CRM"},
    {"id":"metric-demo-001","type":"metric","metric":"clients_total","label":"Клиентов"},
    {"id":"form-demo-001","type":"form","entity":"clients","title":"Добавить клиента","fields":["full_name","phone"],"submitLabel":"Сохранить"},
    {"id":"button-demo-001","type":"button","label":"Задачи","action":"navigate:tasks","style":"secondary"}
  ]
}
```

`id` blocks are opaque unique identifiers of 8–64 URL-safe characters. Maximum 20 pages/project, 30 blocks/page, request body <=128 KiB. `slug` accepts lowercase Latin letters, digits, hyphens, and cannot conflict with built-in CRM routes. Title, description and text are length-limited. Duplicate IDs are rejected.

## Studio REST API (requires factory owner session)

| Method and path | Description |
| --- | --- |
| `GET /api/studio/projects/:projectId/pages` | List ordered pages, including drafts |
| `POST /api/studio/projects/:projectId/pages` | Create a page with validated schema |
| `PATCH /api/studio/projects/:projectId/pages/:pageId` | Full page update, requires current `revision` |
| `DELETE /api/studio/projects/:projectId/pages/:pageId` | Delete page, requires current `revision` |

A stale edit receives HTTP 409. New revisions are incremented atomically in SQLite by comparing the last known revision in the `UPDATE WHERE revision=?` clause. All modifications require the same CSRF validation as other Studio API writes.

## CRM read and execution API

| Endpoint | Behavior |
| --- | --- |
| `GET /api/pages` | Authenticated users receive **published pages only** |
| `GET /api/page-metrics` | Authenticated users receive module- and role-appropriate aggregate metrics |
| `GET /api/clients`, `GET /api/tasks` | Existing protected APIs provide table rows |
| `POST /api/clients`, `POST /api/tasks` | Existing protected APIs process generated forms with CSRF and validation |

`src/crm/routes.mjs` never accepts arbitrary actions from page configurations. Runtime `public/crm/pages.js` maps approved action names to existing secure API or CRM UI handlers.

## Allowed blocks, entities and actions

| Block | Contract |
| --- | --- |
| `hero` | Eyebrow + title + subtitle |
| `text` | Title + escaped multiline body |
| `metric` | `clients_total`, `visits_total`, `open_tasks`, `repeat_share`, `paid_minor`; role/module-gated |
| `button` | One of ten built-in navigation or create actions |
| `form` | `clients` or `tasks`, selected allowlisted fields, required primary field |
| `table` | `clients` or `tasks`, selected allowlisted columns, first 10 rows from max-200 listing |
| `divider` | Decorative rule only |

No raw HTML/JS injection, arbitrary URLs, arbitrary API route mapping, SQL editor, remote scripts or nested expressions.

## Known limitations

- Studio preview is **data-free** to keep guest data out of the factory UI; live data appears in CRM.
- Grid layout is automatic. Blocks can be reordered but not freely positioned pixel-by-pixel.
- Form/table sources support only clients/tasks at R0.2.
- Published pages are reloaded when CRM refreshes; no live push updates.
- No generic table/schema designer, drag-to-resize, workflow engine, diff or rollback UI.
- Export embeds only the selected snapshot. Subsequent changes in Studio do not update previously exported copies.


## R0.3 — пользовательские данные в редакторе страниц

Описание выше фиксирует поведение R0.2. В R0.3 конструктор данных добавил источники `custom:<slug>` для блоков `form` и `table` и действия `create:custom:<slug>` / `navigate:custom:<slug>` для кнопок. Источник должен совпадать с существующей проверенной сущностью проекта. Форма обязана содержать обязательные поля и выполняет защищённый типизированный CRUD на сервере. Конфигурации пользовательских сущностей и опубликованных страниц входят в независимый ZIP-экспорт.

Выполнение произвольного JavaScript, SQL и произвольных HTTP-вызовов по-прежнему запрещено. Сведения о типах полей, ролях и миграциях находятся в [DATA_STUDIO.md](DATA_STUDIO.md).
