# OSMANX APP FACTORY R2.6 Preview - controlled deployment upgrade

Date: 2026-11-05. Baseline: **R1.3 + R2.4/R2.5 feature backports**, not the unavailable original R2.3 codebase. The source package version stays **1.3.0** to avoid representing this backport as a verified canonical R2.6 release. OBSIDIAN UI remains the approved dark design. This is an engineering preview, not a production SaaS certification.

## Features in real source code

1. Factory deployment exports may select a persisted, immutable project release via `releaseId`. The resulting independent ZIP preserves the application's saved sequence and snapshot hash; only the authenticated owner may export it.
2. Studio -> Prepare deployment now lists saved release snapshots and lets the user choose a numbered version without leaving the OBSIDIAN wizard.
3. Every newly exported deployment bundle contains `deploy/upgrade.mjs`. Its `plan` command verifies the complete application and deployment inventories (SHA-256), project UUID, application type, domain, fixed Docker Compose name, engine version, release sequence and additive-only entity changes before taking the service offline.
4. `apply NEW.zip --confirm` stops the installed application, invokes R2.5's offline SQLite backup container, journals a complete code snapshot, replaces only declared managed files, checks all installed hashes, runs `docker compose up -d --build --wait --wait-timeout 120`, then runs the application's HTTP healthcheck from the container. If any step fails, old code and database are restored and the original service is restarted.
5. An interrupted or unsuccessful rollback preserves a private journal in `.osmanx-upgrades/active.json`. `recover --confirm` retries the rollback; `status` shows the current transaction and the last 20 journal entries. The directory is deliberately excluded from Docker build context.
6. `.env`, application data and backup folders are not imported from the release archive, and update/backup directories require restricted host permissions. Unsupported automatic migrations, removed modules, engine/schema changes and downgraded releases are rejected.

**Boundaries:** This updater is intended for fixed-name R2.5+ Compose installations (`deploy/manifest.json` format v2). R2.4 format v1 used directory-dependent volumes and MUST be migrated manually. Hashes are not digital signatures: only install packages obtained from a trusted factory. The updater does not change the DNS, publish through GitHub or Cloudflare, or verify public HTTPS automatically. The maintenance mechanism is downtime-based; it is not a blue/green zero-downtime deployment.

## Upgrade commands on Linux VPS

**First create a saved release in Factory**, then use the OBSIDIAN deployment wizard to export the saved version *using exactly the original domain*.

Move the ZIP into a private staging directory on your VPS and run, from the installed application's folder:

```bash
node deploy/upgrade.mjs plan /private/staging/new-version.zip
node deploy/upgrade.mjs apply /private/staging/new-version.zip --confirm
node deploy/upgrade.mjs status
node deploy/verify-live.mjs --live
```

Important: an existing R2.5 package did not yet contain `deploy/upgrade.mjs`. To bootstrap, unpack the **new R2.6** client ZIP into a separate staging directory without replacing the existing kit, then run its script against the old installation:

```bash
node /private/staging/r26/deploy/upgrade.mjs plan /private/staging/new-version.zip --installed=/srv/osmanx/client
node /private/staging/r26/deploy/upgrade.mjs apply /private/staging/new-version.zip --installed=/srv/osmanx/client --confirm
```

Keep the private `.env` in the installed directory. Ensure `backups` exists, is writable by container UID 1000 and has mode 0700; `.env` must have mode 0600. The host must have Docker Engine and modern Docker Compose supporting `up --wait` and `exec -T`. Schedule downtime; the gateway may serve 502 temporarily. Make an offsite, encrypted copy of the SQLite backup before production upgrades.

If Docker startup fails but rollback succeeds, the command exits with an error indicating that the old service has been restored. If rollback fails or power is interrupted, do not delete the journal or stale SQLite lock files blindly. Investigate the server and run:

```bash
node deploy/upgrade.mjs status
node deploy/upgrade.mjs recover --confirm
```

If the bootstrap script is needed for R2.5, add `--installed=/srv/osmanx/client` to both commands. A failed restore is deliberately not masked. After successful update/rollback, verify public HTTPS yourself by running `node deploy/verify-live.mjs --live` from the installed app directory.

## Verification boundary

- Node.js syntax + regression suite, versioned release HTTP export, backup/restore, rollback and recovery logic, integrity checks and client HTTP startup are validated locally.
- Browser desktop (1440px) and mobile (390px) interactions are checked in Chromium **with a mocked API**. Live HTTP API tests are separate Node.js tests.
- Docker Engine is **not available in the test environment**. Docker Compose orchestration and automatic rollback after a failed container healthcheck were exercised via an injected adapter, not a real VPS or remote TLS certificate. Do not treat a fake-adapter test as a production Docker test.
- No public deployment, genuine VPS/TLS check, third-party webhook delivery or complete browser-to-live-server E2E can be claimed.

## Technical files

- `templates/deploy/upgrade.mjs`: release planning, safety gates, transactional update, journal and recovery.
- `src/studio/deployment.mjs`: includes deployment upgrade engine in independent client exports; supports persisted release metadata.
- `src/studio/routes.mjs`: owner-scoped `releaseId` query for deployment exports.
- `public/studio/deploy.js` and `public/studio/app.css`: compact version picker in OBSIDIAN wizard.
- `tests/r26_upgrade.test.mjs`: upgrade success, data recovery, failure/recover, unsafe package rejection, bootstrap CLI.
- `tests/r26_release_export.test.mjs`: real HTTP API release export authorization for CRM and site.
- `tests/ui_r26_deploy_static.py`: responsive Chromium interaction check with mocked API.

## Next engineering priority

Docker Compose integration tests with real volumes and failure injection on a disposable Linux VPS, remote TLS probe, version signing or reproducible artifact attestation, and a documented migration path from the unavailable original R2.3 source tree.
