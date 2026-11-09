# OSMANX APP FACTORY R6.4 — archived-WAL PITR, rebuilt replica, signed receipts

**DRAFT, SYNTHETIC-ONLY. No production deployments, main merge,
real customer restoration, backup deletion or automatic leader change.**

Base: R6.3 Draft PR #22, commit 4dfc6a3aeb3fc97cbe3518c6410c8fb63fd9a30c.
R6.3 finished 8/8 success on PostgreSQL 15/16 (physical basebackup,
promoted timeline, network partition and full negative-control matrix).

## Package 1 — archived WAL byte-integrity and signed inventory

- src/migration/r64-wal-archive-evidence.mjs reads each real WAL file
  from a fixed local disposable archive directory using a SHA-256 stream.
- Bounded count/size, strict WAL names, no symlinks, inode and mtime
  stability, unique adjacent WAL segments per timeline and a second
  filesystem reread before evidence acceptance.
- An offline Ed25519 signature binds tenant, PostgreSQL system ID,
  selected LSN, base backup manifest SHA-256 and each local WAL digest.
- Missing/tampered/truncated files, forged keys, invalid scope and
  expired signed inventory fail closed.
- These files are NOT an offsite immutable WORM archive. The observed
  filenames do NOT independently prove every historical WAL byte exists.

## Package 2 — actual target-LSN point-in-time restore from archived WAL

- ops/r64/pitr-lab-setup.sh creates an isolated PostgreSQL primary
  with archive_mode=on, a local-only host-mounted /archive volume and
  archive_command that refuses to overwrite existing files.
- tests/r64_pitr_recovery.test.mjs runs pg_basebackup -Fp -Xs,
  checks real pg_verifybackup, then commits a selected transaction and
  a *later* transaction after basebackup, recording the intervening LSN.
- It forces PostgreSQL to archive the relevant WAL segment. A separately
  booted PostgreSQL cluster receives an isolated physical copy, a
  read-only archive mount, recovery.signal and recovery_target_lsn.
- recovery_target_action=promote is **ONLY** used inside this isolated
  recovery test container. It cannot touch production. The restored
  database must contain baseline + selected, but not the later
  acknowledged transaction.
- The system ID must match the original and the recovered PG instance
  must be on a newer timeline.
- This is a targeted archived-WAL PITR lab test, not externally certified
  recovery of the entire user service or proof of an operational SLA.

## Package 3 — safe rebootstrap as a fresh read-only replica

- src/migration/r64-rebootstrap-review.mjs performs read-only
  system-id/timeline, hot-standby mode and exact WAL replay comparison.
- tests/r64_rebootstrap.test.mjs kills the *disposable* old primary,
  explicitly promotes the test standby, creates a **brand-new** volume,
  runs pg_basebackup -R against the promoted node and starts a new
  standby in recovery mode. It verifies actual probe data and the
  pending fenced checkpoint before refusing writes on the new follower.
- It does NOT run pg_rewind, wipe or rejoin the old data directory,
  issue live VIP changes, or unquarantine any original production node.
- External physical power fencing, fleet quorum and split-brain
  arbitration must be validated separately.

## Package 4 — signed evidence of recovered vs excluded transactions

- src/migration/r64-pitr-boundary.mjs validates an offline Ed25519
  receipt bound to the exact target LSN, later committed LSN, system ID,
  archive SHA-256, base backup and tenant/incident.
- The receipt requires the original source database to show all three
  acknowledged synthetic markers. Its restored peer must show exactly
  the pre-backup marker and the pre-target transaction, and must *not*
  show the acknowledged transaction committed later.
- Any missing selected transaction or unexpectedly present later
  transaction invalidates the receipt.
- This demonstrates selected point-in-time boundary behavior for three
  synthetic transactions only. The post-target loss is intentional,
  not an RPO estimate; unknown customer writes are not counted.
- Tests include signature forgery, missing markers, expiry and wrong
  archive/tenant/target.

## Package 5 — independently rechecked human-only recovery gate

- src/migration/r64-recovery-review-gate.mjs calls the actual WAL
  and PITR signature verification functions, read-only PostgreSQL
  replay verification, an R6.3 quarantine inspection and two separate
  R6.1 Ed25519 operator approvals.
- It rejects identity, WAL version, recovered data, quarantine branch,
  signature, epoch and human reviewer mismatches.
- A green lab result only means the evidence package is internally
  coherent and suitable for independent HUMAN review.
- External GitHub CI provenance, hardware fencing, offsite WAL custody
  and operational production PITR are explicitly **not certified**.
- All results permanently keep promotion, rejoin, unquarantine, S3
  writes, real customer restore, main merge and deploy disabled.

## Actual CI requirements

.github/workflows/r64-pitr-rebootstrap.yml has 8 independent jobs:
- PostgreSQL 15/16 x Node.js 22/24: negative/security/reviewer tests,
  actual PostgreSQL quarantine SQL and inherited cryptographic checks.
- PostgreSQL 15/16: real local WAL archive, pg_basebackup, pg_verifybackup,
  target-LSN restore and selected/excluded commit assertions.
- PostgreSQL 15/16: real killed-primary / promoted-standby,
  new-volume pg_basebackup -R and verified read-only rebuilt follower.

The exact CI result must be verified at the PR's latest SHA. A queued,
skipped or failing real-provider job does not count as acceptance.

## Real production blockers

- Independently operated BMC/STONITH and quorum fencing.
- Offsite immutable WAL archiving, checksums with independent custody,
  WAL retention, target-time restore drills and realistic workload tests.
- Verified production PostgreSQL roles, rebootstrap/failback runbooks,
  actual S3 IAM denies and external witness evidence.
- End-to-end source SQLite commit-to-archive completeness measurement,
  independent CI evidence attestation and external security review.
- No distributed atomic transaction exists across SQLite COMMIT, PG,
  S3 and witness; industrial zero-RPO is not certified.

No existing main branch, customer database or active service is modified.
