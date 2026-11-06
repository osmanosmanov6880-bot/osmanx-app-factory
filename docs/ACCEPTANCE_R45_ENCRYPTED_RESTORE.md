# OSMANX APP FACTORY R4.5 — signed encrypted restore acceptance

**Date:** 2026-11-06  
**Branch:** `feat/r45-encrypted-backup-recovery`  
**Tested commit:** `3971a79e07bfa0f415eeebe5b8dc1936aa2f9a84`  
**Pull request:** [PR #4](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/pull/4)  
**GitHub Actions:** [run 42176732997](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/actions/runs/42176732997)

## Independent PostgreSQL matrix

| Database | Unit test suites | HTTP + signed import + encrypted restore |
|---|---|---|
| PostgreSQL 15 | 70/70 passed | 89 synthetic E2E checks; SUCCESS |
| PostgreSQL 16 | 70/70 passed | 89 synthetic E2E checks; SUCCESS |

Unit counts per matrix entry: R4.5 13, R4.4 10, R4.3 18, R4.2 6, R4.1 15, R4.0 8. In both PostgreSQL jobs, the synthetic integration receipt explicitly reported `r45EncryptedRestoreVerified: true`.

## Verified functional coverage

1. Owner-only, explicitly opted-in backup drill; revoked sessions, invalid CSRF, untrusted Origin and cross-tenant access are rejected.
2. Read-only backup of an Ed25519-signed CRM SQLite snapshot, private temporary file, no writes to primary.
3. Per-archive random salt and nonce, HKDF-SHA256/AES-256-GCM authenticated encryption, tenant UUID and signed-manifest SHA-256 bound as additional authenticated data.
4. Authenticated decryption and restoration into a distinct SQLite, byte-for-byte equality, SQLite `integrity_check` and `foreign_key_check`.
5. Signed inventory, complete row hashes, payment records and exact minor-unit financial HMAC, workflow and custom-entity semantic integrity.
6. HMAC-chained private restoration evidence with tamper-detection tests; no client names, amounts, card details or raw source database bytes returned through the HTTP API.
7. Temporary snapshot/archive/recovered database removal in `finally`. The workflow does not retain a customer backup after completing the rehearsal.
8. Crypto negative tests: changed ciphertext, tag, key, tenant, manifest hash and unsafe archive sizes. Persistent PostgreSQL remains Preview only.

## Strict non-production boundaries

- **Not a durable backup service.** No scheduled backups, remote/offsite retention, restore catalog, rotation, key escrow, disaster recovery SLA or recovery time objectives.
- **No data migration cutover.** Independent PostgreSQL/SQLite snapshots are not one atomic transaction; no CDC and no coordinated production write freeze.
- **No external payment settlement check.** Financial integrity is limited to signed CRM records in the synthetic fixture.
- **Journal tampering caveat.** An independently anchored digest is needed to detect deletion of the entire audit history.
- **No deployment.** The baseline production runtime is still SQLite. `productionCutoverAllowed=false`. No PR merged into `main` by this test.

Keep R4.5 as a draft PR until separate code/security review; its green CI is necessary but not sufficient for production.
