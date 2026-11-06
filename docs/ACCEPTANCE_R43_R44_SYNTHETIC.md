# OSMANX APP FACTORY — R4.3 / R4.4 synthetic acceptance record

**Verified on 2026-11-06.** This record is part of a synthetic-only migration rehearsal. It is not a production deployment or permission to migrate real customers.

## Evidence: PostgreSQL 15 and 16

- **R4.3** commit `96d965cf7f32ab50f6ad224e3c5216c7a00baa09`: [GitHub Actions run 42173093405](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/actions/runs/42173093405). Both PostgreSQL jobs **SUCCESS**. The independent run [42173088108](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/actions/runs/42173088108) also succeeded.
- **R4.4** commit `13350803d9f4ff2175f975d9097d61f3ef5d8629`: [GitHub Actions run 42173157845](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/actions/runs/42173157845). Both PostgreSQL jobs **SUCCESS**. Each job ran 8 R4.4 unit tests, 18 R4.3, 6 R4.2, 15 R4.1 and 8 R4.0 unit tests, followed by signed import and populated CRM integration.

## Defects resolved

1. R4.3 audit UUID validator mistakenly required six UUID groups instead of five. Canonical five-group UUIDs are accepted; malformed six-group IDs have a dedicated negative regression.
2. R4.3 after-image tampering was detected correctly but a test asserted an obsolete, weaker error string. Test expectation now verifies the stronger latest-after-image gate.
3. R4.4 unit fixture lacked mandatory `created_at`, `updated_at`, `archived_at` custom-entity metadata; fixed to represent the real table.
4. Additional tests cover invalid payment amounts/status, duplicate idempotency keys, missing financial tables, invalid custom fields, orphan automation links and opt-in requirements.

## Branch review

R4.2 PR #1 targets main; R4.3 PR #2 targets the R4.2 branch; R4.4 PR #3 targets R4.3. A dedicated merge commit reconciles R4.3 fixes into R4.4 without rewriting or deleting either branch history. **This is a branch ancestry merge only; nothing is merged into main.** The final R4.4 merge commit must independently pass its CI gate before promotion.

## Explicitly unverified / blocked

- No coordinated cross-database write fence, CDC catch-up or continuous streaming.
- No full payment settlement/processor reconciliation, financial rollback rehearsal, or production data drill.
- No full application API parity across both engines.
- No live payment processing or automation execution in PostgreSQL.
- No independent production change approval.
- All shadow SQLite copies are disposable. Primary runtime remains SQLite and `productionCutoverAllowed=false`.

Keep all PRs in draft until independent review; never infer production readiness from CI green alone.
