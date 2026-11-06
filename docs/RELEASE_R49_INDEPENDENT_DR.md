# OSMANX APP FACTORY — R4.9 independent disaster recovery

**Scope: isolated synthetic data; production migration and live payments remain blocked.**

## Four major implementation blocks

1. **S3 WORM verification.** The existing SigV4 transport now probes both bucket settings and each actual object version using S3 HeadObject. For every encrypted archive, the signed catalog object and the mutable current pointer, it demands enabled bucket versioning, a default COMPLIANCE retention policy, an actual version ID, a future retain-until timestamp and COMPLIANCE mode. The independent witness advances *only after* all encrypted objects are read back and confirmed locked. This is stronger than checking that Object Lock is merely enabled.
2. **Deployable witness.** An independent Node witness receiver with private file-mounted credentials, persistent data volume, non-root runtime and Caddy HTTPS reverse proxy is in ops/r49. It must run on a *different* machine/operator/provider from the object store to provide meaningful anti-rollback evidence. Docker Compose and Caddyfile are supplied as deployable scaffolding, not as claims of a live deployment.
3. **Real offline recovery path.** ops/r49/recover.mjs decrypts authenticated remote S3 archives using externally supplied keys, checks the independent monotonic witness, verifies the signed Ed25519 CRM manifest and restored SQLite including referential, financial and custom-entity integrity, then writes a unique private SQLite snapshot. The program will not overwrite any original database, touch SQLite production, run payments or switch PostgreSQL. A separate operator must approve any later import.
4. **True S3/PG regression.** GitHub Actions starts an actual isolated MinIO object server, initializes a bucket with versioning and 7-day COMPLIANCE retention, then checks real SigV4 S3 requests and a rejected attempt to delete a protected version. In addition, each PostgreSQL 15 and 16 job runs the entire synthetic R4.0–R4.8 CRM/API suite, creates a signed encrypted CRM archive, detects rollback of a *valid signed* S3 current pointer and performs independently witnessed offline recovery after loss of access to local vault storage.

## Independent witness VPS deployment (operator action required)

1. Select a separate server/network from object storage. Point a dedicated DNS A/AAAA record at it; allow TCP 80/443 only. Port 9080 remains private.
2. Create two independent high-entropy values as **separate 0600 secret files**: a bearer token (32–256 allowed characters) and a 32-byte HMAC key (64 lowercase hex). Do not put values in Git, chat, issue comments or CI logs.
3. From the repo root, export OX_R49_WITNESS_DOMAIN, OX_R49_WITNESS_TOKEN_FILE and OX_R49_WITNESS_KEY_FILE with the fully-qualified private file paths. Run: docker compose -f ops/r49/compose.witness.yml up -d --build. Inspect the images for CVEs and pin production-tested digests before go-live.
4. Confirm HTTPS health at https://YOUR-WITNESS-DOMAIN/healthz and authenticated monotonic witness GET/POST. Back up the witness's state independently; anchor the latest witness hash to another immutable audit service to defend against privileged rollback of the witness host.

This repository cannot establish DNS ownership, cloud purchasing rights, physical server separation or an audited independent operating environment. All of those must be verified after actual deployment.

## S3 storage requirements

Use a provider and bucket under operator control with SigV4, versioning, COMPLIANCE Object Lock retention and object-version metadata support. Restrict application access to one tenant prefix, enable audit logging and use separate scoped credentials from witness access.

**Important:** COMPLIANCE is a legally significant retention decision: a protected version cannot ordinarily be deleted until its retention expires. Do not blindly set 7 days for real customer data; agree a retention policy first. This repository creates the 7-day bucket **only in disposable CI MinIO**, never in an external account.

Required env names for isolated operator recovery: OX_R40_EPHEMERAL, OX_R49_OFFLINE_DR_SYNTHETIC, OX_R49_PROJECT_ID, OX_R49_SIGNED_MANIFEST_SHA256, OX_R49_SIGNED_BUNDLE_DIR, OX_R49_TRUSTED_PUBLIC_KEY_FILE, OX_R49_RECOVERY_DIR, OX_R49_CATALOG_HMAC_KEY_HEX, OX_R49_BACKUP_KEY_ID, OX_R49_BACKUP_KEY_HEX, optional old key ID/HEX, OX_R49_S3_ENDPOINT, OX_R49_S3_BUCKET, OX_R49_S3_REGION, OX_R49_S3_ACCESS_KEY, OX_R49_S3_SECRET_KEY, OX_R49_WITNESS_ENDPOINT, OX_R49_WITNESS_TOKEN, OX_R49_WITNESS_KEY_HEX.

Run node ops/r49/recover.mjs on a clean, isolated test host after provisioning trusted keys. HTTP loopback is supported only when OX_R49_LOOPBACK_TEST=YES together with OX_R40_EPHEMERAL=YES and isolated synthetic test data.

## What remains blocked

- No real external account, cloud bucket or independent witness server has been deployed, configured or verified as part of this PR.
- CI's MinIO and witness are distinct processes, but share one GitHub runner. A successful CI is **not a regional disaster-recovery or external-server test**.
- No customer-data DR drill, external provider IAM review, audited TLS, independent immutable witness audit anchor, actual pager recipient or operational key custody procedure.
- No production RPO from committed transaction watermarks; recovery time here is measured on synthetic data and not a production RTO commitment.
- No coordinated PostgreSQL/SQLite write fence, CDC, real payment settlement reconciliation or approved production database cutover.
- The production SQLite and main branch are not altered; all R4.9 proofs retain productionCutoverAllowed=false. Keep PR draft pending independent security and operational review.

## Acceptance rubric

- Unit tests for R4.9 WORM safeguards, independent witness process restart and fail-closed signed catalog commitment must pass.
- Existing R4.0–R4.8 suites must remain green on real PostgreSQL 15 and 16.
- Real disposable S3 MinIO must reject DELETE of an unexpired COMPLIANCE-protected *version ID* and report immutable HeadObject metadata for all signed backups.
- Independently witnessed restoration must reject an older valid remote head and recover signed customer, payment and task records after pointer repair using no original vault disk.
- GitHub CI success proves only synthetic engineering readiness, not production DR acceptance.
