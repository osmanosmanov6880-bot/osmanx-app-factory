# OSMANX APP FACTORY R3.6 — Docker restart safety and signed aggregate diagnostics

**Release scope:** four implemented blocks on top of local R3.5 Preview (original source lineage R1.3). This does not merge the unavailable original R2.3 source. `package.json` remains at `1.3.0` deliberately, so this is not an independently certified R3.6 product/production release.

## Block 1 — safe Linux container restart and lock ownership

`src/common/maintenance.mjs` now records the process start ticks from Linux `/proc/<pid>/stat` alongside the PID. When a container restarts, PID 1 may be reused. A stale lock can be reclaimed only when the PID is dead or its Linux start identity differs. A legacy PID-only file with a currently running PID fails closed. Symlinks, invalid kinds, group/world-writable locks and oversized files are rejected. When `/proc` is unavailable or inconclusive, the implementation refuses to guess.

## Block 2 — privacy-safe runtime HTTP counters

`src/common/runtime-health.mjs` is wired to both `templates/standalone/run.mjs` and `templates/standalone/site-run.mjs`. It groups only HTTP status categories in fixed hourly buckets, retaining at most 24 hourly buckets in a private data directory. It records `requests`, `clientErrors`, `serverErrors`, and `maintenanceUnavailable`. The file includes the app UUID and release number, not customer records. It never records request paths, IP addresses, headers, payloads, user IDs or stack traces. The counters flush periodically and during graceful shutdown; a forced power loss may lose the latest unflushed interval. This is best-effort diagnostic information, not exhaustive audit logging.

On a local standalone installation:

```sh
node deploy/telemetry-read.mjs
```

On a VPS with Compose, run this **inside** the app container or use the explicit fleet command below. The app volume is not assumed to be visible as a host-side `./data` directory.

## Block 3 — Ed25519-signed fleet v3 telemetry and OBSIDIAN

R3.6 adds an opt-in v3 report (`--telemetry`) while retaining verification of earlier v1/v2 packets. It reads the fixed numeric counters either locally or through `docker compose exec -T app` (when no local summary exists), without HTTP calls or reading SQLite customer records. It rejects unrequested data, extra fields, impossible counts, timestamps in the future, mismatched signatures, the wrong project and replayed packets.

```sh
node deploy/fleet-agent.mjs init --confirm
node deploy/fleet-agent.mjs public
node deploy/fleet-agent.mjs snapshot --out=/private/status-r36.json --telemetry
```

The last command performs a read of local aggregate counters or an explicitly requested read from the Docker app container. It does **not** publish, upload or email the report; the operator manually imports it in the closed-by-default OBSIDIAN Fleet section. Existing v1/v2 reports remain supported. Studio checks project ownership again when a fleet status is read, even if its caller already checked access. The panel displays a numeric 24-hour summary. No webhooks or automatic background monitoring are enabled.

## Block 4 — isolated Docker restart regression and CI

`npm run docker:e2e:r36` runs a test only when Docker Engine and the Compose plugin are available. It uses CRM and site archives with synthetic data, starts only the private `app` service (not the public gateway), performs internal health traffic, tests graceful stop, checks private counters after restart, intentionally SIGKILLs the app, verifies preservation of a synthetic sentinel in the Docker data volume and runs SQLite `PRAGMA quick_check` after restart. It then runs `docker compose down --volumes --remove-orphans`; cleanup failure causes a hard error rather than a passing report.

This runner has a unit-tested cleanup contract and a separate `.github/workflows/r36-docker-restart-telemetry.yml` pipeline including the existing signed-upgrade tests. **The presence of that workflow is not evidence of any GitHub Actions or VPS execution.** No actual Docker Engine or public HTTPS was available in the working environment used to build this preview.

## Verify locally

Requires Node.js >=22.16.0. In the factory source directory:

```sh
npm run check
npm test
npm run test:r36
python3 tests/ui_r36_fleet_static.py
npm run samples:r36 -- /path/to/sample-exports
npm run verify:samples:r36 -- /path/to/sample-exports
```

The UI verification uses Chromium with **mocked** Studio API. Independent Node integration tests start the real exported CRM and site, perform HTTP requests, stop the process, read the real private counters and verify the offline Ed25519 signature. This does not establish public HTTPS or production readiness.

## Limitations / next release gate

- Runtime counters can lose the last in-memory batch in a hard crash; they are not billing data or an audit trail.
- This release is not a live uptime monitor and does not process customer data into centralized analytics.
- Verify the Docker test on a disposable Linux runner before trusting it on a live VPS. Test the first deployment upgrade under load and verify off-server backups before using production client data.
- Public Caddy TLS and external HTTPS identity checks must run on an actual VPS.
- Use independently secured private publisher keys for signed upgrades; never place signing keys, `.env` or database backups in Git or exported ZIPs.
- An original R2.3 archive has not been integrated, so cross-branch compatibility cannot be asserted.
