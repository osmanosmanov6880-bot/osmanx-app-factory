# OSMANX APP FACTORY R3.4: signed offline fleet diagnostics

Status: engineering preview on the R1.3 base with improvements R2.4-R3.4.
Original R2.3 code has not been merged. Do NOT describe this as a public production SaaS or an executed Docker rollout.
OBSIDIAN theme is unchanged. No public deployment or data sync is performed automatically.

## Four implemented blocks

1. Client-side offline agent (`deploy/fleet-agent.mjs`). Each standalone CRM/site generates an Ed25519 identity locally. Only public key material may be copied into the factory. Its signed snapshot has an allowlist of seven status categories, UUID, release sequence, timestamp and nonce. There are NO credentials, customer rows, hostnames or client identifiers beyond the project UUID. Private keys stay in `.osmanx-fleet` and are excluded from Git and Docker builds. The output path must be OUTSIDE the installed application folder.
2. Factory-side trusted ingestion (`src/studio/fleet.mjs`). Owner-scoped pin and import endpoints authenticate the browser session, require CSRF on changes, verify signatures and project identities, limit report age to 48 h, reject older/replayed reports, and retain a bounded history (30 reports per project, 10 returned per view). Key rotation must be explicit; it removes prior reports. A fresh signed report is not proof that public HTTPS or Docker is running.
3. OBSIDIAN interface in the existing deployment wizard. Optional collapsed fleet section supports public-key pinning, deliberate rotation, manual signed-JSON import, and the latest status with age, version and warning state. Mobile 390 px and desktop 1440 px mock-API Chromium checks are included. No keys are transmitted without a user action; the factory does not call client VPS hosts.
4. Release acceptance: real Node HTTP integration tests, tamper and replay tests, synthetic 42-record concurrency test, four actual SIGKILL recovery tests, and a GitHub Actions workflow for running synthetic Docker containers on a Linux runner. Docker Engine is absent in the local workspace. Workflow presence is NOT evidence of a successful remote run.

## Operator procedure (an existing exported client kit)

Initialize the local identity on the VPS:

```
node deploy/fleet-agent.mjs init --confirm
node deploy/fleet-agent.mjs public
```

Copy the returned `publicKeyPem` value (public PEM only) into the selected project's `Publish -> Fleet status` panel in OBSIDIAN and pin it as the owner. Do not copy the private key.

Create an OFFLINE report outside the application directory:

```
node deploy/fleet-agent.mjs snapshot --out=/private/ox-status.json
```

Take the JSON file to the factory through an authorized channel, paste it into the same panel, and click Import. It is not pushed automatically. Offline snapshots mark Docker/HTTPS checks as unverified. To check Docker or live HTTPS, run `deploy/doctor.mjs` explicitly with appropriate flags on the VPS; this is separate from the offline signed fleet status protocol.

Key rotation requires first generating a new key on the client and then confirming replacement in the factory. Reports made by the previously trusted key will no longer be accepted. Keep backups of private signing keys securely; don't commit them or store them in Docker images.

## Verification commands

```
npm run check
npm test
npm run acceptance:r34 -- --out=/private/r34-acceptance.json
python3 tests/ui_r34_fleet_static.py
node scripts/build_r34_samples.mjs /private/r34-client-exports
node scripts/verify_r34_samples.mjs /private/r34-client-exports
```

For an isolated Linux runner with Docker and Node 22.16+:

```
docker info
npm run docker:e2e:r34
```

The Docker script runs synthetic CRM and site without publishing app ports and tears down their temporary stacks and volumes. Never run it on a machine containing an unrelated Compose project with the same name (names are derived from newly generated random UUIDs).

## Explicit limitations

- No background monitoring, periodic polling, push telemetry, remote controls or automatic deployment.
- Client and website data remain stored at each installation; no customer data are imported into fleet tables.
- The newest status may be stale; an unverified Docker or HTTPS check stays a warning, never a production-ready success.
- This is not a third-party security audit, validated end-to-end public TLS, or a proof that restore works with live customer data.
- Source branch original R2.3 not integrated, and the underlying project runtime package version remains `1.3.0` deliberately.
