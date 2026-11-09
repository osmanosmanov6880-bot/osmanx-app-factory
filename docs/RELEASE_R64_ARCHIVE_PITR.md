# OSMANX APP FACTORY R6.4 — real archived-WAL PITR and safe rebootstrap laboratory

**DRAFT. Zero live credentials, no production environment changes and no
automatic failover, leader promotion, old-primary rejoin, customer restore,
main merge or zero-RPO certification.**

Base: R6.3 commit 4dfc6a3aeb3fc97cbe3518c6410c8fb63fd9a30c,
with PG15/16 physical backup, timeline and Docker partition CI green.

## 1 — Complete, signed WAL archive custody

The R6.4 WAL inventory module (src/migration/r64-wal-archive.mjs) validates
full 16MiB PostgreSQL WAL segment bytes, strict 24-hex filenames,
same timeline, contiguous numeric WAL segments, LSN coverage,
SHA256 of every independently read segment, and a short-lived
Ed25519 signature over a tenant/system ID/base-backup-bound manifest.

It rejects truncated/missing/foreign timeline/duplicate/noncontiguous
archive objects, invalid signatures, expired inventory and cross-tenant
readback. A signed archive list by itself does NOT prove offsite WORM
custody, successful PostgreSQL restore or complete WAL retention.

## 2 — Genuine PostgreSQL archived-WAL named-target PITR

The disposable PostgreSQL 15/16 script at ops/r64/pitr-lab-setup.sh
creates a fresh, explicitly acknowledged Docker network and three
new volumes, configures archive_mode=on and a separate pg_basebackup
replication account, and refuses to reuse existing Docker resources.

tests/r64_pitr_target.test.mjs creates a synthetic table and baseline
event, takes a physical pg_basebackup with streamed WAL, runs
pg_verifybackup, commits a NEW event after backup, creates a named
pg_create_restore_point, commits another event after that target,
and forces WAL archival. It checks full segment checksums against a
signed R6.4 inventory BEFORE starting recovery.

A separately initialized PostgreSQL server receives the physical base
copy plus archived WAL via restore_command and recovery_target_name.
The independent verification module queries both real PostgreSQL
instances and requires:
- the source contains BOTH new commits;
- the restored instance contains the pre-target commit made AFTER
  the base backup;
- the restored instance does NOT contain the post-target commit;
- the PostgreSQL system identifiers match, the restored instance
  has actually completed recovery, and the full archive was verified.

A basebackup-only test or recovery past the requested target fails closed.
The deliberate exclusion of a post-target event is a TEST RESULT,
not proof of lossless customer-data recovery.

## 3 — Safe follower rebootstrap after old-primary fencing

src/migration/r64-rebootstrap.mjs checks observed former-primary state,
the promoted PG timeline, system ID, a distinct node identity and
a post-bootstrap WAL-replayed transaction. The former primary is NEVER
restarted in place or allowed to clear its old R6.3 quarantine.

tests/r64_rebootstrap.test.mjs exercises an actual isolated
PostgreSQL 15/16 source+replica: stop the former primary, promote the
standby, make a NEW physical pg_basebackup FROM THE PROMOTED NODE,
start a clean read-only streaming follower, then insert a new
transaction and verify its WAL replay on that follower.

This is NOT production fencing; Docker SIGKILL observations do not
certify an external STONITH/BMC or quorum system.

## 4 — Signed, measured recovery envelope (synthetic RTO/event count)

src/migration/r64-recovery-budget.mjs signs the exact WAL inventory,
backup digest, restore point, independent reporter, source/recovered
transaction counters and elapsed restore time with Ed25519.
The real PITR test queries both PG databases for counts rather than
inventing metrics; an expected one-event exclusion after the target
is explicitly represented. Exceeded budget, missing event,
altered receipt or expired signature fails closed.

These are laboratory restore milliseconds and synthetic excluded
event counts. The data is NOT an industrial RTO SLA, time-based RPO
assessment, zero-RPO certification or measured customer transaction
loss. Offsite encryption/retention custody remains unverified.

## 5 — Unified, human-only recovery review and full CI

src/migration/r64-isolated-recovery-review.mjs RE-verifies WAL file bytes
and signatures, independently queries source/restored PG, verifies the
signed lab budget, recomputes the rebootstrap evidence and validates
two distinct Ed25519 security/reliability approvals from R6.1.

It always returns false for production cutover, pg_promote,
old-primary rejoin, quarantine clearance, S3 writes, customer restore,
main merge, public deploy and industrial zero-RPO claims. Even a green
lab gate is not a source of CI provenance unless independently verified
with the existing R6.0 authenticated GitHub run adapter.

.github/workflows/r64-archive-pitr.yml contains 8 real jobs:
- PG15/16 x Node22/24: new cryptographic modules, negative tests
  and actual R6.3 immutable PG quarantine regression.
- PG15/16: separate archive_mode=on primary, physical pg_basebackup,
  real WAL archival, named-target PITR and source-vs-restored proof.
- PG15/16: actual former-primary SIGKILL, promoted replica, new
  pg_basebackup and post-bootstrap streaming replay.

Every existing container/volume/network name must be absent before
the tests start. A failed job fails CI; external runners are isolated
and cleanup removes only explicitly named disposable assets.

## Not yet accepted for production

Real multi-site PostgreSQL HA with independent power fencing,
archived WAL offsite WORM retention and disaster retention policies,
full system/application restore, tenant-consistent SQLite/PostgreSQL/S3
reconciliation, compromised-credential and network partition hardening,
human key custody, CI provenance independently confirmed with live
GitHub API, security review and approval before customer data access.

Do NOT merge to main or turn on automatic failover on the basis of
these tests. Industrial RPO and RTO remain uncertified.
