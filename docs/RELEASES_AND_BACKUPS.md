# R0.4: immutable releases, controlled updates and SQLite backups

This is a **local developer workflow**, not remotely hosted auto-updating SaaS. Both Factory and standalone CRM must be stopped before backup/update/restore. Commands require Node.js >=22.16.0. Run them in the specified application directory.

## 1. Publish versioned source snapshots

Open Factory `http://127.0.0.1:4173`, log in, create or edit Restaurant CRM, and press **Releases** in its project card. Enter a short description and publish. Each project gets monotonically increasing `v1`, `v2`, ...; snapshots live in the `project_releases` table in Studio SQLite. Published snapshots store exact project configuration, pages and entity schema. Creating an identical snapshot twice returns HTTP 409.

API (authenticated Factory owner, correct CSRF token for POST):

```text
GET  /api/studio/projects/:projectId/releases
POST /api/studio/projects/:projectId/releases  {"notes":"Add suppliers form"}
GET  /api/studio/projects/:projectId/releases/:releaseId/export
```

Old versions remain downloadable after live project edits. Exported releases carry the same engine version `0.4.0`, their own sequence, project UUID, project snapshot SHA-256 and checksums of each generator-managed source file.

## 2. First installation

Download the ZIP for v1 from Factory and extract it to the dedicated folder where the customer CRM will run. It is an independent application, **not a redirect to Factory**.

```bash
cd customer-crm
node run.mjs
```

Open http://127.0.0.1:4180 and create the first CRM administrator. All customer records stay in `data/crm.sqlite` (or `DATA_DIR/crm.sqlite` if configured), never in future source ZIP files. Keep `data/`, `.env`, secrets and custom extensions out of the deployed ZIP distribution and Git.

## 3. Update from v1 to v2

Publish v2 in Factory and download its ZIP to a safe location. **Stop the running CRM process first.** From the original CRM installation directory:

```bash
node ops.mjs plan /path/to/osmanx-v2.zip
node ops.mjs backup
node ops.mjs update /path/to/osmanx-v2.zip --confirm
node run.mjs
```

`plan` checks: stored ZIP format and CRC, allowed entry names, hashes, project ID, monotonic release number, old managed files not modified locally, destination file conflicts, and an **actual SQLite schema migration on a temporary backup clone**. It does not execute code from the incoming archive. At present, updates only support `applicationVersion: 0.4.0` and additive schema changes. New fields must be optional; destructive schema edits are rejected. Any unsupported engine upgrade must be handled in a later explicit migration.

`update` repeats the plan, creates a verified database + managed-code snapshot in `data/backups/`, writes an interruption marker, applies source files and compatible schema migrations, then writes the new manifest last. If an error is detected during the update, it attempts automatic rollback to the saved snapshot.

**Important:** this is not a transactional, distributed deployment system. Crashes and power failures can interrupt multi-file replacement. If an interruption marker remains, the CRM will refuse to start until recovery. Do not delete markers manually.

```bash
node ops.mjs recover --confirm
```

The updater rejects unknown ZIP formats and project UUIDs, same/older releases, modified generated files, symlinked managed paths and overwriting unmanaged files. Never use a downloaded ZIP from an untrusted source: the SHA-256 manifest provides **integrity checks only**, not provenance or a cryptographic signature.

## 4. Independent CRM backup and restore

With the standalone CRM stopped:

```bash
node ops.mjs backup
node ops.mjs verify 20261104120000-abcdef12
node ops.mjs restore 20261104120000-abcdef12 --confirm
```

Replace the example backup ID with the actual ID printed by `backup`.

A manual `backup` stores a SQLite-consistent database and a metadata checksum. A version `update` automatically creates a **full** backup containing the entire managed source snapshot plus the database. Restoring a full backup reverts the code, release manifest and database together. Restoring a manual DB-only backup replaces records but retains the installed code and schema, which may apply additive migrations on the next start. Both restore modes automatically make a new full safety backup of the current state first.

Backup folders contain full customer data and login password hashes. They are **not encrypted**. File permissions are owner-only where supported. Store separately, encrypt offsite copies, protect against accidental sharing and routinely test restoration. There is no scheduler, cloud vault or automatic backup retention in R0.4.

## 5. Back up and restore the Factory control plane

Stop `node server.mjs` first. From Factory's source folder:

```bash
node scripts/factory_maintenance.mjs backup
node scripts/factory_maintenance.mjs verify 20261104120000-abcdef12
node scripts/factory_maintenance.mjs restore 20261104120000-abcdef12 --confirm
```

This takes SQLite-consistent snapshots of `studio.sqlite` **and every existing** `projects/<UUID>.sqlite`. After verification, restore replaces those databases. Existing project SQLite files that did not exist in the old backup are **left on disk** rather than silently deleted; their project metadata may become orphaned until manually reconciled. The utility takes a safety backup of the current databases before applying a restore.

If `DATA_DIR` is set for the server, use exactly the same `DATA_DIR` for maintenance commands. Factory backups are under `DATA_DIR/backups-factory`; standalone CRM backups under `DATA_DIR/backups`. Do not publicly expose these folders.

## 6. Known limits and support matrix

| Scenario | R0.4 |
| --- | --- |
| Factory project edits after release | Old releases remain unchanged |
| Add optional entity field, new custom entity, forms/pages | Supported and tested |
| Update independent R0.4 CRM with same-engine release | Supported, requires downtime |
| Remove/rename existing SQL column or change its type | Deliberately blocked |
| Real-time update of running CRM | Unsupported |
| Retrofit existing R0.3 standalone ZIP in place | Not automated; a controlled manual migration is required |
| Arbitrary engine code upgrades (R0.4 to R0.5) | Not supported by R0.4 updater |
| Cloud backup scheduling, signed releases, encryption | Not implemented |
| Paid production-grade internet-facing deployment | Not approved by this MVP test suite |

## 7. Tests

```bash
npm run check
npm test
python tests/ui_releases_static.py
```

The Node tests check real Factory HTTP, version snapshots, real SQLite, users/records retained after upgrade, stopped-server gate, local-edit guard, CRC rejection, backups, restore and independent ZIP boot. The Chromium UI test uses **mocked API** and verifies desktop/mobile rendering of the release dialog; it does not exercise live localhost HTTP because this sandbox blocks such browser navigation.
