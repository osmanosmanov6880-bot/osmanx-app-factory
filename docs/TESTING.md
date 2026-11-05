# R0.5 проверка сайта

`npm test` — 13 тестов Node, реальные HTTP/SQLite/ZIP и миграции/резервирование, включая старые CRM регрессии. `python tests/ui_website_static.py` и `python tests/ui_factory_site_static.py` — интерактивный Chromium с тестовыми/mock API, desktop 1440px и mobile 390px. Chromium → localhost реально заблокирован средой, поэтому полный browser-to-server E2E остаётся задачей для отдельной машины. Скриншоты `qa/site_*.png` подтверждают рендер UI, но не HTTP integration.

---

# Testing — R0.4

## Actual checks

```bash
npm run check
npm test
python tests/ui_entities_static.py  # optional; requires Playwright + Chromium
```

### Node (real HTTP + SQLite)

- Existing R0.2 full factory→CRM→independent ZIP integration regression.
- Unit checks for schema identifiers, duplicate/forbidden keys, target references, immutable types and additive migrations.
- Live HTTP sequence: create project; owner-only schema write; create linked suppliers/orders; reject unknown references, invalid choice, unsafe extra fields, fractional integers, bad calendar dates.
- Search records, PATCH with revision and reject stale writes.
- Add optional column and confirm existing record remains; reject destructive changes.
- Verify staff cannot write if schema write roles exclude `staff`; reject missing CSRF.
- Publish custom page referencing generated entity; verify export contains the page and schemas.
- Extract ZIP, boot standalone CRM with clean database and add independent records; prove source tenant remains unchanged.

**Latest run:** 6 passing Node tests (all suites). `npm run check` passed.

### Chromium (mocked API responses, not actual HTTP E2E)

- `tests/ui_entities_static.py` loads the real browser JS and CSS, with in-memory HTTP mocks, in headless Chromium at **1440×900 and 390×844**.
- Studio: open Data Studio, add a field, edit label and code, save revision; asserts mock persisted new key and no root overflow.
- CRM: open generated orders, create a linked order via actual form events; asserts row appears, no JS exception and no root overflow.
- Artifacts: `qa/entity_studio_1440.png`, `qa/entity_studio_390.png`, `qa/entity_crm_1440.png`, `qa/entity_crm_390.png`.

Browser navigation to a live localhost server was restricted by policy in the prior R0.2 environment; **do not interpret mocked UI tests as genuine browser-to-server E2E**. A full unrestricted browser integration, accessibility audit, load test and backup/restore exercise remain open.


## Additional R0.4 verification — 2026-11-04

```bash
npm run check
npm test
python tests/ui_releases_static.py
```

**9/9 real Node tests passed.** New `tests/releases.test.mjs` publishes v1 and v2 through protected Factory endpoints, verifies immutable v1 export after modifying live schema, exports standalone code, starts its own HTTP/SQLite server, creates a real guest, enforces stop/lock and local-edit protections, plans an additive migration, installs v2, logs in with the existing password, confirms the guest remains, adds a supplier and restores a full pre-upgrade code+database snapshot. It also checks ZIP CRC/traversal rejection.

New `tests/factory_backup.test.mjs` starts Factory HTTP, creates Studio/project SQLite databases with a CRM guest, stops Factory, backs up and verifies both databases, mutates both, restores offline, starts Factory again and confirms both the project list and CRM guest data were restored.

The Chromium release-manager test, `tests/ui_releases_static.py`, opens the real HTML/CSS/JS with mocked endpoints; it clicks Releases, publishes v1 and checks the download URL. Screenshots at 1440 and 390 pixels and no root horizontal overflow or page errors were verified. It **is not connected to live HTTP**. The full HTTP browser smoke was attempted but Chromium received `net::ERR_BLOCKED_BY_ADMINISTRATOR`, an environmental restriction. Keep that release gate open.
