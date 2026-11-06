# OSMANX APP FACTORY R3.9 — Real PostgreSQL 15/16 Test Gate

**Scope:** harden and independently verify the PostgreSQL R13 Signed Transition Kit against **ephemeral PostgreSQL 15 and 16**. This is a *non-production, synthetic-data integration gate*, not a runtime cutover. Factory/CRM/site servers continue to use SQLite. No existing SQLite storage or tenant secrets are modified.

## Four engineering blocks

1. **Explicit ephemeral target admission:** `guardEphemeralPostgres` requires `--confirm-synthetic`, `OX_R39_EPHEMERAL=YES`, `PGDATABASE=ox_test_factory_r39`, local `PGHOST`, a bounded TCP port, no service-file indirection and an empty database. Refuses all other targets before generating an export or contacting `psql`.
2. **Atomicity and signed data transfer:** generate the existing R13 synthetic SQLite studio + two projects, export and SHA-256 verify all SQL, create ephemeral Ed25519 keys, sign and independently verify the bundle; inject `SELECT 1/0` *after* streaming all schema DDL under PostgreSQL `--single-transaction`. Verify all schemas rolled back, then import the genuine signed bundle and verify every table in a consistent target snapshot. Explicitly reject unconfirmed and repeated imports.
3. **Actual tenant privilege tests:** activate the signed ACL plan and run 30 real SQL probes under PostgreSQL `SET LOCAL ROLE`: separate readers/writers for studio + two projects; allow own-schema reads and writer no-op updates, forbid cross-schema reads, reader updates and schema CREATE. Check the server error really is `permission denied` rather than accepting a syntax error. Complete the read-only signed readiness assessment.
4. **Reproducible CI and reporting:** workflow `.github/workflows/r39-postgres-15-16-acceptance.yml` uses real PostgreSQL 15 and 16 service containers, installs `psql`, executes security unit tests and the full synthetic acceptance script. Upload only a sanitized JSON report, never customer data or signing keys. Private signing keys and synthetic exports are created under an OS temp directory and deleted in `finally`.

## GitHub workflow

Run on pushes to migration/tooling changes or manually from GitHub Actions. Successful green checks on *both* PostgreSQL versions are required before calling this R3.9 gate complete.

Manual **test-only** run (never use with a customer database):

```bash
# Create an EMPTY, dedicated *ephemeral* PostgreSQL 15+ database named ox_test_factory_r39.
# Connect only to a local test server; no externally exposed port.
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGDATABASE=ox_test_factory_r39
# PG credentials must be supplied securely in your shell, not committed to GitHub.
export OX_R39_EPHEMERAL=YES
npm run test:r39
npm run pg:e2e:r39
```

The test leaves synthetic objects in its ephemeral database; discard the test container afterwards. It does **not** drop any database and cannot switch the product's active runtime.

## Acceptance boundaries

- No production or externally hosted database, real customer data, or private migration credentials.
- No PostgreSQL-backed HTTP API or SQLite-to-PostgreSQL live cutover. `postgresRuntimeEnabled=false` and `productionCutoverApproved=false` remain mandatory.
- A green *synthetic* verification is necessary but not sufficient for deployment. Before switching databases: implement and review tenant-scoped async runtime queries, maintain a tested rollback, migrate a **stopped** consistent backup from the **actual production version**, and separately verify HTTPS, disaster recovery and data compliance.
