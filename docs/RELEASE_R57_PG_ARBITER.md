# OSMANX APP FACTORY R5.7 — PostgreSQL checkpoint arbitration

**Status: DRAFT, synthetic only. Do not merge into main or deploy.**

The R5.6 local promise queue could serialize one Node process, not two
independent hosts. R5.7 moves the authorization timeline to one shared
PostgreSQL row per opaque tenant and persists S3 write intent **before**
the conditional S3 call. This is *not* a cross-service ACID transaction.

## Five delivered engineering packages

1. **R5.6 CI repair:** replace `npm ci` (no package-lock exists) with
   `npm install --ignore-scripts` until an independently approved lockfile
   is committed. Earlier R5.6 CI failures occurred before tests started.
2. **Persistent PostgreSQL arbiter:** `ops/r57/schema.sql` and
   `src/migration/r57-pg-coordinator.mjs`. `SELECT ... FOR UPDATE`,
   server-side `clock_timestamp()`, epoch and lease identity checks,
   persisted pending intents, CAS preflight, immutable S3 version evidence,
   idempotent confirmation and fenced recovery. Separate process A cannot
   take over if process B left an unresolved S3 intent.
3. **S3 privilege separation:** `src/migration/r57-s3-scope.mjs`
   returns tenant-prefix-checked interfaces for encrypted segment writes
   and conditional pointer writes. It also generates *proposed* narrow
   IAM policies for the two roles. Nothing has been applied to cloud IAM.
4. **Adversarial acceptance:** separate PostgreSQL pools and actual
   OS-process contenders, blocked PUT past lease expiry, crash before/after
   PUT, lost response after durable receipt, strict CAS conflict, missing
   WORM retention and cross-tenant / S3-capability denial tests.
5. **Real-storage acceptance:** `.github/workflows/r57-pg-arbiter.yml`
   runs PG15/16 and Node22/24 synthetic fault tests plus PG15/16 with
   a disposable COMPLIANCE-enabled MinIO; the latter exercises
   SQLite CDC -> encrypted offsite segments -> signed remote pointer ->
   independent witness -> lost PUT reply -> recovery.

The opt-in `runR56CoordinatorPublisher` can accept
`createR57PgCoordinator(...)` and the segment-only `publisher` adapter.
The isolated factory does not alter running SQLite or public services.

## Safety properties and boundaries

- The coordinator's **PostgreSQL** row lock works across instances and
  processes; there is no claim of global atomicity between PostgreSQL,
  S3, and the independent witness.
- An S3 PUT starts only after a durable `pending_op` intent commit.
  A new lease cannot be issued while `pending_op` exists.
- On uncertain outcomes, do **not** clear `pending_op` manually.
  Recovery only acknowledges a newly observed exact-hash WORM-locked
  version distinct from the previously recorded version. Other cases
  remain quarantined for operator investigation.
- On successful recovery the old lease is revoked before future writers
  may acquire the next epoch. Resumed old workers are fenced.
- A crashed or paused operation can remain ambiguous indefinitely;
  S3 and database failure domains cannot atomically cancel a remote
  request. An operator must investigate every object version and
  witness state rather than guess that a timeout means failure.
- The in-process S3 wrapper is **not** an IAM enforcement boundary.
  Worker direct `s3:PutObject` permission on `r53/head.json` must be
  denied by separately configured cloud IAM/credential policy. Tests
  validate policy generation only, *not deployment*.
- The R5.7 coordinator intentionally has no remotely authenticated
  production API, consensus failover control plane or signed operator
  clearing workflow. Database primary failover, clock anomalies,
  fencing on S3 network partitions, provider versioning consistency and
  restoration of lost PostgreSQL state are NOT independently certified.
- No customer data, real payment processing, production release,
  zero-RPO certification or `main` update.

## Running in a throwaway PostgreSQL 15/16 database

Set `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
to an isolated test database, and run:

```bash
npm install --ignore-scripts --no-audit --no-fund
psql -v ON_ERROR_STOP=1 -f ops/r57/schema.sql
OX_R57_E2E=YES node --test --test-concurrency=2 \
  tests/r57_pg_coordinator.test.mjs tests/r57_s3_scope.test.mjs
node --test tests/r56_coordinator.test.mjs
npm run test:r55
```

The real MinIO workflow additionally supplies disposable storage,
temporary credentials, `OX_R57_MINIO_E2E=YES`, and
`OX_R40_EPHEMERAL=YES`. Do not run on production databases/buckets.

## Required gates before any public cutover

- Require distinct S3 IAM credentials, enforce worker HEAD write denial
  at the provider, verify credentials with *negative* authenticated tests.
- Move coordination behind mTLS / authenticated service endpoints and
  pin one S3 prefix to one PostgreSQL tenant.
- Exercise PostgreSQL restart/failover during the in-flight S3 PUT,
  remote response loss, and provider partitions. Demonstrate consistent
  object versions, orphan investigation and safe operator unquarantine.
- Add independently signed release evidence, controlled incident drills,
  backup and restore of PostgreSQL arbitration state, review of outage RPO.
- Independent security and reliability review of branch and successful CI.

**Never equate a green synthetic test suite with production zero-RPO.**
