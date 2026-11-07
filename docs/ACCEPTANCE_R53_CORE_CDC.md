# OSMANX APP FACTORY R5.3 — incremental transactional CDC engineering evidence

**Stacked Draft PR:** [#12](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/pull/12) based on unmerged R5.2.  
**Previously accepted executable SHA:** `83c6e67c357f9a80d50f93c068288106d03f33f0`.  
**Accepted core CI:** [run 42321469537](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/actions/runs/42321469537), both PostgreSQL versions SUCCESS.  
**Core tests:** **159 / 159** unit tests and **195** real PostgreSQL/S3-compatible MinIO E2E checks *per version*, including `r53IncrementalCommittedReplayAndObjectLockVerified: true`.

## Core functionality independently verified in CI

- Persistent opt-in SQLite AFTER triggers are part of the original business write transaction. Rollback removes the corresponding event; committed client, task and payment updates appear in monotonically increasing sequence.
- Encrypted AES-256-GCM incremental-only objects were uploaded to actual disposable MinIO with versioned S3 COMPLIANCE Object Lock and ciphertext read-back, then confirmed against a separate HMAC witness. An older **valid encrypted and HMAC-signed S3 pointer** was rejected.
- A sealed and authenticated R4.9 CRM baseline was reconstructed in an isolated SQLite file. Three events after the original backup, followed by a fourth task update, were replayed atomically. Test assertions confirmed restored payment amount, task state and client notes. The source signed baseline remained unchanged; replaying the stream twice did not change the record checksum.
- Each recovered SQLite passed integrity and foreign-key checks. The resulting receipt explicitly contained `lostFromCoveredCommittedSequence: 0` and `productionCutoverAllowed: false`.

## Additional security hardening after accepted core SHA

The subsequent branch commits add: explicit `DatabaseSync.isTransaction` checks, exact validation of every installed capture trigger SQL to detect a dropped/substituted trigger, private key-file handling and a separate `ops/r53/recover.mjs` executable that **reverifies the Ed25519 signed R4.9 baseline from S3** before applying independently witnessed incremental events. These changes add adversarial tests and another detached-process recovery run to the PostgreSQL 15/16 matrix. **Their final CI must be checked separately**; the earlier core SUCCESS is not automatic acceptance of later commits.

## Zero RPO: what is and is not proven

**Covered captured sequence: PASS (synthetic).** The testing cursor starts after a verified baseline; every one of its four later committed synthetic events was present in the independently replayed copy.

**Continuous production RPO: NOT PROVEN.** Capture is not enabled on the actual production primary; operations committed before the trigger installation, unsupported DDL/new tables, intentionally excluded sessions and entries not yet uploaded to offsite storage are not covered. Neither a signed snapshot nor a successful four-event replay demonstrates an actual near-zero production loss window.

**Independent infrastructure: NOT PROVEN.** Although test MinIO and both witnesses are separate services, all operate on one ephemeral GitHub runner. No external cloud account, distinct failure domains, real on-call service, production data or real payment settlement was connected.

Production database cutover remains blocked; `main` remains at `f2570d6c74c72b5f00a2b09740e905058476d32a`. Maintain Draft status and require new continuous capture, bounded backlog/retry, RPO watermark testing, independent security review and actual cross-host disaster recovery rehearsal before production use.

Operator and architecture notes: [R5.3 encrypted incremental recovery runbook](./RELEASE_R53_INCREMENTAL_REPLAY.md).
