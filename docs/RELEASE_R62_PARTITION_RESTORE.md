# OSMANX APP FACTORY R6.2 — isolated network split, recovery and S3 fork drills

**DRAFT / experimental code only. No live production deployment.**

Base: R6.1 at commit f305d9d8074ce1860a8326333dd88f6cadd01c8c.
All previously accepted R6.1/R6.0/R5.9 modules remain untouched.
No changes are made to main, customer SQLite, production PostgreSQL,
production S3 IAM, real certificate authorities or public endpoints.

## Five full engineering work packages

### 1. Dual offline primary-fencing observations

- src/migration/r62-fence-evidence.mjs: two Ed25519-signed independent
  observations, roles fence-observer and standby-observer, distinct public
  keys and identities, maximum 60 seconds, tenant/cluster/incident/epoch
  and exact required WAL LSN, pending pointer SHA-256 and fresh challenge.
- An old primary that is merely UNREACHABLE over TCP is not regarded
  as powered off. The observer packet must explicitly say terminated,
  and standby replay must be verified.
- These are signatures on observations, NOT actual external hardware
  power fencing or split-brain certification. A synthetically signed
  statement is insufficient to permit any automatic promotion.

### 2. Fresh synchronous replay challenge + real partition

- src/migration/r62-sync-barrier.mjs and ops/r62/barrier-schema.sql:
  strictly isolated PostgreSQL remote_apply challenge insert, bounded
  SQL statement timeout and actual standby replay confirmation.
- A COMMIT acknowledgement can be lost after local WAL persistence.
  The returned diagnostic explicitly marks any timed-out COMMIT as
  potentially committed locally. It never assumes rollback or lets the
  caller clear an ambiguous S3 pending intent.
- tests/r62_partition_e2e.test.mjs starts the inherited disposable
  streaming PG15/16 cluster, successfully confirms a fresh challenge,
  disconnects the standby from its Docker network without killing the
  old primary, and checks that a new sync commit cannot be confirmed.
  The old primary remains alive; standby remains in recovery. No
  pg_promote command is issued in this network partition test.
- Docker network manipulation is confined to fixed, newly created
  test containers. Never run on a shared Docker daemon or production.

### 3. Signed logical checkpoint export and detached PostgreSQL restore

- src/migration/r62-restore-evidence.mjs: Ed25519-signed short-lived
  manifest binding tenant, source WAL position, exact SHA-256 of a
  bounded logical SQL dump and canonical checkpoint row digest.
- tests/r62_restore_e2e.test.mjs uses the actual PG15/16 pg_dump binary,
  then a second, separately initialized throwaway PostgreSQL server.
  It verifies the dump signature before feeding it to psql and compares
  every recovered leased/pending/committed checkpoint field with the
  source signed record. Wrong SHA, changed pending bytes, stale
  signatures and foreign tenants fail closed.
- A one-table logical export and restore is NOT WAL PITR, full cluster
  backup, full customer restore, cross-region replica health or
  proof of an industry-grade RPO. The API states these limits.

### 4. Versioned S3 COMPLIANCE anti-fork analyzer

- src/migration/r62-s3-lineage.mjs evaluates actual R6.0 forensic
  version inventory, committed predecessor, persisted pending digest,
  current/latest pointer and separately authenticated witness state.
- Classifications include coherent-manual-review, multiple retained
  candidates with identical hashes, superseded pointer, missing
  previous version, previous commit mismatch, unmatched pending
  digest and independent witness disagreement.
- All retrieved objects must have a currently valid future COMPLIANCE
  retention date. Incomplete/duplicate history, foreign tenant or
  altered candidate IDs are rejected.
- tests/r62_s3_lineage_minio.test.mjs writes three successive pointer
  versions to isolated actual MinIO with Object Lock COMPLIANCE and
  verifies that the third version is treated as a fork/supersession.
  No automatic database recovery or S3 rollback is authorized.

### 5. Five-source signed, read-only failover evidence gate

- src/migration/r62-failover-drill-gate.mjs recomputes two distinct
  offline fence signatures, the fresh WAL challenge, signed logical
  restore, versioned WORM lineage and two separately signed read-only
  operator approvals from R6.1. It also requires an R6.0-style
  CI-provenance report pinned to the exact commit and five sources.
- Missing stale barriers, wrong commit, S3 witness disagreement,
  tampered restore, forged observer statement or stale approval
  prevents even LAB evidence completeness. A successful synthetic
  gate only means the review package can be examined by humans.
- It always emits canPromotePg=false, canClearPending=false,
  canMutateS3=false, canRestoreCustomerData=false,
  deployAllowed=false, mainMergeAllowed=false and
  industrialZeroRpoCertified=false.

## GitHub Actions verification

.github/workflows/r62-partition-restore.yml executes:

1. Four PG15/16 x Node22/24 unit and signature regression jobs,
   including genuine R6.1 two-process PG review tests.
2. Two isolated PG15/16 physical cluster jobs with fresh WAL
   challenge, signed dump restore to a separate database server,
   then deliberate Docker standby network partition.
3. One actual WORM MinIO version history/fork test using a pinned
   MinIO server image and a fresh seven-day COMPLIANCE test bucket.

The exact test status belongs to the attached GitHub Actions run.
Do not claim success until all seven jobs complete successfully.

## Explicit certification and shipping blockers

- External STONITH / BMC power-off validation from independent hosts.
- Full PostgreSQL PITR (WAL archive from a previous recovery point),
  negative timeline/rejoin/split-brain tests, replica rebootstrap and
  primary identity fencing with stronger external consensus.
- True production S3 IAM separation with real cloud-provider denial
  evidence and independent witness / object-lock retention.
- Signed review evidence from genuine identity-controlled humans,
  trusted CI source adapters and external audit storage.
- Backups of the entire customer-facing service, security review
  and separately authorized customer restore procedure.
- No atomic transaction spans source SQLite commit, PG, S3 and
  witness; zero RPO cannot be asserted by these drills alone.

All new artifacts are laboratory-only and do not change working services.
