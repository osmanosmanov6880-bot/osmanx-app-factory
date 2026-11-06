# OSMANX APP FACTORY R4.5 — encrypted synthetic CRM backup and restoration

R4.5 runs a **disposable, read-only-source recovery drill**, not a persistent backup service and not a production migration. SQLite stays the primary runtime and cutover remains blocked.

## Four implemented engineering blocks

1. **Confidential signed snapshot.** The Studio owner, existing R4.0–R4.4 signature gates and explicit synthetic flag must all be valid. Read SQLite using `node:sqlite.backup()` (WAL-safe consistent snapshot) to a private directory. Verify signed Ed25519 migration manifest, table and column inventory, primary keys, complete row hashes, SQLite integrity and foreign keys. Missing signatures or unexpected data stop the operation.
2. **Authenticated encryption and restore.** Encrypt the snapshot with AES-256-GCM. Derive per-archive keys using HKDF-SHA256 and a random 16-byte salt; use a random 12-byte nonce and a 16-byte GCM tag. The AAD binds the archive to the signed tenant UUID and SHA-256 of its trusted migration manifest. The archive is persisted only temporarily, decrypted into a separate private SQLite file, and verified against source snapshot bytes. No plaintext backup is returned through the API. All sensitive temporary files are deleted before returning.
3. **Money and workflow integrity + journal.** Independently run R4.4 payment integrity, idempotency, exact integer money aggregations, automations, custom entities and reference validation on the source snapshot and the restored snapshot. Require matching keyed financial totals HMAC, table counts, and full byte hashes; refuse mismatches. Publish **only sanitized counts and hashes** to an HMAC-chained, mode-0600 evidence file.
4. **Owner-only HTTP and true PostgreSQL 15/16 acceptance.** POST `/api/studio/pg-preview/projects/:id/backup-drill/check`, GET `.../history`; Studio owner authorization, CSRF, Origin and disabled-by-default feature flags before data access. Tests reject wrong keys, tampered ciphertext, wrong tenant binding, forged evidence and cross-tenant access. PostgreSQL 15/16 CI verifies real signed import, backup/restore with **populated** synthetic financial/workflow/custom tables, source unchanged, and previous R4.0–R4.4 gates.

## Enable ONLY in an isolated synthetic test environment

Prerequisites are R4.0 trust bundle and external key, plus
`OX_R40_EPHEMERAL=YES`, `OX_R43_SHADOW_REPLAY=YES`, `OX_R43_CONFIRM_SYNTHETIC=YES`,
`OX_R44_CRITICAL_PARITY=YES`, `OX_R44_CONFIRM_SYNTHETIC=YES`,
`OX_R45_BACKUP_DRILL=YES` and `OX_R45_CONFIRM_SYNTHETIC=YES`.
The external `OX_R42_JOURNAL_HMAC_KEY` must be exactly 32 bytes, encoded as 64 hex characters. The key must never be placed in the repo.

`npm run test:r45` and the GitHub CI PG 15/16 matrix are the authoritative test gates.
No API accepts a destination file path or changes the original SQLite, and no persistent decryptable backup is produced.

## Limitations / blockers

- The ephemeral encrypted archive is **destroyed at the end of the drill**. It does not yet implement scheduled backup retention, durable offsite storage, key escrow or key rotation. These require separate implementation and operational review.
- No production write freeze, cross-engine coordinated snapshot or CDC tail; real customer restoration has not been rehearsed.
- No external payment settlement or cash reconciliation was performed; the comparison checks only locally signed CRM ledger rows.
- HMAC-chained evidence detects edits to retained history but not deletion of the entire history without independent external anchoring.
- `productionCutoverAllowed=false` is always returned. A green test cannot authorize deployment, live settlement, or production database migration.
