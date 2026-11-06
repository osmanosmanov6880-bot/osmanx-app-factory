# R4.4 — Financial, automation and custom entity parity

R4.4 extends **synthetic-only, read-only** R4.3 shadow migration verification. It introduces no public payment execution, no autonomous automation execution, no bidirectional synchronization, and no production cutover.

## Four implementation blocks

1. **Financial ledger semantics.** Validate every signed payment row: integer minor units (never floats), 1–999,999,999,999 range, currency/method/status allowlists, client/employee links and unique non-null idempotency keys. Group amounts using BigInt; expose only a keyed HMAC of grouped amounts in the receipt, never actual payment amounts or payment IDs.
2. **Automation integrity.** Check rule event, role, enabled flag, bounded due days, idempotency of `(automation_id,event_key)` and links from runs to signed tasks and rules. Rules using `entity_created` must reference an existing custom entity.
3. **Dynamic custom entity integrity.** Verify all signed `custom_entity_schema` definitions against `custom_<slug>` tables, required columns, declared field types, valid values, referential targets, and employee references. Missing or dangling records stop the check.
4. **Integrated shadow gate and true PostgreSQL tests.** Enabled only with R4.3 plus extra `OX_R44_CRITICAL_PARITY=YES` and `OX_R44_CONFIRM_SYNTHETIC=YES`. The existing owner-only `POST /api/studio/pg-preview/projects/:id/shadow-replay/check` appends a privacy-safe `criticalParity` result to the checkpoint. The workflow runs real PostgreSQL 15/16 using **nonempty** synthetic payments, automation runs and custom orders.

## Safety invariants

- Signed manifest, primary SQLite baseline and tenant read-only PG snapshot must all pass predecessor gates.
- Payments/automation/custom entity rows are **compared** across engines and are **never replayed as writes**.
- The parity checker aborts on any critical table divergence, missing foreign references or unsupported data before any shadow replay.
- The HMAC key is externally provisioned; it is never stored in the repository.
- Cross-engine write fencing, CDC, real customer migration rehearsal, reconciliation of payment processor settlement, deployment and rollback approvals remain out of scope. These are **blocking** requirements for cutover.
- `productionCutoverAllowed=false` always.

Local unit tests: `npm run test:r44`. Synthetic PostgreSQL acceptance: `npm run pg:e2e:r44` in the isolated test environment, executed by GitHub Actions. Passing the tests does **not** authorize merging an unreviewed PR or switching production.
