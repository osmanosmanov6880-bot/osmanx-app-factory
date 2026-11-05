# OSMANX APP FACTORY R3.5: isolated release gates and opt-in fleet evidence

**Branch status:** local engineering preview, constructed on the earlier R1.3 source plus R2.4-R3.5 changes. The original R2.3 archive was not available, so its functionality has not been independently reconciled. The package runtime still identifies itself as `1.3.0` rather than pretending to be an official production 3.5.0 release. OBSIDIAN styling remains unchanged.

## Implemented engineering blocks

### 1. Deterministic regression boundary

- `scripts/r35_regression.mjs` runs each Node test file in a fresh, bounded child process. It checks **both TAP counts and actual process exit**, refusing a green TAP result that leaves a hanging process.
- A watchdog stops timed-out tests and their subprocess group (Unix). The first failure ends the sequence. JSON results contain per-file counts, exit codes, elapsed times, timeouts, and a bounded diagnostic tail on failure.
- `npm run test:isolated -- --out=/private/r35-regression.json` is suitable for local and CI use. `npm test` remains the original shared runner for cross-checking. The exact cause of prior sporadic test-runner stalls was not conclusively determined.

### 2. Explicit signed Docker/HTTPS snapshots

- Existing offline `fleet-agent.mjs snapshot` still emits the backward-compatible **v1** format; no network or Docker call is made.
- Only if an administrator invokes `snapshot --docker` and/or `snapshot --live` are the requested checks executed by the existing deployment doctor. The signed **v2** protocol records exactly which checks were requested, and the factory refuses reports that claim unrequested checks succeeded.
- `--docker` verifies Docker Compose **configuration**, not real service uptime. `--live` checks public HTTPS and the installed project/release identity, with TLS validation and network restrictions inherited from `verify-live.mjs`.
- The private Ed25519 key and report files remain outside customer exports, Git, Docker images and browser APIs. An output directory symlink that would redirect the report into the installation is refused.

On the client VPS (after owner-controlled setup):

```bash
node deploy/fleet-agent.mjs init --confirm
node deploy/fleet-agent.mjs public
node deploy/fleet-agent.mjs snapshot --out=/private/ox-status.json
# Optional explicit network/Compose checks (no automatic scheduling):
node deploy/fleet-agent.mjs snapshot --docker --live --out=/private/ox-status-checked.json
```

### 3. Tenant-isolated installation portfolio

- Authenticated owner endpoint: `GET /api/studio/fleet`. It returns up to 100 of that owner's projects with the age of their last manually imported signed report, detected release rollback, and requested HTTPS evidence. No customer records, keys or backend hostnames are included.
- The existing OBSIDIAN deployment wizard contains a **manual** `All installations` button; it does not poll any clients or collect telemetry in the background.
- Reports from v1 and v2 remain readable. Historical release regressions are surfaced as `rollback`, and check evidence becomes stale after one hour. Owner permissions and replay checks remain enforced.

### 4. Docker failure handling and reproducible CI

- `scripts/r34_docker_fleet_e2e.mjs` now attempts cleanup even when `docker compose config` or `docker compose up` fails. A cleanup failure is **fatal** and retains the temporary synthetic Compose directory for operator inspection.
- New regression tests simulate Docker build failures and cleanup refusal without claiming that a real Docker daemon ran.
- `.github/workflows/r35-isolated-release-acceptance.yml` declares offline fail-closed regression followed by isolated Docker CRM/site and signed update/rollback tests on `ubuntu-24.04`. It is committed only when the user publishes this source to their GitHub repository; workflow presence is **not proof of a completed job**.

## Verification

```bash
npm run check
npm test
npm run test:isolated -- --out=/private/r35-regression.json
python3 tests/ui_r35_fleet_static.py
npm run samples:r35 -- /private/r35-client-exports
npm run verify:samples:r35 -- /private/r35-client-exports
npm run acceptance:r35 -- --out=/private/r35-local-acceptance.json
```

No public VPS has been altered by this preview, and no deployment, public TLS certificate issuance, external service delivery, third-party security audit or production-readiness assessment is claimed. Tests use only generated synthetic business data.
