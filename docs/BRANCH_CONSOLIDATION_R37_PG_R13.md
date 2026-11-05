# OSMANX APP FACTORY — Consolidated Preview R3.7 + PostgreSQL R13

**Status: offline merged preview; not a production PostgreSQL migration and not official R3.8/v0.25.0.**

## Provenance and comparison

- Both branches are derived from the R1.3 SQLite codebase. The supplied PostgreSQL archive has 201 files; R3.7 has 332.
- 174 files are byte-for-byte identical. There are 14 common files with differences; **the R3.7 versions were preserved** (server API, studio database schema, deployment code and UI).
- 13 PostgreSQL-exclusive source, scripts, tests and docs files were added unchanged.
- PostgreSQL CLI scripts from the other package were added into the R3.7 package.json. The runtime server, ORM, databases and web routes were not switched.
- Other 144 R3.7-exclusive files remain in the package.

## Verified locally

1. PostgreSQL original archive: 64/64 Node.js tests.
2. Probe merge: `npm run check` success; `npm test` run as `node --test --test-concurrency=2 tests/*.test.mjs` **171/171**, exit code 0.
3. `npm run test:pg` equivalent: 33/33 PostgreSQL-focused tests.
4. `pg:demo` wrote a synthetic manifest representing 3 databases / 25 tables; `pg:verify` succeeded.
5. `pg:keygen` + `pg:sign` + `pg:verify-signature` succeeded on synthetic data with an externally held Ed25519 identity. The private key was deleted after testing.
6. Local syntax checks succeeded; no live PostgreSQL/psql/Docker engine available in the environment.

## Operative boundaries

- The **live server still uses `node:sqlite`**. Exporting SQL and verifying offline data is **not** switching the application to PostgreSQL.
- `src/migration/pg-tenant-adapter.mjs` is a prototype abstraction with an injected external pool, not the application's live API database layer. The `pg` driver is not installed.
- Do not apply migrations to actual customer databases or import into a populated PostgreSQL database on the strength of mock tests.
- Do not commit SQL exports, migration manifests containing row hashes, actual personal records, signing private keys, `.env`, SQLite files or snapshots. Place sensitive material on an encrypted drive.
- GitHub Actions workflows in this preview have not been validated on a real hosted Docker runner. A green local Node.js suite is not a production SLA.
- The consolidated package does not include and does not impersonate the original v0.25.0 source, which is not available here.

## What to do next

1. Create exactly **one private repository** `osmanx-app-factory`, upload this source as an initial audited preview commit.
2. Assign one main integrator. In separate chats use feature branches (`feat/postgres-runtime`, `feat/deployment`) and merge through PRs + CI, not parallel blind zip edits.
3. First test PostgreSQL migrations on a brand-new disposable PostgreSQL 15+ instance. Run rollback and tenant isolation, verify signatures and schema hashes.
4. Integrate the PostgreSQL adapter with HTTP server in a feature branch; retain SQLite as fallback until a full dual-database test and backup/restore pass.
5. After GitHub CI passes on actual Linux/Docker, review security, key handling and privacy before any production rollout.

## Quick local checks

```bash
npm run check
npm test
npm run test:pg
npm run pg:demo -- --out /path/outside/git/synthetic-pg-kit
npm run pg:verify -- --in /path/outside/git/synthetic-pg-kit
```

Note: Node.js >=22.16.0 is required. The generated SQL contains no real data only if `pg:demo` is used; `pg:export` of actual data is sensitive.
