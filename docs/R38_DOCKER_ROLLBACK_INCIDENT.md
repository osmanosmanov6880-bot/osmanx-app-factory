# OSMANX APP FACTORY R3.8: signed rollback after root maintenance

## Incident scope

When the unified R3.7 code was first published to GitHub, GitHub Actions executed real Docker isolation tests. The R2.8 volume-migration test succeeded after its permission fix, but the R3.1 signed-rollback integration failed, blocking seven dependent acceptance workflows. The runner reported a post-restore app container exiting with status 1 and the upgrade journal entering `recovery-required`. The pre-activation rollback is **not** equivalent to a completed rollback when this state exists.

## Root cause and remediation

The isolated Compose fixture intentionally runs the offline maintenance service with UID 0 so it can read private backup mounts; the production application runs as non-root `node`. The old implementation copied the backed-up SQLite database to a new inode and atomically renamed it over the application's database, leaving the restored file owned by the maintenance UID. Because the database is mode 0600, a non-root application cannot reopen it after rollback. This is the code-level root cause addressed in R3.8; actual closure requires a passing GitHub Docker E2E rerun.

`preserveDatabaseOwner()` now:

* Uses `lstat` to reject a symlink or non-file destination before replacing it.
* Preserves the original database's UID and GID; for a first-time restore, inherits the real data directory owner.
* Restores mode 0600 after `chown` and syncs the staged file before atomic rename, syncing its directory afterward on non-Windows systems.
* Refuses to replace the live file if ownership restoration fails (fail closed).

The change is packaged into both independent CRM and site deployment ZIPs, not just the factory code. Synthetic tests exercise actual SQLite backup/restore under UID 0 and verify that the resulting database remains owned by UID/GID 65534. In addition, unit tests cover failing chown operations and linked destinations.

## Acceptance and limitations

Use the dedicated `.github/workflows/r38-signed-docker-rollback.yml` on `main` to perform the following **synthetic-only** work:

1. Check syntax and all new R3.8 unit tests.
2. Run a root-maintenance/non-root-database-owner restore in a disposable Docker container with `--network none` and a read-only source mount.
3. Run the existing R3.1 real Docker signed-upgrade, deliberate rollback, and forward-resume test with randomly generated Compose project and no published public ports.

On a failure, the R3.1 runner prints bounded logs from the *synthetic test container only*, before cleanup, to aid diagnosis. This must never be repurposed for customer containers.

These checks do not prove readiness for public HTTPS, database cutover to PostgreSQL, availability under production traffic, or customer data retention compliance. A system with `recovery-required` or `manual-review-required` must not be auto-deployed. Existing broken SQLite ownership in live deployments requires operator review; the new code only prevents repeats when a future restore is performed correctly.
