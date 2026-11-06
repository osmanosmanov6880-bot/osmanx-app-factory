# OSMANX APP FACTORY — R5.2 independent service-failure and post-backup transaction-loss acceptance

**Date:** 2026-11-06  
**Pull request:** [#11 — R5.2 failure drills](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/pull/11)  
**Latest tested executable SHA:** `702550df581a04234dfc41ab82a456a27d0527e1`  
**Final GitHub evidence:** [Actions run 42264212041](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/actions/runs/42264212041)

## Real synthetic PostgreSQL + MinIO acceptance

| Database | Unit tests | Signed CRM + real S3-compatible MinIO + 4 service-failure scenarios | GitHub result |
| --- | ---: | ---: | --- |
| PostgreSQL 15 | 149 / 149 | 185 checks; `r52FourInfrastructureOutagesAndPostBackupLossVerified: true` | SUCCESS |
| PostgreSQL 16 | 149 / 149 | 185 checks; `r52FourInfrastructureOutagesAndPostBackupLossVerified: true` | SUCCESS |

Unit tests per job: R5.2 **12**, R5.1 **15**, R5.0 **18**, R4.9 **8**, R4.8 **9**, R4.7 **10**, R4.6 **7**, R4.5 **13**, R4.4 **10**, R4.3 **18**, R4.2 **6**, R4.1 **15**, R4.0 **8**.

## Four substantive code blocks

1. **Four operational fault scenarios and fail-closed verification.** `runR52FailureMatrix` begins with successful signed R5.1 readiness and an independently recorded SHA-256 fingerprint of the unchanged primary SQLite. In each case it deliberately disables a service: actual MinIO container, backup witness HTTP listener, independent audit-anchor HTTP listener and signed-alert HTTP listener. Readiness MUST fail during the incident. After real process/container recovery, the full signed readiness test and source file fingerprint MUST match again. A false-positive health response, missing fault, broken restore or modified source fails the gate. The synthetic recovery time now explicitly includes complete post-restart signed revalidation, not merely the return of the TCP listener.
2. **Measurable post-snapshot transaction-loss detection.** Only after previous signed CRM and source-immutability tests finish, CI commits **one additional synthetic task to the SQLite primary**. This task was created *after* the final sealed, signed archive. `inspectR52SyntheticTransactionLoss` reads original and independently restored SQLite in read-only mode, proving the committed task exists in the primary but is absent in the older restored copy. Results: `committedAfterBackup=1`, `recoveredAfterBackup=0`, `lostSinceBackup=1`, `withinTestLossBudget=false` for a zero-transaction-loss budget. `enforceR52SyntheticLossBudget` correctly rejects this result.
3. **Private HMAC-signed rehearsal receipts.** A unique 0600 immutable-create receipt contains only the four service names, fail-closed and recovery verification flags, bounded recovery durations, transaction-loss counts and an opaque tenant token. It contains no CRM rows, names, payments, S3 tokens or database paths. Altering its digest or supplying the wrong signing key fails verification. The receipt reports the incident simulations as passed but its **operational zero-loss gate remains failed** because one committed post-backup task was lost. `ops/r52/verify-report.mjs` exits nonzero if the configured zero-loss budget is exceeded.
4. **PostgreSQL 15/16 actual outage matrix and all predecessor regressions.** The CI workflow launches genuine disposable MinIO with COMPLIANCE Object Lock on a private loopback port, separately rooted backup/audit services, signed-alert machine and PostgreSQL. Both PG15 and PG16 pass all suites R4.0–R5.2 with no failures. The R5.2 outage scenarios use actual `docker stop` / `docker start` for MinIO and `server.close()` / `listen()` for the other three HTTP services. All test services share one GitHub runner and use fully synthetic CRM data.

## Critical interpretation of the result

**Engineering fault-detection and controlled recovery: PASS.** CI proved that each tested service outage denies signed readiness, then signs and verifies readiness again after recovery.

**Zero transaction-loss RPO: FAIL (deliberate, detected).** The latest signed backup is correctly restored but cannot recover one synthetic transaction committed *after* that backup. This is an observed limitation, not an accidental test failure. A genuine production recovery-point objective requires continuous transactional journal capture/CDC or coordinated backup checkpoint watermarks, with a measured failure point and successfully replayed post-checkpoint transactions.

A receipt of `r52FourInfrastructureOutagesAndPostBackupLossVerified: true` attests that the *test detected* the failure truthfully, **not** that zero RPO is achieved.

## Boundaries and open production dependencies

- **No physically/geographically independent cloud servers are deployed.** MinIO and all witnesses/alert services run as independent processes/containers on the same ephemeral CI machine. Docker restart is not a regional outage test. Separate cloud accounts, fault domains, DNS/TLS, IAM and real S3 Object Lock retention require external operational provisioning.
- The most recent evidence remains synthetic. No actual customer-data restore, production payment reconciliation, contractual RTO measurement, human on-call pager, independent security sign-off, externally verified immutable audit anchor or managed key-escrow system has been tested.
- GitHub's self-hosted source-built MinIO image is unofficial and digest-pinned only for isolated CI; supply-chain audits and provider-owned S3 credentials are required before any real deployment.
- The primary SQLite is modified only by the explicitly named **synthetic post-backup transaction fixture** in an ephemeral test directory. No real database, live user or payment processor is touched. The `main` branch remains on `f2570d6c74c72b5f00a2b09740e905058476d32a`.
- Production cutover remains **forbidden by design** with `productionCutoverAllowed=false` in all new runtime receipts. Do not merge the draft PR dependency chain or switch to PostgreSQL without external security, data-governance and operating approval.

**Decision:** Accept R5.2 as an isolated engineering fault-detection and recovery rehearsal. **Do not certify zero RPO or production disaster-recovery readiness.** Keep PR #11 Draft until independent cloud infrastructure and transactional loss-recovery tests are accepted.

Operator runbook: [R5.2 outage rehearsal and data-loss limitations](./RELEASE_R52_NETWORK_FAILURES.md).
