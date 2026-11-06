# R4.0 — Authenticated PostgreSQL HTTP Preview

## Scope and limitations

**This is not a live replacement for SQLite.** Factory projects, their SQLite CRM implementations, sites, release management, and their existing endpoints still use SQLite. A separately imported, cryptographically signed PostgreSQL test copy is exposed through new owner-only preview endpoints. Tested only with synthetic records in dedicated loopback PostgreSQL. Do not point `PGDATABASE` at customer data or remove the hard test-name checks. No traffic switch or mirroring occurs.

PostgreSQL login uses the pinned `pg@8.16.3` driver. The `pg` import is lazy: standard SQLite startup does not require a PostgreSQL service, even if it has no installed dependencies. For the opt-in route, run `npm install`.

## Four engineered blocks

1. **Boot gate & provenance:** `OX_R40_PG_PREVIEW=YES`, loopback PGHOST/PGHOSTADDR, exact `ox_test_factory_r40` database, limited PGUSER and independently trusted signed migration manifest. Startup aborts on any missing or inconsistent parameter, invalid key, privileged LOGIN role or PostgreSQL before 15. No fallback to an untrusted database.
2. **HTTP API:** GET list / single clients, POST create, PATCH allowlisted fields, POST atomic batch (maximum 10). Parameters are `$1...` bindings, input fields and result rows are fixed and bounded. No SQL editor or caller-controlled schema. Writes require Studio session CSRF; all methods check real Studio ownership and the `clients` module. A cross-tenant request fails before opening a PostgreSQL connection.
3. **Transactions and isolation:** use signed NOLOGIN reader/writer tenant roles, `BEGIN READ ONLY` for GET, bounded local timeouts, `SET LOCAL ROLE` and tenant `search_path`, `COMMIT` on success and `ROLLBACK` after any failure. Batch validates each entry inside the transaction; later invalid input rolls back earlier writes. The dedicated login is NOINHERIT and never superuser.
4. **Real Linux CI:** PostgreSQL 15/16 service containers, pinned `pg` driver, deterministic synthetic studio + two CRM SQLite files, Ed25519 export/import + ACL activation, non-superuser login and HTTP server startup. Tests check real GET/POST/PATCH, CSRF, foreign tenancy, 2-row atomic insert, forced mid-batch rollback, SQLite source immutability and SQL role privileges. Every test is on the ephemeral DB only.

## HTTP API examples (test only)

The operator must first create a separate synthetic signed bundle and verified PostgreSQL database using the migration tools and grant its tenant roles to a dedicated NOINHERIT test LOGIN. Do not use the administrator or `postgres` LOGIN for the preview HTTP runtime. `PGPASSWORD` is a secret; never commit it to a repository or include it in logs. Use SSH tunneling if the PostgreSQL test service is on another machine.

```bash
# CI provisions synthetic Postgres and credentials automatically. For a test-only
# already-prepared local deployment (never use production data):
export OX_R40_PG_PREVIEW=YES
export PGHOST=127.0.0.1 PGPORT=5432 PGDATABASE=ox_test_factory_r40
export PGUSER=ox_r40_runtime
# Supply PGPASSWORD securely from your environment/secret manager.
export OX_R40_PG_BUNDLE=/private/test-only/signed-export
export OX_R40_PG_TRUST_KEY=/private/trusted-public.pem
npm install
node server.mjs
```

The new endpoints live under `/api/studio/pg-preview/projects/:projectId/clients`. Authenticate through the **existing Studio session**. For POST/PATCH set `Content-Type: application/json` and `x-csrf-token` from `/api/studio/session`. Values returned by this preview must not be confused with the active SQLite CRM. The `status` response explicitly reports `primaryRuntime=sqlite` and `productionCutoverApproved=false`.

### GitHub Actions smoke test

[`.github/workflows/r40-postgres-http-preview.yml`](../.github/workflows/r40-postgres-http-preview.yml) installs the official psql client, launches two isolated PostgreSQL versions in a matrix, runs focused security tests, imports a fresh signed synthetic export, creates a restricted LOGIN role, starts the **real** factory HTTP server and verifies the adapter's transaction boundaries. Only non-sensitive JSON acceptance metadata is saved as a short-lived artifact.

### Explicitly excluded from production approval

- No switching the primary runtime; no application-wide PostgreSQL rewrite.
- No verification of production backup/migrations, disaster recovery, shared host certificates or public HTTPS.
- The signed migration's generic reader/writer roles cover imported schemas, not a least-privilege, table-specific production policy; the preview API uses only `clients`. Before commercial use, perform a separate role design and schema audit.
- Multi-tenant reads/writes are exercised only against synthetic tenants.
- Until a full client CRUD migration, login/session refresh, payment model and rollback have passed independent review, leave `OX_R40_PG_PREVIEW` disabled for real deployments.
