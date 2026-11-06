// R3.9: explicitly opt-in, ephemeral-only PostgreSQL integration acceptance.
// No real customer source directory, no persistent target, no automatic cutover.
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { quoteIdent } from './pg-kit.mjs';
import { feedAtomicSql } from './pg-operations.mjs';

const TARGET = 'ox_test_factory_r39';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
function requireThat(condition, message) { if (!condition) throw new Error(message); }

export function guardEphemeralPostgres({ args = [], env = {} } = {}) {
  requireThat(args.includes('--confirm-synthetic') && env.OX_R39_EPHEMERAL === 'YES',
    'R3.9 denied: --confirm-synthetic and OX_R39_EPHEMERAL=YES are mandatory');
  requireThat(env.PGDATABASE === TARGET, `R3.9 denied: PGDATABASE must be exactly ${TARGET}`);
  requireThat(LOCAL_HOSTS.has(env.PGHOST), 'R3.9 denied: PGHOST must be a loopback address');
  requireThat(!env.PGHOSTADDR || LOCAL_HOSTS.has(env.PGHOSTADDR), 'R3.9 denied: PGHOSTADDR cannot override loopback');
  requireThat(!env.PGSERVICE && !env.PGSERVICEFILE, 'R3.9 denied: PG service indirection is forbidden');
  requireThat(!env.PGOPTIONS, 'R3.9 denied: PGOPTIONS overrides are forbidden');
  requireThat(typeof env.PGUSER === 'string' && env.PGUSER.length > 0, 'R3.9 denied: PGUSER required');
  const port = Number(env.PGPORT);
  requireThat(Number.isSafeInteger(port) && port >= 1024 && port <= 65535,
    'R3.9 denied: explicit unprivileged PGPORT required');
  return Object.freeze({ database: TARGET, host: env.PGHOST, port, syntheticOnly: true });
}

export function exactSchemaNames(manifest) {
  requireThat(Array.isArray(manifest?.databases) && manifest.databases.length === 3,
    'R3.9 requires exactly one studio and two synthetic projects');
  const schemas = manifest.databases.map(d => d.schema);
  requireThat(schemas[0] === 'ox_studio', 'R3.9 synthetic studio schema mismatch');
  const projects = manifest.databases.slice(1);
  requireThat(projects.every(d => d.projectId && d.schema === 'ox_p_' + d.projectId.replaceAll('-', '')),
    'R3.9 requires two distinct synthetic project schemas');
  requireThat(new Set(schemas).size === 3, 'R3.9 duplicate schema rejected');
  for (const d of manifest.databases) {
    quoteIdent(d.schema);
    requireThat(d.tables.length > 0 && d.tables.every(t => t.name && t.columns.length > 0),
      'R3.9 expects nonempty synthetic tables');
  }
  return schemas;
}

export function tenantProbePlan(manifest) {
  const schemas = exactSchemaNames(manifest);
  const plans = manifest.access?.roles;
  requireThat(Array.isArray(plans) && plans.length === schemas.length, 'R3.9 role count mismatch');
  const tests = [];
  for (const database of manifest.databases) {
    const { schema } = database;
    const role = plans.find(r => r.schema === schema);
    requireThat(role && role.reader && role.writer, 'R3.9 missing tenant roles: ' + schema);
    const own = database.tables[0];
    const column = own.primary[0];
    requireThat(own.columns.some(c => c.name === column), 'R3.9 primary key metadata mismatch');
    const ownTable = `${quoteIdent(schema)}.${quoteIdent(own.name)}`;
    const otherProjects = manifest.databases.filter(d => d.schema !== schema);
    for (const kind of ['reader', 'writer']) {
      const effectiveRole = quoteIdent(kind === 'reader' ? role.reader : role.writer);
      const readonly = kind === 'reader';
      const begin = readonly ? 'BEGIN READ ONLY;' : 'BEGIN;';
      const scoped = (query, forceWrite = false) => `${forceWrite ? 'BEGIN;' : begin}\nSET LOCAL ROLE ${effectiveRole};\n${query}\nROLLBACK;`;
      tests.push({ kind: 'own-read', role: kind, schema, sql: scoped(`SELECT count(*) FROM ${ownTable};`), mustPass: true });
      for (const cross of otherProjects) {
        const crossTable = `${quoteIdent(cross.schema)}.${quoteIdent(cross.tables[0].name)}`;
        tests.push({ kind: 'cross-read-denied', role: kind, schema, targetSchema: cross.schema,
          sql: scoped(`SELECT count(*) FROM ${crossTable};`), mustPass: false });
      }
      const update = `UPDATE ${ownTable} SET ${quoteIdent(column)}=${quoteIdent(column)} WHERE FALSE;`;
      tests.push({ kind: readonly ? 'reader-write-denied' : 'writer-write-allowed', role: kind,
        schema, sql: scoped(update, true), mustPass: !readonly });
      tests.push({ kind: 'schema-create-denied', role: kind, schema,
        sql: scoped(`CREATE TABLE ${quoteIdent(schema)}.${quoteIdent('ox_r39_forbidden')} (id INTEGER);`, true), mustPass: false });
    }
  }
  return tests;
}

