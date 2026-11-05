# OSMANX APP FACTORY R0.7 / OBSIDIAN

## Objective

Implement the owner's **approved dark luxury dashboard reference** directly in the existing app (not a decorative screenshot, replacement application, or mocked product).

## What changed in actual code

- `public/studio/index.html`: new live dashboard with left navigation, search, navigation buttons, product cards, features, right-side onboarding/metrics column, project gallery and accessible project creation dialog.
- `public/studio/app.css`: OBSIDIAN layout and detailed responsive styling. The dark palette, card geometry, typography, background imagery, shadows, and spacing are based on the approved 1672x941 reference.
- `public/studio/app.js`: new dashboard project cards, search, ordering, grid/list switch, functional navigation, connected real CRM/website wizard, reusable modal interactions, and real project counts.
- `public/studio/media/`: images directly cropped from the supplied design reference, **not new generated images**. Art is used as design assets; buttons, text and projects are real DOM components.
- `src/studio/routes.mjs` and `src/common/http.mjs`: restricted static routes and MIME types for local JPG/PNG assets. Routes use an allowlisted filename pattern and do not expose arbitrary server files.

## Fidelity

Screenshots in `qa/approved_dashboard_1672.png` and `qa/approved_first_run_1672.png` were captured at the same 1672 x 941 size as the approved source. Main composition follows it: 287px left rail, 82px top toolbar, primary content with right onboarding rail, a 3-card selector, a 6-tool strip, and project cards. Width-responsive versions captured at 1440px and 390px.

Typography is rendered using available system fonts; exact glyph metrics will vary across Windows, macOS and Linux. Pixel-perfect visual identity cannot be guaranteed across devices, but the tested reference-size composition is aligned closely with the supplied screenshot.

## Product truthfulness

- CRM and corporate website are real working product choices. Both use the pre-existing server, persistence, and ZIP export.
- The mobile-app product tile and visual automation item indicate **not implemented yet** and do not imply a functioning exporter.
- The `OSMANX Pro` sidebar item is visual branding for the approved reference; **no billing, subscriptions or paid plans have been activated**.
- Three image-backed cards appear as clearly labeled starter templates when the owner has zero saved projects, and as real project cards with live data after project creation.
- The profile picture is artwork from the approved reference, a decorative placeholder **not a verified portrait of the current signed-in user**. The displayed username is read from the authenticated Studio session.
- Metrics show the actual number of projects of each supported type, not sample numbers from the reference.

## Verified

- `npm run check`: passes JS syntax checks.
- `npm test`: 13/13 independent Node.js tests pass, including studio to CRM/site and clean standalone ZIP flows.
- `python3 tests/ui_r07_static.py`: Chromium at 1672, 1440 and 390px, with mock API. Confirmed search, sort, grid/list view, new CRM and site wizards, saving mock projects, profile UI, and no horizontal overflow.
- Node.js HTTP server serves the actual image assets using `image/jpeg` and rejects unknown media.
- Full real-HTTP browser E2E is **not claimed**: this environment blocks Chromium navigation to localhost (`ERR_BLOCKED_BY_ADMINISTRATOR`). Real Node.js HTTP integration tests and separately mocked Chromium UI tests should not be conflated.

## What remains

Native mobile app generation, payment processing, a full visual workflow engine, real billing, cloud deployment, and full-browser HTTP E2E are not part of this visual implementation. Existing CRM and site engine capabilities and limitations from R0.6 still apply.
