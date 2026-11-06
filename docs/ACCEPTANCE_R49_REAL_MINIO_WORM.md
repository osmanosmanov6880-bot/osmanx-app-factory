# OSMANX APP FACTORY — R4.9 independent disaster-recovery acceptance

**Date:** 2026-11-06  
**PR:** [#8 — R4.9 independent DR](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/pull/8)  
**Tested executable code:** `4ac78b8b22748564eb888e4039b9f0c365bf7dd6`  
**Proof:** [GitHub Actions 42221807715](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/actions/runs/42221807715)

## Synthetic engineering acceptance

| Actual database | Unit tests R4.0–R4.9 | Signed CRM HTTP + real MinIO + independent witness E2E | Conclusion |
| --- | ---: | ---: | --- |
| PostgreSQL 15 | 104/104 PASS | 167 checks, `r49LiveS3ObjectLockAndOfflineRestoreVerified: true` | SUCCESS |
| PostgreSQL 16 | 104/104 PASS | 167 checks, `r49LiveS3ObjectLockAndOfflineRestoreVerified: true` | SUCCESS |

Per-job unit breakdown: R4.9 8 + R4.8 9 + R4.7 10 + R4.6 7 + R4.5 13 + R4.4 10 + R4.3 18 + R4.2 6 + R4.1 15 + R4.0 8 = 104.

## Four implementation blocks accepted

1. **Genuine S3-compatible COMPLIANCE WORM verification.** MinIO runs as a separate container on the GitHub runner. The test bucket is versioned and configured with default seven-day COMPLIANCE retention. The adapter obtains S3 object-version IDs and remaining retention dates via HeadObject on every encrypted archive, authenticated catalog and current-pointer version. The E2E intentionally attempts to delete a protected exact version and confirms both an explicit WORM rejection and that the archive remains readable. In the pinned synthetic MinIO build, the expected denial is **HTTP 400 / `InvalidRequest` / `Object is WORM protected and cannot be overwritten`** (rather than 403). No unrelated HTTP 400 error is accepted as proof.
2. **Independent witness protocol and deployable receiver.** HMAC-signed monotonic catalog witness detects replay of an older valid signed S3 head. A separate Node service, Dockerfile, Compose specification, Caddy TLS configuration and private key-file handling are included under `ops/r49/`. In CI, the witness is a separate HTTP server/process rooted in a separate temporary directory, **not a physically/geographically independent machine**.
3. **Offline CRM recovery without original vault disk.** `restoreR49Offline` authenticates the S3 catalog against the independent witness, checks WORM retention and decrypts the signed archive to a **new private SQLite file**. It verifies the signed Ed25519 manifest, complete CRM rows, SQLite integrity and foreign keys, financial HMAC, payment/workflow/custom entity semantics. The test proves the original source SQLite is unchanged and checks restored synthetic financial amounts. No automatic promotion or payment execution is allowed.
4. **PostgreSQL 15/16 real CI matrix and deployable operator runbook.** All predecessor regressions R4.0–R4.8 remain green and the new R4.9 tests cover strict bucket policy, missing version IDs, expired/governance retention, witness process restart, denied versioned deletion, signed rollback rejection, private recovery path, signed full CRM restoration and preserved primary SQLite. The operator instructions are in `docs/RELEASE_R49_INDEPENDENT_DR.md`.

## Actual CI repairs made before acceptance

- Original MinIO image registry returned `unauthorized`. An **unofficial source-built test image** was pinned by OCI digest strictly for CI. This image's provenance has not been independently audited, and it must not be assumed safe for deployment outside the isolated synthetic runner.
- The image runs without root privileges and initially could not write to its runner-owned volume. CI now runs the container with the runner user's UID/GID and a private 0700 host directory; port 9000 is bound to loopback only.
- The previous `mc` container bootstrap was replaced with AWS CLI `s3api` bucket provisioning and retention configuration.
- The first live WORM delete check incorrectly treated HTTP 400 as generic failure. MinIO's **specific** `InvalidRequest` response with explicit WORM-protection message is now accepted, while malformed requests, authentication errors and any other non-WORM response remain rejected. The file is fetched again after the attempted deletion to confirm it survives.

## Critical production boundaries

- No production cloud provider account, remote S3 bucket, geographically separated witness VPS, DNS/TLS deployment or hosted monitoring destination was created or verified. CI MinIO, witness and PostgreSQL still share a GitHub runner.
- The pinned unofficial MinIO test image and floating runtime dependencies need independent supply-chain review before using the deployment artifacts on any long-lived host.
- Real independent storage region/failure-domain isolation, cloud IAM review, customer data protection/privacy, Object Lock legal retention policy, key custody and recovery of the *witness itself* are outstanding.
- CI's measured recovery time on synthetic data is **not** a production RTO; confirmed backup age is **not** transaction-level RPO.
- No production alerting recipient, actual customer-data restore rehearsal, actual payment-processor settlement comparison, CDC, write fence or PostgreSQL cutover approval.
- All R4.9 code receipts keep `productionCutoverAllowed=false`. The SQLite application remains primary. `main` is unchanged at `f2570d6c74c72b5f00a2b09740e905058476d32a`. PR #8 remains draft.

**Verdict:** R4.9 synthetic engineering acceptance PASS, PostgreSQL 15 + 16. Production DR acceptance NOT APPROVED. Do not merge/deploy without independently reviewed external infrastructure, security and operational testing.
