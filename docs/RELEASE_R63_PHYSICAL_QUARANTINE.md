# OSMANX APP FACTORY R6.3 — physical backup and permanent rejoin quarantine

**Status: DRAFT — disposable test infrastructure only. No live production
operation, main merge, automatic promotion, old-primary rejoin or customer data
restore. No industrial zero-RPO or PITR certification.**

Base: R6.2 commit d149ea06d9e4d4bf9e060e1b51294c92bb99efc9.
R6.2 had five passing CI jobs (4 PG15/16×Node22/24 plus actual
COMPLIANCE MinIO fork) but its two physical partition jobs failed with
an unhandled async pg.Pool idle socket error. R6.3 corrects this
and adds four independent reliability engineering packages.

## Block 1 — repair real partition handling

- src/migration/r63-pool-fault-guard.mjs catches and records bounded idle
  pool errors with timestamps and codes even if network tears down
  a connection after a COMMIT was submitted.
- Inherited tests/r62_partition_e2e.test.mjs attaches guards BEFORE
  severing the standby Docker network. Its PostgreSQL 15/16 drill
  still requires the old primary alive, the standby in recovery and
  a remote_apply COMMIT not acknowledged. It never promotes.
- An ambiguous COMMIT must be manually investigated, not rolled back
  or presented as an acknowledged success.

## Block 2 — PostgreSQL WAL timeline anti-rejoin

- src/migration/r63-timeline-rejoin.mjs reads pg_control_system()
  and pg_control_checkpoint() from both actual PostgreSQL nodes.
- Validates system ID, timeline ID, checkpoint LSN, recovery state and
  observation timestamp; classifies old primary stale, possible dual
  primary, foreign cluster, selected primary behind and ambiguous states.
- The actual PG15/16 CI scenario reads pre-failure control states,
  kills only the disposable primary, promotes the test standby,
  forces a checkpoint and compares actual WAL timelines.
- A pre-failure snapshot is NOT proof of physical STONITH/BMC fencing.

## Block 3 — durable, immutable PostgreSQL quarantine

- ops/r63/quarantine-schema.sql creates per-tenant/cluster node evidence
  with triggers that reject UPDATE/DELETE and PUBLIC privileges revoked.
- src/migration/r63-pg-quarantine.mjs performs idempotent case creation,
  row-locked concurrent reviewer writes and per-case HMAC-SHA256 chain
  verification with an external signing key.
- Tests use two real PG pools, verify only one append per duplicate
  review, immutable SQL triggers, exact chain and forbidden rejoin.
- Superusers can bypass PG triggers: independent WORM key custody remains
  a separate production acceptance requirement.

## Block 4 — full physical backup, verification and independently booted PG

- src/migration/r63-physical-backup-evidence.mjs signs exact
  PostgreSQL backup_manifest SHA256, source system ID, timeline,
  WAL position and canonical checkpoint digest using offline Ed25519.
- Real PG15/16 scenario executes pg_basebackup -Fp -Xs into a new
  Docker volume, runs real pg_verifybackup (including WAL scan),
  copies the physical data to another separately initialized
  volume and actually boots a second PostgreSQL server.
- The restored system identifier, timeline and entire pending/
  committed checkpoint state must match the signed source state.
- This validates a physical backup with bundled WAL, NOT external
  WAL archive PITR, customer data backups, offsite durability or RPO.

## Block 5 — five-source read-only operator review

- src/migration/r63-manual-rejoin-review.mjs rechecks two independently
  signed old-primary observer packets, two independent human
  security/reliability approvals, timeline, persistent quarantine,
  signed physical backup and pinned CI evidence.
- Wrong commit, stale/fake signer, changed restored checkpoint,
  missing quarantine or unresolved timeline disables lab readiness.
- CI reports must ALSO be verified independently by the R6.0 source
  adapter. A self-supplied CI object is not external certification.
- Every branch permanently returns NO permissions for pg_promote,
  pg_rewind, old-primary rejoin, quarantine clearance, production
  deployment, main merge, live customer restore or zero-RPO claims.

## Actual automated CI

.github/workflows/r63-ha-quarantine.yml has eight jobs:
- PG15/16 x Node22/24: five R6.3 modules, two-process PG
  quarantine tests and inherited R6.2 signatures/network guards.
- PG15/16: real pg_basebackup, pg_verifybackup, separate physical
  restore, followed by a killed former primary, controlled promotion
  and real timeline comparison.
- PG15/16: a physically partitioned Docker replica, idle-socket
  error observation and fail-closed synchronous COMMIT.
These are disposable real PostgreSQL containers, not production systems.
A job is not accepted until its exact latest-commit CI status is green.

## Blockers before any real customer release

Independent physical STONITH/BMC, quorum under network splits,
proper replica rebootstrap/failback, real archived-WAL PITR with
target-time recovery, offsite backup custody, provider-specific IAM,
separate WORM witness, production PostgreSQL roles, audited signing
keys, human approval of real GitHub evidence and full security review.
No atomic transaction spans SQLite, PostgreSQL, S3 and witness.
Zero-RPO is not certified by this synthetic laboratory.

No production data or current service has been altered.
