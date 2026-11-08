# OSMANX APP FACTORY R5.9 — HA / IAM / PKI / Audit / Release Gate

**Status: DRAFT — isolated synthetic engineering only. Production release is blocked.**

R5.9 extends the accepted R5.8 source commit. It adds five actual code
packages, infrastructure fixtures and rejection tests, not marketing screens.

## 1. Physical PostgreSQL promotion (PG15 and PG16)

- ops/r59/pg-ha-lab-setup.sh starts an isolated PostgreSQL primary and
  a physical streaming standby on a private Docker network with separate
  data volumes. Never run on an existing production Docker host.
- tests/r59_pg_promote_e2e.test.mjs persists an S3 pointer intent, confirms
  real COMPLIANCE Object Lock on MinIO, waits until the standby has replayed
  the relevant WAL, SIGKILLs the primary container, promotes the standby
  via pg_promote(), and proves recovery of the exact S3 object version.
- New leases remain denied until the pending write is reconciled.
  Previous publisher generations remain fenced.
- This proves an isolated two-node promotion drill, NOT enterprise
  automatic failover, majority quorum, reliable synchronous RPO or PITR.

## 2. Real MinIO IAM user separation

- scripts/r59_write_iam_policies.mjs derives per-tenant literal-resource
  IAM policies from the tested R5.7 policy builder.
- ops/r59/minio-roles-lab.sh uses a disposable MinIO admin interface
  to create TWO actual non-root identities: segment-only publisher and
  pointer-only coordinator.
- tests/r58_provider_roles_e2e.test.mjs must observe real provider status
  403 for worker pointer PUT and coordinator segment PUT, and successful
  COMPLIANCE-protected writes for the corresponding authorized role.
- Synthetic MinIO policy enforcement does NOT certify real AWS IAM or
  customer environment S3 ACLs. No customer IAM roles are modified.

## 3. Offline Ed25519 certificate rotation

- src/migration/r59-cert-rotation.mjs signs a tenant-specific trust
  manifest with an offline Ed25519 private key, verifies using only
  a pinned public key and bounds trust to a 90-day maximum manifest.
- Exactly one or two old/new client and server SHA-256 fingerprints are
  accepted at a time; old fingerprints expire independently.
- ops/r59/cert-generation.sql persists monotonic generation numbers.
  Replaying an earlier signed manifest or rewriting the same generation
  with different pins fails at startup.
- The R5.8 mTLS client/server support bounded pin-provider callbacks,
  preserving strict single-pin behavior for legacy clients.
- ops/r58/mtls-gateway.mjs can optionally load a signed manifest
  using OX_R59_TRUST_MANIFEST_FILE and OX_R59_TRUST_PUBLIC_KEY_FILE;
  the PG schema must be installed before enabling it.
- Rotation is startup-based, not remote hot reload. Certificate revocation
  services, expiry alerting, real provider PKI and production lifecycle
  procedures remain unreviewed.

## 4. PG append-only HMAC operator event chain

- ops/r59/audit-schema.sql contains a per-tenant tip row and append-only
  journal with a SQL UPDATE/DELETE rejecting trigger.
- src/migration/r59-audit-ledger.mjs uses row-level PG locks to serialize
  concurrent writers, per-event nonce, server timestamps and chained
  HMAC-SHA256 records, with bounded consistent-snapshot verification.
- tests/r59_audit_ledger.test.mjs checks 24 concurrent inserts across two
  independent pools, enforced SQL immutability, tampering, wrong secret,
  missing sequence and hash mismatch.
- Database superusers can disable triggers. Production needs restricted
  database roles, external WORM anchoring and evidence key custody.
  This branch does not claim tamper-proofness against a database owner.

## 5. Five-authority signed lab release gate

- src/migration/r59-release-gate.mjs expects five fresh Ed25519
  attestations from distinct pinned public keys and reporter identities:
  PostgreSQL promotion, real S3 role-denial checks, TLS rotation,
  operator journal integrity and independent witnessed checkpoint.
- Every category has explicit *true* observation requirements, no missing
  fields, tenant-pinned domain-specific signatures and a max 1h lifetime.
- ops/r59/check-release.mjs reads an isolated signed-evidence manifest
  and produces a read-only acceptance report. It never merges, deploys,
  resets quarantined data or authorizes public traffic.
- Even all-green signed synthetic reports yield
  productionCutoverAllowed=false, deployAllowed=false,
  mainMergeAllowed=false, industrialRpoCertified=false.
- An independent human security/reliability reviewer must still inspect
  each real source of attestation. Self-generated test reports alone
  are NOT accepted as an actual industrial security certification.

## CI acceptance

The .github/workflows/r59-ha-iam-release.yml workflow runs:
- PG15/16 × Node22/24: syntax, real OpenSSL mTLS overlapping certs,
  Ed25519 manifest anti-rollback, PG audit chain, signed release-gate
  refusal tests and inherited R5.8 security/PG failure regressions.
- PG15 and PG16: a physical streaming standby plus a real COMPLIANCE
  MinIO bucket and two real isolated IAM users with provider deny probes.
- The MinIO client container is pulled for the isolated provisioning lab,
  and the MinIO server uses the same pinned source-built image digest
  as prior R5.7 tests. CI runners are disposable.

## Explicit blockers

1. This is not a production HA setup; verify synchronization modes,
   split-brain prevention, standby timing, automatic failover fencing
   and PITR on real infrastructure.
2. Provider IAM on AWS/another customer S3 endpoint still requires
   external tests using their real provider's restricted role model.
3. Certificate signing keys must be held independently and rotated
   with an audited multi-party procedure; consider revocation and CRL/OCSP.
4. The audit journal requires external WORM anchoring and separation of
   writer, administrator and reviewer credentials.
5. The release gate requires actual independently signed evidence from
   approved parties, not test-generated attestations.
6. No atomic transaction spans SQLite COMMIT, PostgreSQL, S3 and
   independent witness; no production zero-RPO certification exists.
7. No public deployment, migration of customer data or merge to main.
