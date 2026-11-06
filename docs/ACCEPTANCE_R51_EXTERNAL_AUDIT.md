# OSMANX APP FACTORY R5.1 — independent audit and signed alert acceptance

**Date:** 2026-11-06  
**Draft PR:** [#10](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/pull/10)  
**Tested executable commit:** `b8d2f424ebefbb0d6d6db558b6246f82cef3f3b9`  
**GitHub CI:** [run 42259146620](https://github.com/osmanosmanov6880-bot/osmanx-app-factory/actions/runs/42259146620)

## PostgreSQL matrix: independently reported SUCCESS

| Environment | Unit tests (R4.0–R5.1) | Real MinIO Object Lock and synthetic signed CRM/DR E2E | GitHub result |
| --- | ---: | ---: | --- |
| PostgreSQL 15 | 137 / 137 passed | 181 checks; `r51IndependentAuditAndSignedAlertVerified: true` | SUCCESS |
| PostgreSQL 16 | 137 / 137 passed | 181 checks; `r51IndependentAuditAndSignedAlertVerified: true` | SUCCESS |

**Unit suites per job:** R5.1 15; R5.0 18; R4.9 8; R4.8 9; R4.7 10; R4.6 7; R4.5 13; R4.4 10; R4.3 18; R4.2 6; R4.1 15; R4.0 8.

## Four implemented code blocks

1. **Independent signed audit anchor.** Separate 32-byte key, bearer and endpoint from S3 and the backup witness. The newest HMAC-verified R5.0 recovery PASS receipt's sequence/hash is anchored to a monotonic remote HMAC witness. The signed CRM remote catalog is verified first. A subsequent signed local entry makes the old remote audit anchor stale; the readiness gate rejects it until the new head is committed. Wrong bearer, mismatched signed remote catalog, stale receipt and latest FAIL block attestation. Test receiver state persists separately from the backup witness.
2. **Fresh, signed machine notification acknowledgement.** R5.1 emits a privacy-safe `DR_TEST` request with random nonce, opaque tenant token and time, using a fixed HTTPS endpoint and independently keyed HMAC. The receiver validates bearer, request signature, timestamp and length. The response is signed and must match that same nonce, tenant and current time. The test rejects signed replies with wrong nonce, wrong bearer, unsigned HTTP 200 and expired request. This is a cryptographically confirmed *machine receipt*, not human on-call/pager escalation.
3. **Four-endpoint trust-domain gate.** The storage endpoint, original backup witness, independent audit anchor and alert receiver are checked pairwise for distinct fixed origins and, for real public hosts, disjoint DNS-resolved addresses at check time. All five 32-byte keys — catalog, recovery evidence, witness, audit anchor and alert — must differ. Result accurately reports that DNS checks **do not** independently prove different cloud providers, administrative control, countries, or physical failure domains, and do not prevent DNS rebinding.
4. **Dedicated deployable receiver services, isolated verifier and real CI.** Separate non-root Docker images/Compose/TLS Caddy files are under `ops/r51/`, with private externally mounted token/key files. `ops/r51/verify.mjs` verifies signed remote state and machine acknowledgements in an opt-in synthetic test environment; its optional anchor commit requires `OX_R51_ANCHOR_COMMIT=YES` and a latest PASS receipt. PostgreSQL 15 and 16 execute predecessor signed-CRM, real disposable MinIO COMPLIANCE Object Lock, detached recovery and new R5.1 anti-replay/alert tests.

## Acceptance observations

- Real S3-compatible MinIO in isolated CI rejects object-version deletion under COMPLIANCE retention. All predecessor R4.0–R5.0 unit and real-Postgres E2E tests remain green.
- R5.1 creates a remote audit anchor from the local HMAC evidence ledger and verifies it independently; a newer local signed PASS makes the old anchor invalid until updated. The receiver refuses unauthorized access.
- A remote machine signs a challenge acknowledgement with the correct nonce and tenant; responses with wrong signature or nonce are rejected. No customer names, phone numbers or financial rows are sent.
- No modified code was merged to `main` or deployed to the live factory. The original SQLite runtime remains primary on commit `f2570d6c74c72b5f00a2b09740e905058476d32a`. Every R5.1 result sets `productionCutoverAllowed=false`.

## Important limits and production gates

- All integration data are **synthetic**. MinIO, the original witness, the R5.1 audit witness and the signed alert receiver run in separate processes/ports on **one GitHub runner**. This is not a test of distinct regions, cloud accounts, providers or disaster failure domains. No real external paid bucket or VPS was deployed or connected.
- The audit anchor stores a signed monotonic record but the receiver volume itself is not immutable or separately anchored to a trusted external WORM provider. A sufficiently privileged administrator controlling both the remote volume and its HMAC key can conceal rollback. Real immutable external anchoring, trusted retention policy, separate key custody and independent server recovery must be demonstrated.
- An alert machine's signed HTTP reply is **not** an on-call acknowledgement. No SMS/email/pager escalation, independent recipient, service contract or guaranteed human response has been configured.
- DNS checks occur before a network request and are not IP pinning or egress firewall isolation. Deployment must enforce TLS certificate checks, network egress restrictions, cloud provider authorization, DNS/rebinding protection and isolated credentials.
- `ops/r51` Compose files are deployable scaffolding, not production-reviewed or live infrastructure. Image provenance, current security patches, pinned digests, Docker secret permissions, DNS/certificates and host hardening require separate verification.
- This release does not measure real workload transactional RPO or contractual recovery RTO; neither production data nor payment processor settlements were exercised. No real customer data migration, PostgreSQL write fence, CDC, operational rollout, human security review or production cutover approval.
- `main` remains unchanged; all changes are in **Draft PR #10**, based on unmerged R5.0 work. Review/merge the full dependency chain only after external security and operations acceptance.

**Verdict:** Synthetic engineering acceptance **PASS** on PostgreSQL 15/16. Independent live cloud, immutable external audit anchor, on-call readiness and production disaster-recovery acceptance **NOT APPROVED**.

Operator instructions: [R5.1 external audit runbook](./RELEASE_R51_EXTERNAL_AUDIT.md).
