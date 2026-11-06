# OSMANX APP FACTORY R5.2 — outage rehearsal, recovery and measured transaction loss

**Scope:** isolated synthetic CRM. The upstream R4.0–R5.1 PR chain is still Draft, and the main SQLite application is unchanged. R5.2 is **NOT** production deployment or proof of geographically separated services.

## Four engineering blocks

1. **Failure injection with fail-closed recovery semantics.** A baseline signed R5.1 operational readiness probe must pass. The test then deliberately cuts access to each required service, one at a time: S3 object storage, backup witness, audit witness, and signed alert machine. For each service a probe must fail while isolated; after restart it must revalidate full signed readiness. A no-op isolation, failed recovery, unknown service order, unchanged failed state, or mutated primary SQLite digest all block acceptance. The testing API is only enabled for explicit `syntheticOnly: true`.
2. **Post-backup commit loss.** The test writes one additional committed synthetic CRM task **after** the last sealed backup and verifies that an otherwise valid earlier signed restore does not contain that task. The result explicitly reports `lostSinceBackup=1`, `withinTestLossBudget=false` when zero transaction loss is required. This test must NOT be interpreted as achieved zero-loss RPO; no production commit watermarks, CDC, continuous replication, or backup-lag budget are configured. It is a demonstration of a limitation.
3. **Tamper-evident, privacy-safe signed rehearsal report.** A separate HMAC key protects a unique immutable-create (`wx`) private 0600 JSON receipt with only four sanitized service fault outcomes and integer commit-loss counts. Full customer records, cloud credentials, usernames, source file paths, task IDs and full connection strings are prohibited. A report of a passed fault matrix does not override a failed transaction-loss budget; the report truthfully sets `operationalChaosGatePassed=false` when the backup lacks post-snapshot work. The operator verification command exits non-zero if the signed receipt exceeds the loss budget.
4. **True MinIO and PostgreSQL 15/16 CI.** The inherited real S3-compatible MinIO container uses a disposable versioned COMPLIANCE Object Lock bucket, while PostgreSQL 15 and 16 independently execute signed full-CRM tests. R5.2 stops/restarts the actual MinIO container, closes/restarts each of the other three distinct HTTP services, verifies signed readiness is unavailable during downtime and verified again afterward, checks source-file digest consistency, then adds the post-backup synthetic transaction and verifies its absence from the older restored SQLite. All running services are **on a single CI runner**.

## Operator validation

Never run the synthetic fault injection against real infrastructure. In the isolated test environment, review the report using:

`OX_R40_EPHEMERAL=YES OX_R52_SYNTHETIC_ONLY=YES node ops/r52/verify-report.mjs`

It also requires `OX_R52_RECEIPT_DIRECTORY`, `OX_R52_RECEIPT_ID`, `OX_R52_TENANT_TOKEN` and `OX_R52_RECEIPT_KEY_FILE`, a 0600 file containing an external 32-byte HMAC key. Keep the key file private. A non-zero result **is expected** when one post-backup transaction is deliberately missing. Do not suppress that failure to make a release appear green.

## What still blocks real DR readiness

- No live independent S3 provider, independent backup witness VPS, independent audit host, real alert destination, DNS/TLS deployment or connected cloud account has been provisioned or verified.
- The CI fault scenarios confirm process/container failure handling on a single machine, not geographical/regional isolation or alternate network providers.
- A confirmed signed alert machine is not human pager acknowledgement. No on-call or escalation is connected.
- The current sealed backup **loses the deliberate post-backup transaction** in this synthetic test. A real zero-loss RPO requires continuous capture/replication of committed records and replay validation. Merely restoring a signed old backup does not satisfy RPO.
- The recovery-time values are synthetic runner measurements, not contractual production RTO.
- An externally reviewed IAM policy, legal WORM retention policy, immutable external ledger-head anchor, supplier image supply-chain verification, key escrow, real customer/payment data settlement, GDPR/data residency check, and coordinated write fence remain required.
- `productionCutoverAllowed=false` in every public R5.2 result. Do not merge to `main` or deploy until an independent security and operational review approves a real-data rollout.

**Engineering acceptance is based on R5.2 CI results for both PostgreSQL 15 and 16.** The fact that the transaction-loss test detects an actual lost post-snapshot write is a *passing detection test*, but a *failing zero-loss RPO acceptance condition*.
