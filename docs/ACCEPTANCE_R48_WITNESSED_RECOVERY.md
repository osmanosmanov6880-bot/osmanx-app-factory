# OSMANX APP FACTORY — R4.8 engineering acceptance

**Date:** 2026-11-06  
**Repository:** `osmanosmanov6880-bot/osmanx-app-factory`  
**Tested executable commit:** `e7aa02af58c63b23523880e59faf4923f5123a67`  
**Pull request:** [#7](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/pull/7) (draft, based on R4.7)
**GitHub Actions:** [run 42203754807](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/actions/runs/42203754807)

## Independent PostgreSQL 15/16 matrix

| Database | Unit tests | True signed PostgreSQL + HTTP + independent witness E2E | Result |
|---|---:|---:|---|
| PostgreSQL 15 | 96/96 | 158 synthetic checks; `r48IndependentWitnessAndMeasuredRecoveryVerified: true` | SUCCESS |
| PostgreSQL 16 | 96/96 | 158 synthetic checks; `r48IndependentWitnessAndMeasuredRecoveryVerified: true` | SUCCESS |

Unit-test breakdown per database: R4.8 **9**, R4.7 **10**, R4.6 **7**, R4.5 **13**, R4.4 **10**, R4.3 **18**, R4.2 **6**, R4.1 **15**, R4.0 **8**.

## Four completed engineering blocks

1. **S3-compatible encrypted transport.** AWS Signature V4 is implemented with signed SHA-256 requests, fixed HTTPS root and tenant prefix, no redirects, strict key allowlist, immutable-object compare and readback checks. The adapter verifies S3 versioning and Object Lock configuration. Its unit tests run against an isolated simulated S3 HTTP service, not a live cloud account.
2. **External monotonic witness.** A distinct signed HMAC witness protocol compares monotonically increasing authenticated catalog sequence/hash with the R4.7 remote pointer. The signed test intentionally rolls remote storage back to an *older valid signed head*. Independent witness verification refuses the rollback. Invalid bearer requests return 401 rather than masquerading as an absent witness; this issue was caught and fixed by CI.
3. **Durable privacy-safe failure notifications.** The outbox is HMAC-protected on disk and deduplicates pending events. A fixed HTTPS webhook receives only allowlisted error codes, an opaque token, random event ID and timestamp; requests are signed independently. CI verifies delivery after a remote rollback with no CRM row/financial value disclosure.
4. **Measured disaster restoration.** Signed restored SQLite snapshots are independently checked for whole-row, foreign-key, financial, automation and custom-entity integrity. Recovery duration is measured as RTO for the drill; the age of the last confirmed offsite snapshot is reported separately and **is not measured production transaction-loss RPO**. Both PostgreSQL versions pass the end-to-end signed import, forced rollback, recovery, server restart and key-rotation validation.

## Issues fixed during R4.8 acceptance

- An unauthorized witness request originally returned HTTP 404, conflating invalid authentication with an authenticated first-time lookup. Fixed to **401** for unauthorized access.
- Extending the synthetic archive test with a new R4.8 backup changed R4.6 retention ordering. The older test attempted to restore an archive already retired by policy. The test now tracks the active retained archive ID. Retention rules were not weakened.
- Final tested code is `e7aa02af` after both corrections. The CI result above is for that commit, not a superseded attempt.

## Explicit limitations and production blockers

- **Not a real cloud deployment:** S3 signing uses a loopback simulated service in unit tests. Full CI uses the independent synthetic R4.7 object receiver and a separately rooted witness process on the same GitHub runner. No external S3 bucket, cloud account, or geographically separated witness host has been provisioned.
- S3 Object Lock configuration does not establish a tested retention window, legal hold, externally enforced immutable object lifecycle or a production-grade recovery point anchor.
- The witness is a reference single-node, HMAC-authenticated service; no verified geographically independent, highly available or tamper-proof witness deployment.
- Alert transport is tested against a local signed webhook, not a connected on-call service; no recipient team, paging rotation, notification SLA or escalation path is configured.
- Measured drill time and confirmed backup age use synthetic fixtures. No production workload RPO, audited emergency RTO or real-customer restore rehearsal has been established.
- No production payment settlement validation, coordinated write freeze, cross-engine CDC, application-wide API parity, PostgreSQL cutover or authorization to merge into `main`.
- Production cutover remains **blocked** by design (`productionCutoverAllowed=false`); primary production runtime is unchanged SQLite.

**Engineering verdict:** Synthetic R4.8 test acceptance PASS on both PostgreSQL versions. External infrastructure and production disaster recovery readiness NOT YET ACCEPTED. Keep PR #7 in draft pending independent code/security/ops review.
