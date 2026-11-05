# OSMANX APP FACTORY — R3.1 Preview engineering report

**Date:** 2026-11-05  
**Code ancestry:** local R1.3 + preview additions R2.4–R3.1; not a verified update of the missing original R2.3 code. The `package.json` engine version remains `1.3.0` deliberately. No public production deployment performed. The dark Russian-language OBSIDIAN interface is preserved.

## Engineering changes

1. Added `deploy/upgrade.mjs resume --confirm` for the previously blocked `manual-review-required` state (uncertain gateway activation). It refuses unconfirmed operations, wrong app identity, wrong release sequence, absent trusted signer, mismatched on-disk SHA-256, or failed Ed25519 signature verification.
2. The forward recovery first rechecks the signed current app, stops any gateway ingress, restarts the same new app, observes Docker health, then reopens gateway. It **never restores a prior SQLite database snapshot** after possible traffic exposure. Failed observation/activation keeps the incident open with the gateway stopped if possible.
3. Standalone CRM and site `/api/health` responses contain a minimal public deployment identity: `deployment.projectId`, `deployment.releaseSequence`, plus existing `service` and `ok`. No customer data, setup tokens, or private keys.
4. `deploy/verify-live.mjs --live` now validates a publicly trusted certificate and exact expected app type/project UUID/release sequence based on the *local* deployment manifest. It pins a public IPv4 DNS response and refuses redirects, wrong backend, private addresses and non-JSON/unhealthy replies. The request has no cookies, authorization headers or customer data.
5. `.github/workflows/r31-release-acceptance.yml` and `scripts/r31_docker_e2e.mjs` add an opt-in **real-Docker** acceptance scenario using only synthetic SQLite data and no published ports: signed upgrade, forced rollback, ambiguous activation, forward resume, preserved writes.
6. OBSIDIAN deployment wizard includes a compact Russian explanation of the operator procedure; no visual redesign.

## Tests and evidence

Run `npm run check && npm test` from the unpacked factory. Initial engineering pass: **85/85 Node tests**, plus Chromium 1440/390 static mocked-API checks. Recheck these on the final packaged source. The suite includes R3.1 tests for authentic signed release recovery, preservation of SQLite writes, refusing tampering and wrong publisher key, real standalone HTTP starts for both app types, and a **real local TLS connection** with a short-lived local CA for the expected identity. Local TLS is not a real public certificate.

Backward compatibility with the supplied original R3.0 sample RESTAURANT CRM and SITE kits was additionally verified offline: sequence 0→1, signed package accepted, old SQLite synthetic record preserved, Docker adapter simulated.

Generated industry archives may be tested with `npm run samples:r31` and `npm run verify:samples:r31`; they use demonstration `.example.com` domains and do not deploy remotely.

**Not executed in this environment:** Docker Engine acceptance (Docker absent), real VPS gateway/Caddy, publicly trusted HTTPS, CI workflow on GitHub, external security audit, uninterrupted zero-downtime rollout. Never imply those tests passed. These are mandatory before using real customer records.

## Updating a real deployment

- Make an independent encrypted backup of SQLite and offsite copies of secrets before any change. Verify recovery procedures on staging.
- Pin the trusted publisher PUBLIC key under `.osmanx-trust/release-public.pem`. Keep the private Ed25519 signing key offline and out of ZIP/Git.
- Export a NEWER saved project release with identical project UUID/domain, sign the ZIP, then run `node deploy/upgrade.mjs plan signed.zip --require-signature` and inspect all warnings.
- After an approved maintenance window run `node deploy/upgrade.mjs apply signed.zip --confirm --require-signature`.
- For a failure **before** possible ingress, `recover --confirm` may use the existing guarded snapshot restore procedure. For the state `manual-review-required` the automatic restore remains **blocked**, because new client writes might have been accepted.
- If manual investigation confirms that keeping the current signed new version is appropriate, run `node deploy/upgrade.mjs resume --confirm`. This command does not restore SQLite. Then run `node deploy/verify-live.mjs --live` and verify normal business workflows.
- If on-disk state is unknown or the release signature cannot be verified, STOP; preserve backups and escalate to manual forensics. Do not force old database restoration.

## Security limitations

Release signing prevents unauthorised package substitution only if the publisher's private key remains protected and the expected public key is independently pinned. SHA-256 by itself is NOT authentication. The public `/api/health` identity is not a secret or access-control mechanism. There is no centralized 24/7 monitoring, encrypted backup service, signed attestation from CI, automatic credential rotation, or external audit. Docker CI must be executed on an actual Linux host.
