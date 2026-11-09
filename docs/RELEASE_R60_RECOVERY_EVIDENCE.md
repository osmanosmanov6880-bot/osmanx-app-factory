# OSMANX APP FACTORY R6.0 — forensic evidence and strict lab gates

**DRAFT / synthetic-only / no production cutover.** The R5.9 parent
has four green code matrix jobs but failed both real MinIO IAM jobs
because the external MinIO Client download returned HTTP 410.
This branch must pass fresh CI before independent acceptance.

## Five major delivered engineering packages

### 1. Repair real-provider IAM acceptance bootstrap

- Fixed ops/r59/minio-roles-lab.sh to source the exact official GitHub
  Release asset for MinIO mc rather than a removed Docker Hub image, a
  Quay image requiring authorization, or MinIO's deprecated HTTP 410
  archive endpoint.
- Downloads both binary and .sha256sum; executes the client only after
  checksum verification. All MinIO identities and policies remain
  limited to the disposable synthetic lab. Any acquisition failure
  fails CI; IAM tests are never silently skipped.
- This is an integrity check against a sidecar in the SAME upstream
  GitHub release, not an independently pinned supply-chain hash.
  Independent artifact trust is a separate production release gate.
- Existing tests/r58_provider_roles_e2e.test.mjs must witness two
  separate actual MinIO 403 denials and two permitted immutable writes.

### 2. Bounded version-history S3 forensics

- src/migration/r60-s3-version-forensics.mjs signs fixed read-only
  GET/HEAD requests with SigV4 and a dedicated reviewer credential.
- It inventories at most 100 versions of one exact tenant's
  r53/head.json; refuses truncated pages, delete markers, duplicate
  IDs, foreign paths, malformed XML and oversize responses.
- Each version is read by explicit version ID; its SHA-256,
  reported version ID and future COMPLIANCE retention are verified.
- The outcome is diagnostic only. A matching checkpoint hash is NOT
  proof of witness acceptance and never clears persisted pending_op.
- Tests exercise denied forged keys, tampered metadata, WORM absence,
  unrecognized versions, no-match cases and zero-write behavior.

### 3. Synchronous PostgreSQL promotion preflight

- ops/r59/pg-ha-lab-setup.sh creates a physical PG15/16 standby, then
  enables synchronous_commit=remote_apply with a named sync standby.
- src/migration/r60-pg-promotion-preflight.mjs verifies source and
  replica mode, streaming sync state, exact required WAL replay LSN,
  and identical persisted checkpoint pending operation/sha/epoch.
- The preflight is strictly read-only and cannot kill, promote, or
  replace either instance. It explicitly cannot prove old-primary
  fencing, quorum or absence of split brain.
- tests/r60_pg_promotion_preflight.test.mjs includes real separate PG
  containers plus rejection of async, lagging, promoted/foreign or
  mismatched standby conditions.

### 4. Independently signed immutable WORM audit tip

- R4.8 S3 strict object allowlist admits only
  r60/audit/<content sha256>.json as an immutable object key.
- src/migration/r60-worm-audit-anchor.mjs first verifies R5.9's
  PostgreSQL HMAC journal, then signs a snapshot of its tip with a
  separate Ed25519 reviewer key and uploads it through an audit-only
  tenant-pinned S3 capability.
- The exact body digest, provider version and future COMPLIANCE Object
  Lock are read back. The reviewer can later compare it to the
  *current* PG journal tip and detect divergence.
- The module emits a least-privilege audit IAM policy: only audit
  objects, no r53/head or segment writes.
- tests/r60_worm_audit_anchor.test.mjs covers stale tip, forged
  content, wrong WORM mode and role restrictions. An additional job
  tests an actual COMPLIANCE MinIO anchor.

### 5. CI-run-bound external evidence verification

- src/migration/r60-ci-provenance-gate.mjs verifies extra Ed25519
  signatures binding each R5.9 report to a specific GitHub repository,
  HEAD SHA, completed workflow, exact successful job ID and a
  distinct trusted reviewer identity/key.
- The caller must provide an authenticated run/job data provider,
  not raw untrusted source claims. Missing provider or a failed,
  skipped, substituted, expired, duplicated or foreign-commit result
  fails closed.
- Five different category reports / reviewer keys / source jobs are
  mandatory. The production deploy/merge/unquarantine flags always
  remain FALSE even when all synthetic checks are green.
- tests/r60_ci_provenance_gate.test.mjs proves failure on fake CI,
  wrong code commit, tampering, absent role and expired evidence.

## CI and release policy

.github/workflows/r60-recovery-evidence.yml runs:
- PG15/16 x Node22/24 full synthetic test matrix;
- PG15/16 real physical streaming remote_apply preflight;
- a separate real S3 WORM audit-anchor readback;
- inherited R5.9 IAM failover/role-denial gates (through PR paths).

No merge into main, no production environment credentials, no
unquarantine, no customer transactions, and no zero-RPO certification.
Before any production cutover, also require:
- independent provider IAM roles + provider-specific denial proof;
- audit-role privilege proof and independent offsite WORM copy;
- documented old-primary fencing, WAL/PITR restore and split-brain
  disaster tests on an HA stack;
- independent key custody, reviewer attestation and provenance of
  actual GitHub run receipts;
- independent security assessment and written authorization.

**A green isolated CI only verifies that the lab experiments passed.**
