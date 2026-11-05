# R0.7 OBSIDIAN — 2026-11-04

## New

- Rebuilt Studio home page to match the owner's approved dark, gold-accented visual reference in real HTML/CSS/JS.
- Added dashboard product cards, right-side quick-start guide and database-backed counts, search and project sort, and grid/list switch.
- Replaced overloaded landing-page wizard with a three-step dialog preserving the working creation API.
- Added clickable existing project actions: open CRM/site, edit pages, data editor, versions, settings, and ZIP export.
- Added clearly identified starter template cards for an empty workspace; no dummy projects are inserted in the database.
- Implemented responsive layouts at reference desktop width, laptop width, and phone width.
- Registered strictly validated JPG/PNG static routes for assets cropped from the user-approved reference image.

## Compatibility

- No database schema migrations.
- No modifications to generated standalone CRM/site runtimes.
- No external JS/CSS dependencies.
- All 13 existing automated Node.js tests remain passing.

## Known limitations

- Product types remain CRM and company website only.
- Native app tile, automation workflow, and OSMANX Pro billing are not live products.
- Real local HTTP E2E from Chromium blocked by environment; separate API and mocked-UI tests passed.