function psqlArgs(...extra) {
  return ['-X', '--no-password', '--set=ON_ERROR_STOP=1', '--quiet', '--no-align', '--tuples-only', ...extra];
}

export function runPsql(sql, { env = process.env, timeoutMs = 20000 } = {}) {
  requireThat(typeof sql === 'string' && sql.length < 50000, 'R3.9 SQL probe exceeded bound');
  const result = spawnSync('psql', psqlArgs('--command', sql), {
    encoding: 'utf8', env, timeout: timeoutMs, maxBuffer: 128 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], shell: false
  });
  requireThat(!result.error, 'R3.9 psql probe failed to launch or timed out');
  return { ok: result.status === 0, stdout: (result.stdout || '').trim(),
    // Only callers inspect stderr for a fixed diagnostic keyword, NEVER print it.
    permissionDenied: /permission denied/i.test(result.stderr || '') };
}

export function requireEmptyTarget(run = runPsql, manifest = null) {
  // No application-owned tables can exist before the ephemeral import.
  const sql = `SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN ('r','p') AND left(n.nspname,3) <> 'pg_' AND n.nspname <> 'information_schema';`;
  const result = run(sql);
  requireThat(result.ok && result.stdout === '0', 'R3.9 database is not completely empty');
  if (manifest) {
    const expected = exactSchemaNames(manifest);
    const literal = expected.map(s => `'${s.replaceAll("'", "''")}'`).join(',');
    const schemas = run(`SELECT count(*)::text FROM pg_namespace WHERE nspname IN (${literal});`);
    requireThat(schemas.ok && schemas.stdout === '0', 'R3.9 migration schemas already exist');
  }
  return true;
}

export async function provokeAtomicRollback({ directory, manifest, timeoutMs = 90000 } = {}) {
  exactSchemaNames(manifest);
  const child = spawn('psql', psqlArgs('--single-transaction', '--file=-'), {
    env: process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false
  });
  let stdoutBytes = 0;
  let err = '';
  child.stdout.on('data', part => {
    stdoutBytes += part.length;
    if (stdoutBytes > 128 * 1024) child.kill('SIGKILL');
  });
  child.stderr.on('data', part => { err = (err + part.toString('utf8')).slice(-4096); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  const finished = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  try {
    await feedAtomicSql(directory, manifest, child.stdin);
    if (!child.stdin.write('SELECT 1/0;\n')) await once(child.stdin, 'drain');
    child.stdin.end();
    const state = await finished;
    requireThat(!timedOut && state.code !== 0 && /division by zero/i.test(err),
      'R3.9 intentional SQL failure was not detected and rejected');
    return { injectedFailure: true, psqlRejected: true };
  } catch (error) {
    child.kill('SIGKILL');
    child.stdin.destroy();
    await finished.catch(() => {});
    throw error;
  } finally { clearTimeout(timer); }
}

export function verifyRoleProbes(plan, run = runPsql) {
  requireThat(Array.isArray(plan) && plan.length >= 12, 'R3.9 role probe matrix incomplete');
  let allowed = 0, denied = 0;
  for (const probe of plan) {
    const result = run(probe.sql);
    if (probe.mustPass) {
      requireThat(result.ok, `R3.9 allowed ${probe.kind} rejected for ${probe.schema}`);
      allowed++;
    } else {
      requireThat(!result.ok && result.permissionDenied,
        `R3.9 cross-tenant/privilege boundary not proven: ${probe.kind} for ${probe.schema}`);
      denied++;
    }
  }
  return { total: plan.length, allowed, denied, isolationVerified: true };
}
