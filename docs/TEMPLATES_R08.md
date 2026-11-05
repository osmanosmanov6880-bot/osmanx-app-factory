# R0.8 / Project templates and safe cloning

## What this release actually adds

Studio now supports private, immutable reusable project templates for the existing
Restaurant CRM and Corporate Website blueprints. A template is a declarative
configuration snapshot (modules, theme settings, custom entity definitions,
page blocks and publish flags); **it is not a copy of a live tenant database**.

The source project can be edited after saving a template without changing that
template. Creating a project from a template creates new project/page/entity IDs
and a fresh SQLite runtime database. The template library is private to the
authenticated Studio owner. It is limited to 60 templates per owner and each
serialized configuration must be <= 120 KiB.

## User workflow

1. Log in and create or open a CRM/site.
2. From the project menu (...) click **Save as template**.
3. Name the template and optionally add a description.
4. Use the **Templates** sidebar button to browse, search and launch a new project.
5. Enter a new project name and click **Create project**.
6. The new project receives the schema and pages but starts without customer data,
   users, login sessions, payments or leads.
7. Download JSON to reuse the configuration on another installation. JSON import
   validates the manifest, SHA-256 checksum, page schema, module dependencies,
   entity names and reference relations before saving.
8. **Create copy** duplicates a project configuration without storing a template.
9. **Check project** performs a configuration-only preflight before exporting ZIP.

## HTTP endpoints (owner cookie and CSRF for mutations)

- `GET /api/studio/templates` — list templates of the signed-in owner
- `POST /api/studio/templates` — `{projectId, name, description?}`
- `GET /api/studio/templates/:id/download` — portable JSON manifest
- `POST /api/studio/templates/import` — portable JSON manifest
- `POST /api/studio/templates/:id/projects` — `{name}` creates separate project
- `DELETE /api/studio/templates/:id` — remove a template only
- `POST /api/studio/projects/:id/clone` — `{name}`
- `GET /api/studio/projects/:id/diagnostics` — configuration checks, no mutation

## Import and security properties

- Every template is associated with its owning Studio user.
- A template manifest includes a SHA-256 checksum for accidental corruption
  detection; SHA-256 **does not authenticate its publisher**. Import only JSON
  from trusted sources.
- The parser does not accept arbitrary executable JavaScript, CSS, SQL or files.
- Raw customer SQLite, payment records, visitors, passwords and auth sessions
  are never read by the template-copying code.
- Exported standalone app still has its own full-source ZIP, separate from the
  portable JSON template.
- Existing R0.4 CRM releases/backup flow and R0.5 website backup flow are retained.

## Tested and not tested

- 15 Node tests pass, including real HTTP + SQLite + independent ZIP export,
  private-template access control and invalid/corrupt manifest rejection.
- R0.8 Chromium interaction test covers template saving, launching, cloning,
  diagnostics and responsive layout at 1672 and 390 px with mocked APIs.
- Older page editor/entity/site UI smoke tests remain separately exercised.
- Full browser-to-localhost real HTTP E2E blocked by this environment's browser
  administrator policy. Server HTTP tests and mock-browser tests are distinct.
- Not a production security certification, publish-ready cloud service, browser
  mobile-app generator or real payment acquiring solution.

## Next work

Cross-industry CRM business models, true multi-template design engine,
visual workflow automations, asset upload and image management,
provider integrations, web deployment, password recovery/MFA, privacy controls,
full real browser HTTP E2E and off-site encrypted backups remain future work.
