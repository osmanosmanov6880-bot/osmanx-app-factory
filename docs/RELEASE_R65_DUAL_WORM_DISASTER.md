# OSMANX APP FACTORY R6.5 — dual WORM laboratory WAL custody, full source loss and measured synthetic RPO

**DRAFT ONLY. Entire system is a synthetic disaster laboratory.**
**No production WAL may be uploaded with this version: test-object payloads
are not yet encrypted. All hosted MinIO experiments use disposable data.**
No company database, service, deployment, customer SQLite, real credentials,
main merge or actual failover has been altered.

Base: R6.4 PR #24 / commit 95a8d13f14160f2bff57efe4d47bca2723bc9545.
All R6.4 8/8 CI checks passed for the last commit, including PG15/16
archive PITR and rebootstrap. R6.5 work is separate.

## 1. Two real independent WORM custody processes

- Existing allowlisted SigV4 S3 transport adds *only* the new content-
  addressed key pattern r65/wal/<SHA256>.seg. All other object names denied.
- src/migration/r65-dual-worm-custody.mjs requires two distinct origin
  URLs, tenant prefixes, S3 keys and store identities.
- It rereads actual 16 MiB source WAL segments, uploads immutable PUTs,
  checks GET bytes and matching immutable version ID, then inspects the
  actual provider's future Object Lock COMPLIANCE retention.
- For detached restore it rereads BOTH provider copies, independently
  checks versions, ETags, SHA-256, object lock, and matching bytes.
  A deleted, missing, overwritten or superseded version fails closed.
- It reconstructs only into a newly created directory; it never
  overwrites any existing PostgreSQL WAL volume.
- Two MinIO containers on one CI runner are two independent processes
  and storage directories, **not independent regions**. Real offsite
  custody and encryption at rest must be added before production.

## 2. Cryptographically signed dual-version WAL bundle

- src/migration/r65-dual-wal-bundle.mjs signs canonical WAL inventory,
  exact content digests, both retained S3 version IDs, ETags and tenant,
  the source physical backup manifest SHA, incident and target WAL LSN.
- It requires two distinct custodians on every WAL segment, fresh
  COMPLIANCE retention, a bounded number of WAL segments and a short
  Ed25519 manifest validity period.
- Altering one receipt, changing a source SHA, dropping a store, using
  a wrong tenant or replaying an expired signature is rejected.
- Signature validation does not assert live availability: download
  and exact provider HEAD must be repeated independently.

## 3. Source destruction then real detached PITR

- tests/r65_disaster_detached_restore.test.mjs uses disposable
  PostgreSQL 15 or 16. It creates a full official pg_basebackup and
  validates it with pg_verifybackup, generating a distinct physical
  backup volume.
- It commits 20 synthetic ledger transactions, records each ACK and
  WAL position, chooses the end of transaction 12 as PITR target, then
  archives WAL and uploads it to BOTH COMPLIANCE MinIO buckets.
- The source PostgreSQL container and its anonymous data volume are
  physically deleted; the local source /archive directory is removed.
- Recovery re-fetches both retained WORM copies, seals a detached
  WAL directory, creates a new physical restored PostgreSQL volume,
  invokes recovery_target_lsn and checks the restored timeline.
- The target database MUST contain sequences 1..12, but not 13..20.
  Test also requires the old PostgreSQL container to remain absent.
- The physical backup volume remains available on the SAME CI runner.
  This is **source database/container/storage loss**, not loss of
  the host machine or the remote physical backup site.

## 4. Measured acknowledged PostgreSQL loss, not imaginary zero RPO

- ops/r65/synthetic-ledger.sql and
  src/migration/r65-synthetic-rpo.mjs record and validate consecutive
  ACK IDs, payload SHA-256, post-commit observed WAL LSNs and timestamps.
- The verifier reads the actual restored PostgreSQL ledger. It rejects
  missing middle transactions, forged or duplicated data, transactions
  beyond the recovery target and nonmonotonic ACK/LSN observations.
- It reports acknowledged count, restored count, missing ACKs,
  last recovered source sequence, ACK time gap, and disaster-to-restore
  wall time. A deliberately selected target after sequence 12
  is expected to show **8 lost synthetic acknowledgements**.
- This experiment does not observe actual SQLite COMMIT, end-to-end
  app-to-S3 delivery, a full production workload or multi-region outages.
  Its result does NOT establish an industrial RPO SLA or zero data loss.

## 5. Signed two-human, two-S3 readiness review

- src/migration/r65-disaster-readiness-gate.mjs verifies the Ed25519
  archive bundle, downloads BOTH real S3 copies a second time,
  recalculates acknowledged loss, and verifies two distinct offline
  security/reliability reviewer signatures from R6.1.
- Forged remote object bytes, wrong version, wrong tenant, lost ACK
  sequence, revoked human signer or missing source-loss evidence
  rejects even the internal synthetic readiness flag.
- Human-only review never authorizes pg_promote, pg_rewind, S3 writes,
  clearance of pending intent, old leader rejoin, deployment, main merge,
  industrial zero RPO or any customer restore.
- Source-process destruction is still lab-supplied evidence, not an
  independently verified offsite loss witness.

## CI verification and remaining blockers

.github/workflows/r65-dual-worm-disaster.yml checks:
- PG15/16 × Node22/24: four unit/security and inherited PG tests.
- One real **two-process** MinIO COMPLIANCE retention/anti-tamper test.
- PG15/16: real full source PostgreSQL+local WAL destruction, actual
  two-MinIO independent recovery, selected PITR and 20-ACK loss counting.

**Do not call R6.5 accepted until all seven latest-commit jobs are SUCCESS.**

Production blockers: customer WAL envelope encryption and external
key custody; actual offsite independent S3 providers, geographic
failure-domain separation and IAM deny tests; independent witness
audit and hardware fencing; replicated encrypted physical basebackup;
real source SQLite COMMIT-to-S3 latency and delivery loss bounds;
access-control review; production-grade STONITH/quorum and
independent human safety signoff. Zero RPO remains NOT certified.
