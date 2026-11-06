# OSMANX APP FACTORY R4.3 — audited dry-run shadow replay

## Intended use

R4.3 is a **synthetic-only, opt-in, disposable migration rehearsal**, NOT live database synchronization or permission to switch production. It is built on R4.1 PostgreSQL Preview and R4.2 signed reconciliation. SQLite remains authoritative.

## Four engineering blocks

1. **Signed baseline + PG snapshot.** Verify Ed25519 provenance, signed schema inventory and SQLite row hashes. Capture one PostgreSQL REPEATABLE READ read-only tenant snapshot, with a 5,000-row/table default limit.
2. **Audited shadow replay.** Use `node:sqlite.backup()` to clone a CRM SQLite database into a disposable private directory. Import supported PostgreSQL client, task and visit create/update operations only when backed by new `pg-preview.create/update` audit entries that include a keyed HMAC of the exact post-change row. This also rejects unlogged changes to an already-audited row. Reject deletions, direct SQL mutations, unauthorized user/payment/automation changes and changed original SQLite data. Apply delta in one SQLite transaction with FK checks. Replay the same data again; second pass MUST be a no-op.
3. **Owner-only API and tamper evidence.** POST `/api/studio/pg-preview/projects/:id/shadow-replay/check` and GET `.../history`, under Studio owner session, CSRF and Origin checks. Append sanitized checkpoint HMACs to a private, deduplicating, append-only journal. Secrets are external to Git.
4. **Real PostgreSQL CI.** Isolated PostgreSQL 15/16 synthetic matrix verifies signed import, preview writes, snapshots, shadow parity, idempotent replay, unchanged original SQLite, another owner's denial, journal persistence and failure on unlogged direct PostgreSQL updates. Unit tests inject a mid-replay failure to prove SQLite transaction rollback.

## Explicit enablement

Must supply `OX_R40_PG_PREVIEW=YES` and signed R4.0 trust materials, plus:
- `OX_R42_PG_RECONCILIATION=YES` with `OX_R42_JOURNAL_HMAC_KEY` (32-byte external key as 64 hex characters)
- `OX_R43_SHADOW_REPLAY=YES`
- `OX_R43_CONFIRM_SYNTHETIC=YES`

`npm run test:r43` and `npm run pg:e2e:r43` (the latter ONLY in an isolated, empty, synthetic PG database with the documented R4.1 guard).

## Not a cutover

- PG/SQLite snapshots are independently consistent, not globally atomic.
- R4.3 replays a **bounded, audited subset** of CRM operations into a **discarded shadow**; it does not run a permanent CDC tail or send any writes back to primary SQLite.
- No active production write fence, full PG feature parity, tested real-data rollback or human release approval.
- `productionCutoverAllowed` is hard-coded to false. Merging requires successful CI but never authorizes deployment or database switching.
