# OSMANX APP FACTORY R4.6 — retained encrypted CRM vault

This release implements **opt-in persistent local encrypted copies for isolated synthetic CRM fixtures**. It does not claim production backup or offsite disaster recovery readiness. SQLite remains primary, and PostgreSQL remains Preview.

## Four engineering blocks

1. **Retained encrypted archive store.** Uses R4.5 Ed25519 signed CRM manifest, snapshot copy and full row/integrity checks before storing AES-256-GCM archive. Archive keys come exclusively from externally supplied 32-byte environment secrets, with per-archive random salt, nonce, and HKDF key derivation. No CRM row plaintext is served in HTTP responses.
2. **Authenticated catalog + retention.** Each 0700 directory contains 0600 encrypted archives and an append-only HMAC chained `catalog.jsonl`. Every event binds the signed project and manifest. Unknown/orphan archives, symlinks and missing files block access. Retention is **explicit** (`POST .../prune`), keeps at least two copies, decrypts every active archive first, records a tombstone before deleting the old ciphertext. A stale lock stops writes rather than allowing overlapping instances.
3. **Key rotation with full restore verification.** A new active key may be provisioned while a previous key remains available. Rotation creates a **new** encrypted copy, verifies it against signed CRM and monetary HMAC, and leaves the old archive untouched. No automatic key deletion.
4. **Owner-only API and PostgreSQL CI.** `GET .../backup-vault/list`; `POST .../backup-vault/create`, `verify/:id`, `rotate/:id`, `prune`. User-supplied destinations, key material and arbitrary filenames are not supported. Requests check owner session, project boundary, CSRF and Origin before accessing backups. PostgreSQL 15/16 synthetic E2E verifies populated CRM copies, restart persistence, cross-tenant denial, key rotation, and safe pruning. Unit tests cover tamper detection, wrong keys, retention and stale locks.

## Explicit synthetic-only setup

Enable all predecessor R4.0–R4.5 gates, `OX_R40_EPHEMERAL=YES`, and the additional R4.6 flags `OX_R46_VAULT=YES`, `OX_R46_CONFIRM_SYNTHETIC=YES`, `OX_R46_ACTIVE_KEY_ID=key_one`, `OX_R46_ACTIVE_KEY_HEX=<64 hex chars>`, `OX_R46_CATALOG_KEY_HEX=<different 64 hex chars>` and optional `OX_R46_RETENTION_COUNT=3` (2–20). For rotation, set a different active key ID/key and retain the old key in `OX_R46_PREVIOUS_KEY_ID`, `OX_R46_PREVIOUS_KEY_HEX`. Never store secrets in Git.

## Limits and honest readiness

- **Only same-disk durability:** copies persist through process restart. There is no offsite storage, cross-device redundancy, quota supervisor, backup scheduler, independent retention approval or externally anchored catalog head.
- Files must remain in one consistent vault; a crash between archive creation and catalog append can leave an orphan file, which blocks the vault until an operator reconciles the filesystem. A crash after a retirement tombstone may leave an extra retired ciphertext file.
- No regular production key custody, operator alerting, retention compliance, restore-time objective or disaster recovery testing on real data.
- No cross-engine CDC or coordinated write freeze. No external bank or payment processor settlement verification.
- `productionCutoverAllowed=false` in all receipts. R4.6 must remain a draft PR until PG 15/16 CI, code review and operational testing succeed.
