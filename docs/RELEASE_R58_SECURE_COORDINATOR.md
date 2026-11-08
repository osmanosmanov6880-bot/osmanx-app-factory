# OSMANX APP FACTORY R5.8 — isolated mTLS checkpoint gateway

**DRAFT / SYNTHETIC ONLY. NO PRODUCTION CUTOVER.**

Base: R5.7 PostgreSQL checkpoint arbiter. No live SQLite migration,
public network binding, production data, or main branch changes.

## Five implemented engineering blocks

1. **Authenticated mTLS RPC** — src/migration/r58-mtls-coordinator.mjs.
   Actual TLS with mandatory client certificate authorization; exact
   SHA-256 peer pins, independent HMAC-SHA256 signed requests and replies,
   30-second clock window, strict tenant, route, payload and size checks.
   Only acquire, renew, assert, release, publish, recover and inspect
   are available. Arbitrary S3 object paths and SQL are not accepted.
2. **Durable anti-replay and runnable gateway** —
   ops/r58/nonce-schema.sql, src/migration/r58-nonce-store.mjs and
   ops/r58/mtls-gateway.mjs. PostgreSQL consumes every request nonce
   before invoking a coordinator operation; duplicates are denied even
   after process restart. Synthetic server binds 127.0.0.1 only and
   loads secrets from private files.
3. **Independent provider IAM verifier** —
   src/migration/r58-iam-attestation.mjs. A worker attempting pointer
   PUT and a coordinator attempting segment PUT must each receive
   provider status 403, while permitted operations work with
   COMPLIANCE-locked versions. CAS 409/412 never counts as IAM denial.
   This verification requires separately provisioned actual IAM keys.
4. **PostgreSQL fault drill and incident evidence** —
   tests/r58_pg_failure.test.mjs uses pg_terminate_backend during the
   final checkpoint acknowledgment transaction. Persisted pending intent
   prevents takeover, then controlled WORM recovery revokes the old
   lease. src/migration/r58-incident-evidence.mjs signs a read-only
   PG/S3/witness diagnostic packet without clearing quarantine.
5. **CI security matrix** — PG15/16 x Node22/24 with OpenSSL-generated
   mTLS credentials, peer-pin/HMAC/replay tests, 403-vs-CAS tests,
   actual backend termination and R5.7/R5.6/R5.5 regression.

## Disposable lab commands

Run SQL on a throwaway PostgreSQL 15/16 database:

    psql -v ON_ERROR_STOP=1 -f ops/r57/schema.sql
    psql -v ON_ERROR_STOP=1 -f ops/r58/nonce-schema.sql
    npm install --ignore-scripts --no-audit --no-fund
    node --test tests/r58_mtls_protocol.test.mjs tests/r58_iam_attestation.test.mjs tests/r58_incident_evidence.test.mjs
    OX_R58_PG_E2E=YES node --test tests/r58_pg_failure.test.mjs

The server bootstrap ops/r58/mtls-gateway.mjs requires:

- OX_R40_EPHEMERAL=YES and OX_R58_SYNTHETIC_ONLY=YES.
- OX_R58_TENANT (24 lower-case hex), OX_R58_PORT (1024–65535).
- OX_R58_SERVER_CERT_FILE, OX_R58_SERVER_KEY_FILE,
  OX_R58_CLIENT_CA_FILE, OX_R58_HMAC_KEY_FILE,
  OX_R58_CLIENT_CERT_SHA256 (lower-case SHA-256 hex).
- OX_R58_S3_ENDPOINT, OX_R58_S3_BUCKET, optional OX_R58_S3_REGION,
  OX_R58_S3_ACCESS_FILE and OX_R58_S3_SECRET_FILE, containing dedicated
  coordinator-role S3 credentials.
- Isolated PGHOST, PGPORT, PGUSER, PGPASSWORD and PGDATABASE.
- Ordinary 0600 secret/key files, dedicated TLS client cert signed by
  the configured CA, and a server cert whose SAN matches the HTTPS host.

The service never binds to a public address and there is no automatic
production integration or public ingress.

## Independent real S3 IAM attestation — NOT YET VERIFIED

tests/r58_provider_roles_e2e.test.mjs is opt-in and destructive within
a fresh disposable bucket/prefix. It does NOT run automatically without
distinct provider-provisioned worker and coordinator credentials.

For a fresh COMPLIANCE Object Lock bucket, set:
- OX_R58_PROVIDER_ROLE_E2E=YES
- OX_R58_DISPOSABLE_BUCKET_CONFIRMED=YES
- OX_R58_PROVIDER_TENANT (new unique 24 lower-case hex)
- OX_R58_PROVIDER_BUCKET, OX_R58_PROVIDER_ENDPOINT,
  OX_R58_PROVIDER_REGION
- OX_R58_WORKER_ACCESS_KEY and OX_R58_WORKER_SECRET_KEY
- OX_R58_COORDINATOR_ACCESS_KEY and OX_R58_COORDINATOR_SECRET_KEY
- OX_R58_LOOPBACK_TEST=YES for isolated local MinIO only.

Then run: node --test tests/r58_provider_roles_e2e.test.mjs

A successful synthetic CI suite does NOT mean IAM keys or policies
were actually provisioned or enforced. A conditional S3 412 is
not a permission denial; only independent 403 responses satisfy this gate.

## Unresolved release blockers

- PG backend termination is NOT real PG primary-standby failover,
  network partition, PITR or cross-region disaster recovery.
- mTLS gateway needs production identity lifecycle, certificate
  rotation and revocation, resource limits, monitoring and audit.
- PostgreSQL request nonces need restricted table grants and
  audited retention/cleanup.
- Cloud S3 IAM restrictions have not been applied or validated.
- Incident packet signatures provide diagnostics, not an independent
  WORM audit archive or signed operator unquarantine authorization.
- No atomic transaction spans PostgreSQL + S3 + external witness;
  no zero-RPO claim or industrial release approval is possible.
- Independent security review, real role-denial proofs and crash
  drills are mandatory before any cutover or main merge.
