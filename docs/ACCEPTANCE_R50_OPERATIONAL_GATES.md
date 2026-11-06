# OSMANX APP FACTORY — R5.0 synthetic operational DR acceptance

**Date:** 2026-11-06  
**Repository:** `osmanosmanov6880-bot/osmanx-app-factory`  
**Pull request:** [#9 — DR operational gates](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/pull/9)  
**Tested executable commit:** `7ea69fa2bd345e35fe9b0592850df4eb4150b6d7`  
**CI evidence:** [GitHub Actions run 42224151912](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/actions/runs/42224151912)

## PostgreSQL 15 and 16 acceptance

| Job | Unit tests | Full synthetic signed CRM and genuine MinIO end-to-end checks | Result |
| --- | ---: | ---: | --- |
| PostgreSQL 15 | 122 / 122 | 175, `r50SyntheticOperationalGateAndDetachedRecoveryVerified: true` | SUCCESS |
| PostgreSQL 16 | 122 / 122 | 175, `r50SyntheticOperationalGateAndDetachedRecoveryVerified: true` | SUCCESS |

Per-job suites: R5.0 **18** tests; R4.9 **8**; R4.8 **9**; R4.7 **10**; R4.6 **7**; R4.5 **13**; R4.4 **10**; R4.3 **18**; R4.2 **6**; R4.1 **15**; R4.0 **8**.

### Four implemented engineering blocks

1. **External topology and HTTPS preflight.** A DNS-aware preflight refuses same-origin endpoints, overlapping public DNS addresses, private IP responses, alternate insecure ports and arbitrary path/query/userinfo. Synthetic tests explicitly support same-host loopback only with opt-in. Different DNS or IP addresses do **not** independently establish provider ownership or regional fault-domain separation. No promise of DNS-rebinding protection is made.
2. **HMAC-authenticated audit evidence.** Append-only, chained, fsynced, private 0700/0600 evidence logs store only sanitized signed-recovery PASS/FAIL, backup age, elapsed recovery time, opaque tenant token and catalog digest. Wrong signer key, tampering, torn writes, symlinks and stale locks are rejected. The ledger **has no external immutable anchor**, so removal of the whole directory is outside its threat coverage.
3. **Witnessed isolated recovery operation.** After R4.9's real S3-compatible MinIO COMPLIANCE archive/version and independent witness validation, R5.0 checks that the catalog remains unchanged during detached recovery, verifies private restored SQLite output, measures elapsed recovery time and age of the last witnessed backup against explicit limits, and writes authenticated PASS/FAIL evidence. Stale backups are denied acceptance. Full signed CRM financial records remain intact; primary SQLite remains unchanged.
4. **Three detached Ed25519 reviewer signatures and clean-process restoration.** Detached signatures from distinct security, operations and data-owner keys bind the exact tested code, witness catalog and evidence head, with expiry. Duplicate keys/roles, forged code/evidence and expired reviews fail closed. The synthetic CI generates three test signing keys in one test runner — it **does not authenticate three real human reviewers**. The GitHub integration also starts the standalone R4.9 recovery CLI in a separate Node process using only S3, signed migration manifest, independent witness and external synthetic keys, without passing access to the source vault directory.

### Errors caught and resolved before acceptance

- The first R5.0 unit pass failed two signature tests because Node `createPublicKey` was called on an already-public `KeyObject`. The verifier now accepts PEM-encoded public keys and existing Ed25519 public-key objects while retaining strict signature validation.
- Re-run on tested commit `7ea69fa2` passed both PostgreSQL matrices, all 122 unit tests and all 175 real-Minio/synthetic-CRM E2E checks. Previous failed or cancelled runs are not acceptance evidence.

### Operational blockers — do not equate CI with production

- **No real independent cloud bucket or witness VPS was provisioned.** The genuine MinIO process and witness receiver operate in separate processes on one ephemeral CI runner, not across physically separated infrastructure. No actual DNS/TLS or cloud account owner attestation was performed.
- CI signs three approvals with ephemeral generated keys; this is cryptographic protocol testing, not review by actual independent security/operations/data-owner staff. User identity, authorization and sign-off workflows require separate handling.
- The private evidence chain is not exported to an independently controlled immutable audit system. Witness availability, emergency key custody, provider IAM access, actual cloud Object Lock compliance and alert escalation have not been rehearsed off the runner.
- Synthetic restoration elapsed time is not a customer-facing RTO commitment. The age of the last signed backup is not transaction-loss RPO; real workload watermarks and failure injection are needed.
- No production customer-data drill, regional-loss simulation, third-party payment settlement reconciliation, CDC, coordinated SQLite/PostgreSQL write fence, data protection/legal retention authorization or independent security/supply-chain review.
- The MinIO CI test image is unofficial and digest-pinned for disposable synthetic testing only. Do not deploy it to an internet-facing or long-lived production environment.
- `main` and the primary SQLite remain unchanged at `f2570d6c74c72b5f00a2b09740e905058476d32a`. All new receipts explicitly set `productionCutoverAllowed=false`. PR #9 remains Draft.

**Decision:** R5.0 synthetic engineering acceptance PASS; **real independent infrastructure and production disaster-recovery readiness NOT APPROVED**. Keep PR #9 in Draft pending external provisioning, real operator sign-off, independently anchored evidence and third-party security/operations review.

**Related runbook:** [R5.0 operational guidance](./RELEASE_R50_EXTERNAL_DR_GATES.md).
