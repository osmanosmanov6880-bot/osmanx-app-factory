# OSMANX APP FACTORY R2.8 — Volume migration reliability

Date: 2026-11-05. Status: local engineering preview, derived from the R1.3 branch with R2.4-R2.8 additions. Original R2.3 source was unavailable. package.json version remains 1.3.0 to avoid representing this as a verified merger with R2.3. OBSIDIAN UI unchanged.

## Delivered

- `deploy/volume-migrate.mjs verify`: OFFLINE data acceptance after a completed or recovered migration. Before starting either application, checks both old and new Docker volume labels, all three corresponding contents (source, sealed host snapshot, target) via SHA-256 and file metadata, SQLite integrity for `app_data` and absence of running containers. It returns `publicHttpsVerified: false` explicitly.
- Interrupted backup recovery: `recover --confirm --recreate-targets --retry-backups` resumes incomplete snapshots only after separate explicit approval, retains interrupted partial directories for investigation, and refuses to proceed if any previously sealed source or backup no longer matches.
- Hardened journal validation: rejects unexpected volume kinds, repeated volumes, altered source/target names, invalid project identity, untrusted backup records and symlinked or improperly permissioned state paths BEFORE destructive target recovery.
- Durability improvement: fsync for atomic journal writes, directory renames and copied files where the filesystem supports it. NOT a guarantee against all power loss or filesystem failures.
- Disk-space preflight when copying host backup snapshots and when the offline helper replicates files into a target volume.
- Self-contained real-Docker E2E harness `scripts/r28_docker_e2e.mjs`. It requires an explicit `--confirm-isolated-test`, Docker Engine, Linux and the locally cached `node:22-bookworm-slim` image. It creates only synthetic data and randomly named fresh volumes, verifies a successful migration, injects a restore fault and verifies recovery. It does not open network ports, run customer apps or use personal data.
- CI workflow `.github/workflows/r28-docker-volume.yml`, designed to run full Node tests and the Docker E2E on GitHub-hosted Ubuntu whenever these files change or on manual dispatch. This workflow has NOT yet been executed on GitHub in this response.

## Operator sequence (run only on a test/staging VPS first)

1. Fully stop both legacy and new stacks; verify backup and ownership. Never use `docker compose down -v` or `docker volume prune`.
2. Verify both kits and inspect legacy volume labels. Manually pull `node:22-bookworm-slim` before testing. Do not pass an untrusted repository's script to Docker.
3. `node deploy/volume-migrate.mjs plan --legacy=/srv/old-kit --legacy-project=the_actual_old_compose_name`
4. `node deploy/volume-migrate.mjs migrate --legacy=/srv/old-kit --legacy-project=the_actual_old_compose_name --confirm --offline-confirmed`
5. `node deploy/volume-migrate.mjs verify` — **must pass while both apps are stopped**.
6. Launch the new stack manually with `docker compose up -d --build`; verify `docker compose ps`, local health, actual records and real HTTPS with `node deploy/verify-live.mjs --live`.
7. Keep original volumes and encrypted offsite backups until sufficient successful operation. Never treat internal SHA-256 checksums as digital provenance signatures.

For an interruption during backup, read `status`, inspect the private snapshot directory and ensure no source data has changed; only then use `recover --confirm --recreate-targets --retry-backups`. The `recover` command may remove only previously migration-owned **target** volumes with matching migration ID; source volumes are preserved. Failed partial backups are kept and may consume disk space.

## Evidence boundaries

Local Node test suite uses real SQLite and file-system copies; the R2.8 tests include integrity checks, label mismatch refusal, interrupted backup retry, forbidden modified source, journal-path attack and restart after injected fault. In the current environment, Docker CLI/socket are absent, so actual Docker volume operations, application container startup, Caddy certificate issuance, offsite backup restoration and public browser E2E remain NOT VERIFIED. GitHub CI workflow is supplied but not claimed to have run.

This preview is for staging only. Requires independent security review, privacy assessment, real-VPS dry-run, monitoring and disaster recovery rehearsal before production.
