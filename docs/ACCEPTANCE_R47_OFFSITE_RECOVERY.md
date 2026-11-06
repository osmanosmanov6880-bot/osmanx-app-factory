# OSMANX APP FACTORY R4.7 — synthetic encrypted offsite recovery acceptance

**Date:** 2026-11-06  
**Repository:** `osmanosmanov6880-bot/osmanx-app-factory`  
**Code commit independently tested:** `c04e6483e1ae15017f311b785ab0cd39a627e7f5`  
**PR:** [#6](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/pull/6)  
**GitHub Actions:** [run 42182753485](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/actions/runs/42182753485)

## PostgreSQL 15 and 16 results

| Target | Unit tests | True signed PostgreSQL + HTTP + remote receiver | Result |
|---|---:|---:|---|
| PostgreSQL 15 | 87/87 | 137 checks · `r47OffsiteIndependentRecoveryVerified: true` | SUCCESS |
| PostgreSQL 16 | 87/87 | 137 checks · `r47OffsiteIndependentRecoveryVerified: true` | SUCCESS |

Unit coverage per job: R4.7 10, R4.6 7, R4.5 13, R4.4 10, R4.3 18, R4.2 6, R4.1 15, R4.0 8.

## Four implemented blocks

1. **Encrypted fixed-endpoint remote transport and object receiver.** Uses preconfigured remote host and bearer credentials; HTTPS is mandatory except isolated loopback test. No redirects, dynamic user URLs or arbitrary object names. Remote stores authenticated ciphertext only. Objects are read back and SHA-256 verified before publishing the catalog.
2. **Safe, independently restorable replication.** Upload ciphertext objects first, immutable authenticated catalog second, remote pointer last. Interrupted uploads produce no prematurely committed pointer and can be repeated idempotently. The encrypted remote archive can be authenticated, decrypted and recovered to disposable SQLite even when the original local vault directory is disconnected. Signed CRM schema, finance, automation, custom entities, full row integrity and foreign keys are checked.
3. **Opt-in scheduler and health telemetry.** Per-project HMAC-protected checkpoint records running/failed/ok, retry cooldown, last successful backup and staleness. Only explicitly allowlisted synthetic CRM project IDs can run on a timer. Status requires a fresh successful schedule AND a matching remote catalog and now verifies the newest encrypted archive itself; a valid pointer with corrupted ciphertext cannot result in a healthy status.
4. **Owner-only secure API and PostgreSQL matrix.** Owner session, tenant access, CSRF/Origin and method gating occur before remote operations. E2E covers real signed import, remote publish, loss of local vault, independent restore, schedule tick suppression, restart and key rotation, stale remote detection, resync, unauthorized cross-owner action, and malicious remote pointer rejection.

## Security boundaries / remaining work

- All tests use only generated synthetic data. The remote receiver is an isolated loopback fixture on the same CI runner. **No independent cloud host, paid object-store account or actual offsite deployment was configured.** Passing this CI proves the protocol in a remote-process simulation, not geographic disaster resilience.
- The receiver is an authenticated object API; it is not S3-compatible, and production deployment needs independent TLS termination, access policies, operational key custody, network isolation, audit logging and durable storage.
- Remote catalog HMAC prevents modification without the key, but an older *valid* catalog may be replayed if the storage operator can roll back the head pointer. External monotonic anchoring and object immutability are required for production.
- The scheduler refuses overlapping/stale locks; stale-lock release still requires operator investigation and procedure. No customer-facing paging or alert routing is configured.
- No measured production RPO/RTO, external regional replication, real customer restore drill, payment processor settlement reconciliation, cross-engine CDC or coordinated SQLite/PostgreSQL cutover.
- `main` remains on SQLite R4.1. No release is merged to production. Every R4.7 receipt explicitly returns `productionCutoverAllowed=false`.

**Decision: synthetic engineering acceptance PASS; production readiness NOT APPROVED.** Keep PR #6 in draft until independent code, security and operations review. The evidence is the tested code commit above; later documentation-only changes should not be mistaken for retested executable code.
