# R4.2 — signed drift reconciliation and audited Preview

Only synthetic PostgreSQL 15/16. Production runtime remains SQLite.

- Compare signed CRM tables in independent read-only snapshots (PostgreSQL REPEATABLE READ and SQLite read transaction). Compare whole rows, missing and extra IDs, modified values, baseline checksum; sanitize identifiers as HMAC tokens.
- Owner-only POST /api/studio/pg-preview/projects/:id/reconcile/check, GET .../history, Studio session and CSRF required for writes.
- PostgreSQL preview clients, tasks, visits: parameterized audit rows inserted in the same transaction as mutations, so aborted writes do not create committed audit records.
- Private append-only HMAC chained journal; sensitive key must be provisioned via OX_R42_JOURNAL_HMAC_KEY, hex 64 characters, never in repo. Truncation of the entire journal requires independent external anchoring to detect.
- Independent snapshots are not a distributed atomic snapshot. The system **never** approves a production cutover. Blockers: no cross-DB write freeze or CDC, full feature-parity or rollback rehearsals.

Synthetic opt in: OX_R40_PG_PREVIEW=YES, OX_R42_PG_RECONCILIATION=YES, OX_R42_JOURNAL_HMAC_KEY plus signed R4.0 bundle and trusted public key. Use npm run test:r42 and GitHub PostgreSQL 15/16 CI for acceptance.
