# OSMANX APP FACTORY R4.8 — synthetic independent recovery evidence

**Do not deploy this version against real customer data.** The R4.8 recovery checks are a synthetic-only extension of R4.7. SQLite remains primary; `productionCutoverAllowed=false` in all receipts.

## Four engineering blocks

1. **S3-compatible SigV4 encrypted object transport.** A fixed HTTPS endpoint, configured bucket, key prefix, access key and region are required; AWS Signature V4 signs each request with SHA-256. Remote objects carry *only* R4.6 AES-256-GCM ciphertext, signed catalog bytes and a signed latest-pointer. The adapter uses conditional PUT for immutable keys, reads back conflicts, rejects redirects, query/path abuse and unsupported keys. On each protected sync, S3 bucket versioning and Object Lock must be enabled. A synthetic loopback HTTP exception exists solely under the explicit isolated test flags.
2. **Independent monotonic witness.** A separate signed HMAC witness service holds the highest accepted catalog sequence and hash for a tenant. The witness and encrypted object store must have different endpoint origins and separate externally supplied credentials. A valid but older signed remote pointer fails if its hash/count no longer matches the witness. The remote pointer is only published *after* readback-verified encrypted blobs. The witness receiver uses private files, server-side locks and monotonic compare-and-advance. Real independent witness infrastructure has not been provisioned.
3. **Privacy-safe durable alerts.** A signed local outbox queues only allowlisted backup error codes, an opaque tenant token and a random alert ID; no CRM rows, names, invoice amounts or keys. Delivery uses a fixed HTTPS webhook with a separate HMAC signing key, retry/backoff, failure persistence and pending-alert health. A synthetic loopback webhook verifies the signed body.
4. **Measured disaster-restoration acceptance.** R4.8 measures elapsed RTO for signed restoration from independent encrypted remote copies and reports *confirmed backup age* as a proxy for the most recent recoverable point. This is **not** a measured production transaction-loss RPO. Stale backups and slow restores produce alerts. Owner-only HTTP routes allow sync, drill, status and alert flushing; only explicit synthetic projects may be monitored. CI PostgreSQL 15/16 additionally tests a rollback to an older *valid signed* head, witness rejection, alert delivery, restore after correction, restart and key rotation.

## External configuration (synthetic-only)

Enable all signed R4.0–R4.7 gates and:
- `OX_R48_PROTECTION=YES` and `OX_R48_CONFIRM_SYNTHETIC=YES`
- `OX_R48_WITNESS_ENDPOINT=https://separate-witness-host/`
- `OX_R48_WITNESS_TOKEN=<external-long-token>`, `OX_R48_WITNESS_KEY_HEX=<64 hex>`
- `OX_R48_ALERT_ENDPOINT=https://alert-receiver/`
- `OX_R48_ALERT_QUEUE_KEY_HEX=<64 hex>`, `OX_R48_ALERT_WEBHOOK_KEY_HEX=<different 64 hex>`
- Optional `OX_R48_USE_S3=YES`, `OX_R48_S3_ENDPOINT=https://s3-compatible-endpoint/`, `OX_R48_S3_BUCKET`, `OX_R48_S3_REGION`, `OX_R48_S3_ACCESS_KEY`, `OX_R48_S3_SECRET_KEY`, optional temporary session token.
- `OX_R48_MAX_RTO_MS` and `OX_R48_MAX_CONFIRMED_BACKUP_AGE_MS` set strict synthetic drill targets.

All crypto secrets belong in environment or a secret vault, not in Git.

## Current limitations

- No real cloud or independent witness host has been connected. CI S3 wire semantics use a loopback simulator; the existing R4.7 encrypted object receiver and a separate synthetic witness process validate the complete disaster-recovery protocol.
- Bucket-level Object Lock configuration is checked but actual time-bound WORM retention enforcement against a malicious cloud administrator is not yet independently tested. Versioning/Object Lock configuration does not by itself prevent deletion using suitably privileged credentials.
- The witness receiver is a reference implementation, not a geographically independent, audited, high-availability external anchor; OS administrator rollback can still compromise its local state.
- RPO cannot be established without a live-write workload and a measured last-committed transaction counter. Reported recovery-point age is only time since the last witnessed backup.
- No production incident on-call ownership, paging service, cloud secret custody, hardened TLS deployment, external integrity witness SLA, tenant-specific authorization review or full payment settlement check.
- Production data migration and cutover remain blocked; no real payments, SQLite production databases or `main` branch are changed.
