# OSMANX APP FACTORY R4.6 — verified synthetic retained-backup acceptance

**Date:** 2026-11-06  
**Repository:** `osmanosmanov6880-bot/osmanx-app-factory`  
**Tested code commit:** `b2de9e244428a8b7dbe2c59a80b2313170bd3551`  
**Pull request:** [#5](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/pull/5)  
**GitHub Actions:** [run 42179778579](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/actions/runs/42179778579)

## PostgreSQL 15 and 16

| Target | Unit tests | Synthetic signed CRM end-to-end | Conclusion |
|---|---:|---:|---|
| PostgreSQL 15 | 77/77 | 114 checks, `r46RetainedEncryptedVaultVerified: true` | SUCCESS |
| PostgreSQL 16 | 77/77 | 114 checks, `r46RetainedEncryptedVaultVerified: true` | SUCCESS |

Unit test breakdown per database: R4.6 7, R4.5 13, R4.4 10, R4.3 18, R4.2 6, R4.1 15, R4.0 8.

## Verified scope

- Signed CRM source snapshot from R4.5 with independent SQLite restore and whole-table checks before registering a retained archive.
- Random HKDF salt and AES-256-GCM nonce per archive; ciphertext remains on disk in private files; source SQLite is never overwritten.
- Persistent HMAC chained, tenant-bound, signed-manifest-bound catalog with versioned encrypted archives.
- Cross-process/restart persistence, owner/session/CSRF enforcement, and explicit denied operations for a foreign organization.
- Key rotation by copy while preserving the original archive, then comparing signed financial HMAC and table inventory.
- Explicit retention keeping at least two previously verified archives, tombstone before old encrypted file removal.
- Archive tampering, catalog edits, missing encryption key, wrong-tenant binding, orphaned blobs and stale lock files tested as fail-closed.
- Both PostgreSQL versions exercised real signed import of populated synthetic CRM financial, automation and custom-entity fixtures.

## Material limitations

1. The storage is **local, same-disk persistence**, not offsite backup or protection against disk loss, fire or ransomware.
2. The file catalog HMAC chain is not anchored externally. Deletion of the entire catalog and archive directory is not independently detectable.
3. A crash at the archive/catalog commit boundary can leave an unindexed encrypted file. The vault intentionally refuses further use until an operator investigates; no automated orphan recovery exists.
4. The service does not schedule periodic backups or provide a measured RPO/RTO, alerts, key escrow/rotation authorization or emergency offline restoration procedure.
5. Cross-engine CDC, write freeze, full payment processor settlement validation and real-customer restore testing are absent.
6. CI is a synthetic test: it does not establish production-readiness or authorize migration. `main` and the primary SQLite runtime remain unchanged, and every exposed receipt explicitly denies production cutover.

Keep PR #5 in draft pending independent code/security/operations review. The acceptance of R4.6 requires this report and an unmodified successful run.
