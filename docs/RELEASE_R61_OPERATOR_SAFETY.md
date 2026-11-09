# OSMANX APP FACTORY R6.1 — operator-authorized read-only recovery

**DRAFT / SYNTHETIC ONLY. No production cutover, main merge, S3 mutation,
checkpoint unquarantine, automatic restore or zero-RPO certification.**

Parent: R6.0 Draft PR #19. Five engineering packages:

## 1. Fix inherited R6.0 / R5.9 acceptance

- Both R6.0 audit-role tests now assert synchronous capability denial
  with assert.throws, not async rejection. The permission gate is unchanged.
- MinIO Client still requires SHA-256 verification before execution.
  The upstream checksum file refers to the generic binary name, whereas
  the GitHub release asset includes a platform suffix; the installer now
  validates an exact 64-character digest against the downloaded asset.
- Physical PG failover, separate MinIO role enforcement (real provider 403)
  and WORM retention remain required. Any missing capability fails CI.

## 2. Offline two-person Ed25519 approval

- src/migration/r61-dual-approval.mjs verifies exactly two signatures
  from distinct registered humans and keys in security/reliability roles.
- Tenant, incident ID, checkpoint epoch, evidence SHA-256, exact S3 version,
  read-only action and <=15-minute validity are cryptographically bound.
- Revoked keys, counterfeit signatures, stale approvals, false roles,
  different actions, foreign tenants and duplicated signers fail closed.
- There is no permission to perform a customer restore or clear a lease.

## 3. Immutable PostgreSQL incident dossier

- ops/r61/incident-schema.sql creates immutable per-tenant case identities
  and append-only signed reviewer events, with SQL triggers denying
  UPDATE/DELETE and grants revoked from PUBLIC.
- src/migration/r61-pg-incident-store.mjs provides idempotent opening,
  row-locked cross-process appends, mandatory two-person approval before
  each recorded review, HMAC-chain verification and consistent-snapshot reads.
- No method calls the R5.7 coordinator recover operation, modifies S3,
  changes a pending intent or enables production release.
- A PostgreSQL superuser could bypass triggers. This is not a certified
  third-party immutable audit log; retain independent WORM evidence.

## 4. Multi-source read-only reconciliation assessment

- src/migration/r61-recovery-assessment.mjs compares the persisted pending
  PG intent with versioned COMPLIANCE-locked S3 forensic objects,
  independently verified witness state and current audit WORM anchor.
- It reads the PG checkpoint before AND after remote observations and
  rejects the result if the authority changed during inspection.
- Output classifications: coherent evidence still requiring manual
  review, missing S3 version, witness disagreement, absent audit,
  S3 forensics unavailable, or no pending checkpoint.
- There is no cross-service atomic snapshot, and coherent evidence
  never triggers an automatic rollback, lease change or cloud write.

## 5. PostgreSQL and security CI acceptance

- tests/r61_dual_approval.test.mjs: Ed25519, expiry, action and key denial.
- tests/r61_pg_incident_store.test.mjs: concurrent PG15/16 case creation,
  idempotent signed review, immutable trigger, forged event rejection.
- tests/r61_recovery_assessment.test.mjs: multi-source conflicts,
  concurrent PG mutation and strict no-mutation assertions.
- tests/r61_operator_workflow_pg.test.mjs: actual PostgreSQL fenced pending
  row, coherent diagnostic report, two independent offline signers,
  recorded event and proof that original pending_op and epoch remain intact.
- .github/workflows/r61-operator-safety.yml: PG15/16 x Node22/24,
  inherited R6.0 WORM and R5.9 release-gate regressions.
  Companion inherited workflows exercise isolated real MinIO.

## Independent acceptance still required

- Restricted production PG roles, IAM credential custody, independent
  cloud-provider permission denial proofs, certificate rotation policy.
- External WORM witness for operator audit, separate signing-key custody.
- PG network partitions, split-brain fencing and full standby restore.
- Independently reviewed release evidence, customer restore rehearsals
  and authorized operator SOPs before any public service cutover.

Successful synthetic tests cannot certify zero RPO or production safety.
All code and returned results keep productionCutoverAllowed=false.
