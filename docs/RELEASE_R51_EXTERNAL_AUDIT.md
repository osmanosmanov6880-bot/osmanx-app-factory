# OSMANX APP FACTORY — R5.1 independent audit and machine alert rehearsal

**Status:** Synthetic engineering implementation; no real external cloud infrastructure was provisioned. R4.9/R5.0 remain staged in Draft PRs. Production SQLite and `main` are unchanged. All R5.1 receipts return `productionCutoverAllowed=false`.

## Four implemented blocks

1. **Independently keyed external evidence anchor.** Uses a separate HMAC secret and bearer token with the R4.8 monotonic witness protocol but stores a *different chain*: the current R5.0 signed **evidence-ledger head** and count, bound to the CRM's signed manifest digest. An old valid local ledger head is rejected after a newer independently anchored entry is committed. It refuses the latest `FAIL` receipt and stale acceptance. Remote witness and S3 signed catalog are verified before anchoring. If a privileged attacker can roll back *both* the audit host and its HMAC keys, this is not an immutable external audit guarantee.
2. **Nonce-bound signed machine alert receipt.** A separate fixed HTTPS service accepts only `DR_TEST` signed HMAC requests with opaque tenant tokens, current timestamps and cryptographic nonces. The client accepts success *only after* validating an independently HMAC-signed response that repeats the nonce/tenant/time. HTTP 200 alone, a copied signature, wrong bearer or an old nonce are failures. This proves a machine receiver replied; **no real human on-call, SMS, pager or escalation acknowledgement** is implemented.
3. **Four-endpoint & secret-domain fail-closed readiness.** Storage, backup witness, external audit anchor and alert receiver must have distinct origins; for public endpoints their DNS-resolved addresses cannot overlap at check time. Catalog, witness, audit, evidence and alert keys must all be separate 32-byte secrets. The result never claims independent cloud account ownership, geographic fault-domain isolation, DNS-rebinding protection, or production readiness.
4. **Independent deployable services and PostgreSQL 15/16 CI.** `ops/r51/` contains separate non-root Docker service images, TLS Caddy reverse proxies, private file-based key mounts and a read-only-by-default operator verifier. Real S3-compatible MinIO with COMPLIANCE Object Lock, signed CRM Postgres matrix, malicious remote-head replay, audited R5.0 restore, separate audit receiver and signed test-alert receiver run in GitHub Actions. The audit and alert services run in separate processes/ports on **one CI runner**, not on truly independent VPS hosts.

## Deploy only on operator-controlled test infrastructure

The two receivers are intentionally separate compositions. Deploy the audit-anchor service on an operator-managed VPS that **is not** the object storage provider and is **not** the backup witness host. Deploy the alert machine receiver on an independent network/host. Both require dedicated DNS A/AAAA, TLS on port 443 and operator-controlled signing keys.

From repository root on each **separate** machine, after secret setup:
- Audit host: `docker compose -f ops/r51/anchor.compose.yml up -d --build`
- Alert host: `docker compose -f ops/r51/alert.compose.yml up -d --build`

Required audit host variables: `OX_R51_ANCHOR_DOMAIN`, `OX_R51_ANCHOR_TOKEN_FILE`, `OX_R51_ANCHOR_HMAC_FILE`. Required alert host variables: `OX_R51_ALERT_DOMAIN`, `OX_R51_ALERT_TOKEN_FILE`, `OX_R51_ALERT_HMAC_FILE`. Put tokens and keys in **different 0600 files** outside Git. Require up-to-date, supply-chain-reviewed/pinned Docker images and HTTPS certificates before external exposure. Do not reuse the original backup witness's HMAC key.

The audit receiver persists state locally. For meaningful rollback resistance it still needs independently controlled immutable storage of its own latest head; otherwise a privileged host administrator can replace the entire volume and conceal truncation.

## Operator-side verification

From an isolated synthetic test host, configure `OX_R40_EPHEMERAL=YES`, `OX_R51_SYNTHETIC_ONLY=YES`, the project ID, externally trusted manifest hash, four endpoints and all S3 details. Provide the separate HMAC keys and bearer tokens via private absolute-path files:
`OX_R51_CATALOG_KEY_FILE`, `OX_R51_WITNESS_KEY_FILE`, `OX_R51_EVIDENCE_KEY_FILE`, `OX_R51_ANCHOR_KEY_FILE`, `OX_R51_ALERT_KEY_FILE`, `OX_R51_WITNESS_TOKEN_FILE`, `OX_R51_ANCHOR_TOKEN_FILE`, `OX_R51_ALERT_TOKEN_FILE`; also `OX_R51_EVIDENCE_DIRECTORY`, `OX_R51_STORAGE_ENDPOINT`, `OX_R51_WITNESS_ENDPOINT`, `OX_R51_ANCHOR_ENDPOINT`, `OX_R51_ALERT_ENDPOINT`, `OX_R51_S3_BUCKET`, `OX_R51_S3_REGION`, `OX_R51_S3_ACCESS_KEY`, `OX_R51_S3_SECRET_KEY`, `OX_R51_SIGNED_MANIFEST_SHA256`, `OX_R51_PROJECT_ID`.

Run `node ops/r51/verify.mjs` to verify **existing** external anchor and signed alert reception. To explicitly commit the latest **PASS** recovery receipt to the independent audit service first, set `OX_R51_ANCHOR_COMMIT=YES` for that one operation; never enable the commit flag unconditionally in a timer. `OX_R51_LOOPBACK_TEST=YES` is for isolated local synthetic CI only.

## Still not production-ready

- No provider account, live S3 bucket, separate VPS/domain, on-call service subscription, regional loss simulation, independent cloud IAM audit, or customer-data disaster recovery is provisioned here.
- The audit receiver's host is not itself cryptographically immutable; an **independently anchored external hash** or genuinely WORM provider is still required to survive privileged volume rollback.
- There is no human on-call acknowledgement; a signed machine response must not be reported as real incident resolution.
- GDPR/data residency review, safe retention window, storage supply chain, external TLS and secret-custody procedures remain operational prerequisites.
- Measured synthetic backup age is not transaction-level RPO. Synthetic recovery elapsed time is not contractual production RTO.
- No source-primary write fence, PostgreSQL cutover, payment processor reconciliation or acceptance of real customer data.

This stage remains Draft and is only admissible after GitHub PostgreSQL 15/16 CI succeeds. Never merge or deploy before independent security/operations/data-owner approval.
