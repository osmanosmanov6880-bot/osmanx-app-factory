# OSMANX APP FACTORY R4.7 — remote encrypted backup, schedule and recovery

**Scope: isolated synthetic CRM only.** This is not a production disaster-recovery service and does not authorize PostgreSQL migration.

## Four implementation blocks

1. **Encrypted offsite transfer.** The R4.6 vault's AES-256-GCM ciphertext is authenticated against its HMAC catalog before transfer. A fixed HTTPS endpoint (only synthetic loopback HTTP is permitted in tests) receives immutable, tenant-scoped encrypted objects. Bearer authorization is external to the repository. Redirects, arbitrary URLs, unexpected object keys, wrong hashes and unbounded responses are rejected. Each object is fetched back and verified before publication.
2. **Crash-safe remote catalog and independent recovery.** The client publishes all verified encrypted archives, then an immutable signed catalog object, and updates the remote head **last**. Interrupted copies leave no false-success head. Re-running synchronizes missing objects. Independent remote restoration works with only the remote encrypted archive, authenticated manifest and external keys—even after the entire local vault folder is removed. Restored SQLite passes signed whole-row, foreign-key, financial, automation and custom-entity checks.
3. **Scheduled operation and monitoring.** A per-tenant HMAC-protected checkpoint records `running`, `failed`, and `ok` states, enforcing backup interval, safe retry and stale status. Only specifically allowlisted test CRM IDs may be scheduled automatically; no blanket tenant scans. The status endpoint distinguishes lack of backup, failure, stale backup, and remote/local catalog disagreement. A green result requires both valid recent schedule proof and remote parity.
4. **Owner-only API and PostgreSQL 15/16 CI.** `GET /api/studio/pg-preview/projects/:id/offsite/status` and `POST .../sync`, `.../restore-check`, `.../tick`; owner authorization and CSRF/Origin checks occur before external actions. CI runs real signed synthetic CRM fixture import, independent remote receiver, forced temporary local vault loss, restart/key-rotation, tampered remote pointer and authenticated scheduled checks.

## Test-only runtime configuration

Enable all R4.0–R4.6 synthetic gates and supply:
- `OX_R47_OFFSITE=YES`, `OX_R47_CONFIRM_SYNTHETIC=YES`;
- `OX_R47_ENDPOINT=https://your-private-encrypted-object-service/`, `OX_R47_REMOTE_TOKEN=<external 64-hex secret>`;
- `OX_R47_INTERVAL_MINUTES=60`, `OX_R47_MAX_AGE_MINUTES=180`;
- `OX_R47_SCHEDULE_PROJECT_IDS=uuid1,uuid2` for explicit opt-in only.

The `OX_R47_LOOPBACK_TEST=YES` option permits HTTP only to `127.0.0.1` / `localhost` while the entire synthetic `OX_R40_EPHEMERAL=YES` setup is enabled. Never expose the bundled test receiver directly to the public internet. The receiver is an encrypted object API, not an S3 implementation.

## Limitations / fail-closed boundaries

- Not deployed to a remote server or attached to a real cloud bucket. It requires a separately hosted authenticated HTTPS receiver with independent storage and key custody. The CI receiver is on loopback only.
- The remote pointer can be rolled back by a compromised storage administrator; HMAC prevents undetected mutation but an externally anchored counter is needed to prevent replay of an *older valid* signed catalog.
- No durable offsite availability SLA, object-lock immutability assurance, region-level redundancy, monitoring integration, alert destination, operational RTO/RPO target or customer-data drills.
- A killed process can leave a stale schedule lock. The scheduler refuses to proceed until an operator investigates, rather than deleting a possibly active lock.
- No production payment processor/settlement cross-check, CDC, coordinated database write freeze or cutover approval.
- No production key material, customer data, payments or deployment is touched by R4.7. All responses set `productionCutoverAllowed=false`.
