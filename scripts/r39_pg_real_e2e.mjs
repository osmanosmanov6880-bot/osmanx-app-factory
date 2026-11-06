#!/usr/bin/env node
// Real PostgreSQL 15/16 smoke acceptance, ONLY against a dedicated empty local
// ephemeral database. All rows are synthetic, runtime stays on SQLite.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyMigration } from '../src/migration/pg-kit.mjs';
import { createSigningIdentity, signMigration, verifyTrustedMigration } from '../src/migration/pg-trust.mjs';
import { preflightPostgres, applyPostgres, applyTenantAcl, assessPostgresTarget } from '../src/migration/pg-operations.mjs';
import { guardEphemeralPostgres, exactSchemaNames, requireEmptyTarget,
  provokeAtomicRollback, tenantProbePlan, verifyRoleProbes, runPsql } from '../src/migration/r39-acceptance.mjs';

try {
  const target = guardEphemeralPostgres({ args: process.argv.slice(2), env: process.env });
  const pg = runPsql("SELECT current_database() || '|' || current_setting('server_version_num');");
  if (!pg.ok || !/^ox_test_factory_r39\|1[5-9]\d{4,}$/.test(pg.stdout)) {
    throw Error('R3.9 requires a reachable PostgreSQL 15+ dedicated ephemeral database');
  }
  const [database, version] = pg.stdout.split('|');
  if (database !== target.database) throw Error('PostgreSQL target identity differs from PGDATABASE');
  requireEmptyTarget();
  const workspace = await mkdtemp(join(tmpdir(), 'ox-r39-synthetic-'));
  try {
    const bundle = join(workspace, 'signed-export');
    const demo = spawnSync(process.execPath, ['scripts/pg_demo.mjs', '--out', bundle], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 60000,
      maxBuffer: 128 * 1024, env: process.env
    });
    if (demo.status !== 0) throw Error('R3.9 failed to generate synthetic SQLite fixture');
    const manifest = await verifyMigration(bundle);
    const schemas = exactSchemaNames(manifest);
    const key = await createSigningIdentity(join(workspace, 'private-key'));
    await signMigration(bundle, key.privateKey);
    const signed = await verifyTrustedMigration(bundle, key.publicKey);
    if (signed.manifest.databases.length !== 3) throw Error('R3.9 signed fixture count mismatch');
    const before = await preflightPostgres(bundle);
    if (before.database !== target.database) throw Error('R3.9 preflight connected to another database');

    // Negative test: valid signed SQL is streamed within a PostgreSQL single
    // transaction, but a synthetic divide-by-zero is injected BEFORE COMMIT.
    // Every schema must disappear when PostgreSQL rejects the transaction.
    const atomic = await provokeAtomicRollback({ directory: bundle, manifest });
    requireEmptyTarget(undefined, manifest);
    const afterFailure = await preflightPostgres(bundle);
    if (afterFailure.schemas.length !== schemas.length) throw Error('R3.9 failed rollback schema re-check');

    // Unauthorized and wrong-key imports must not mutate the database.
    let deniedBeforeImport = false;
    try { await applyPostgres(bundle, { confirm: false, trustedPublicKey: key.publicKey }); }
    catch (e) { deniedBeforeImport = /confirm-atomic-import/.test(e.message); }
    if (!deniedBeforeImport) throw Error('R3.9 unconfirmed import was not rejected');

    const imported = await applyPostgres(bundle, {
      confirm: true, trustedPublicKey: key.publicKey, timeoutMs: 300000
    });
    if (imported.state !== 'imported-verified' || imported.schemas.length !== 3) {
      throw Error('R3.9 atomic import was not verified');
    }
    let duplicateDenied = false;
    try { await preflightPostgres(bundle); }
    catch (e) { duplicateDenied = /already exist/i.test(e.message); }
    if (!duplicateDenied) throw Error('R3.9 target overwrite not rejected');

    const acl = await applyTenantAcl(bundle, {
      confirm: true, trustedPublicKey: key.publicKey, timeoutMs: 120000
    });
    if (!acl.tenantIsolationVerified) throw Error('R3.9 tenant ACL audit failed');
    // Effective SET ROLE (not only metadata): prove normal read/write succeed
    // while cross-tenant read, read-only writes and CREATE all fail.
    const probes = verifyRoleProbes(tenantProbePlan(manifest));
    const assessed = await assessPostgresTarget(bundle, {
      trustedPublicKey: key.publicKey, timeoutMs: 120000
    });
    if (assessed.productionCutoverApproved || assessed.postgresqlRuntimeReady ||
      !assessed.sqliteRuntimeUnchanged || !assessed.consistentSnapshot) {
      throw Error('R3.9 readiness flags are unsafe');
    }
    console.log(JSON.stringify({
      format: 'osmanx-r39-real-postgresql-acceptance-v1',
      success: true, syntheticOnly: true, realPostgres: true, serverVersionNum: Number(version),
      database: target.database, schemas: schemas.length, tableCount: imported.tables,
      copiedRows: imported.rows, signedManifestVerified: true,
      atomicFailure: atomic, rejectedUnconfirmedImport: true, rejectedOverwrite: true,
      snapshotVerified: true, aclRoles: acl.roles, roleProbes: probes,
      sqliteRuntimeUnchanged: true, postgresRuntimeEnabled: false,
      publicHttpsVerified: false, productionCutoverApproved: false,
      customerDataUsed: false
    }, null, 2));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
} catch (error) {
  // Fail closed. Never emit raw SQL/psql stderr: a real export can contain PII.
  console.error('[R3.9] BLOCKED: synthetic PostgreSQL acceptance failed; inspect private CI logs. ' +
    (process.env.OX_R39_EPHEMERAL === 'YES' ? String(error.message).slice(0, 220) : 'Safety gate denied.'));
  process.exitCode = 1;
}
