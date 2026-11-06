// R4.0: opt-in, authenticated PostgreSQL HTTP preview for imported CRM clients.
// This is NOT a runtime cutover: the existing factory, CMS and CRM stay on SQLite.
import { randomUUID } from 'node:crypto';
import { bodyJson, bad, json, ok, protectOrigin } from '../common/http.mjs';
import { requireUser, checkId, validateEmail, shortText } from '../common/security.mjs';
import { TenantPgAdapter, openSignedTenantPgAdapter } from './pg-tenant-adapter.mjs';
import {writePgPreviewAudit} from './r42-pg-audit.mjs';
const auditEnabled=()=>process.env.OX_R42_PG_RECONCILIATION==='YES';

export const R40_PREFIX = '/api/studio/pg-preview';
const SOURCES = new Set(['unknown', 'walkin', 'social', 'referral', 'website', 'other']);
const WRITE_METHODS = new Set(['POST', 'PATCH']);
const COLUMNS = Object.freeze({fullName: 'full_name', phone: 'phone', email: 'email', source: 'source', notes: 'notes'});

function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function onlyKeys(obj, keys) {
  if (!plain(obj) || Object.keys(obj).some(key => !keys.includes(key))) bad(400, 'Недопустимые поля запроса');
}
function boundedString(value, label, max, required = false) {
  if (typeof value !== 'string') bad(400, `Поле «${label}» должно быть строкой`);
  return shortText(value, label, max, required);
}
function clientValues(input, partial = false) {
  onlyKeys(input, Object.keys(COLUMNS));
  if (partial && !Object.keys(input).length) bad(400, 'Не указаны изменения');
  if (!partial && !Object.hasOwn(input, 'fullName')) bad(400, 'Имя клиента обязательно');
  const out = {};
  if (Object.hasOwn(input, 'fullName')) out.fullName = boundedString(input.fullName, 'Имя клиента', 120, true);
  if (Object.hasOwn(input, 'phone')) out.phone = boundedString(input.phone, 'Телефон', 40);
  if (Object.hasOwn(input, 'email')) out.email = input.email === '' ? '' : validateEmail(input.email);
  if (Object.hasOwn(input, 'notes')) out.notes = boundedString(input.notes, 'Заметка', 1000);
  if (Object.hasOwn(input, 'source')) {
    if (typeof input.source !== 'string' || !SOURCES.has(input.source)) bad(400, 'Неизвестный источник клиента');
    out.source = input.source;
  }
  if (!partial) {
    out.phone ??= ''; out.email ??= ''; out.notes ??= ''; out.source ??= 'unknown';
  }
  return out;
}
function mapClient(row) {
  return {id: row.id, fullName: row.full_name, phone: row.phone,
    email: row.email, source: row.source, notes: row.notes,
    createdAt: row.created_at, updatedAt: row.updated_at};
}
function ensureOwnerProject(studioDb, actorId, projectId) {
  checkId(projectId);
  const row = studioDb.prepare('SELECT id, type, modules_json FROM projects WHERE id=? AND owner_id=?').get(projectId, actorId);
  if (!row || row.type !== 'crm') bad(404, 'Проект CRM не найден');
  let modules;
  try { modules = JSON.parse(row.modules_json); } catch { bad(500, 'Ошибка конфигурации проекта'); }
  if (!Array.isArray(modules) || !modules.includes('clients')) bad(404, 'В проекте нет модуля клиентов');
  return row;
}
export function authorizePreviewProject(studioDb) {
  return async ({actorId, projectId}) => {
    try { ensureOwnerProject(studioDb, actorId, projectId); return true; }
    catch { return false; }
  };
}

function assertPreviewConfig(env) {
  if (env.OX_R40_PG_PREVIEW !== 'YES') throw Error('PostgreSQL preview is disabled');
  if (!['127.0.0.1', 'localhost', '::1'].includes(env.PGHOST)) throw Error('PostgreSQL preview requires local TCP/SSH tunnel');
  if (env.PGHOSTADDR && !['127.0.0.1', '::1'].includes(env.PGHOSTADDR)) throw Error('PGHOSTADDR cannot override loopback');
  if (env.PGSERVICE || env.PGSERVICEFILE || env.PGOPTIONS || env.DATABASE_URL) throw Error('PG environment indirection denied');
  if (env.PGDATABASE !== 'ox_test_factory_r40') throw Error('PostgreSQL preview is restricted to the synthetic test DB');
  if (!Number.isSafeInteger(Number(env.PGPORT)) || Number(env.PGPORT) < 1024 || Number(env.PGPORT) > 65535) throw Error('PGPORT required');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(env.PGUSER || '') || env.PGUSER === 'postgres') throw Error('Dedicated unprivileged PGUSER required');
  if (!env.PGPASSWORD || !env.OX_R40_PG_BUNDLE || !env.OX_R40_PG_TRUST_KEY) throw Error('Postgres password, signed bundle and pinned public key required');
  if (env.PGSSLMODE && env.PGSSLMODE !== 'disable') throw Error('Preview uses local loopback without SSL mode overrides');
  return {host: env.PGHOST, port: Number(env.PGPORT), database: env.PGDATABASE,
    user: env.PGUSER, password: env.PGPASSWORD, max: 4,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000,
    application_name: 'osmanx-r40-pg-preview', ssl: false};
}
export { assertPreviewConfig as validateR40PreviewEnvironment };

// createPool is injectable for deterministic unit tests; default uses the reviewed pg driver.
export async function createR40Runtime({studioDb, env = process.env, createPool} = {}) {
  if (env.OX_R40_PG_PREVIEW !== 'YES') return null;
  if (!studioDb || typeof studioDb.prepare !== 'function') throw Error('Studio database required for project authorization');
  const config = assertPreviewConfig(env);
  const factory = createPool || (async options => {
    const {Pool} = await import('pg');
    return new Pool(options);
  });
  const pool = await factory(config);
  try {
    // Verify the login is not a superuser/role administrator. Tenant roles
    // remain NOLOGIN and can only be activated inside adapter transactions.
    const status = await pool.query(`SELECT current_database() AS db, current_user AS usr,
      (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls
       FROM pg_roles WHERE rolname = current_user) AS privileged,
      current_setting('server_version_num')::int AS version`);
    const row = status.rows?.[0];
    if (!row || row.db !== config.database || row.usr !== config.user || row.privileged !== false || row.version < 150000) {
      throw Error('Preview database or unprivileged role verification failed');
    }
    const adapter = await openSignedTenantPgAdapter({pool, bundleDir: env.OX_R40_PG_BUNDLE,
      trustedPublicKey: env.OX_R40_PG_TRUST_KEY, authorize: authorizePreviewProject(studioDb)});
    return Object.freeze({adapter, pool, close: async () => pool.end(), syntheticOnly: true});
  } catch (error) {
    await pool.end?.().catch(() => {});
    throw error;
  }
}

async function insertClient(scope, input) {
  const data = clientValues(input);
  const id = randomUUID(), now = new Date().toISOString();
  const result = await scope.query(`INSERT INTO clients
    (id, full_name, phone, email, source, notes, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id, full_name, phone, email, source, notes, created_at, updated_at`,
    [id, data.fullName, data.phone, data.email, data.source, data.notes, now, now]);
  const client=mapClient(result.rows[0]);
  if(auditEnabled())await writePgPreviewAudit(scope,{action:'create',entity:'clients',entityId:client.id,afterImage:result.rows[0]});
  return client;
}

export async function handleR40PreviewRequest(req, res, {studioDb, runtime}) {
  if (!runtime?.adapter) bad(404, 'PostgreSQL Preview выключен');
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith(R40_PREFIX + '/')) bad(404, 'Маршрут не найден');
  if (WRITE_METHODS.has(req.method)) protectOrigin(req);
  const actor = requireUser(req, studioDb, 'ox_studio');
  if (url.pathname === R40_PREFIX + '/status' && req.method === 'GET') {
    return ok(res, {enabled: true, syntheticOnly: true, runtime: 'postgresql-preview',
      primaryRuntime: 'sqlite', productionCutoverApproved: false});
  }
  const match = url.pathname.match(/^\/api\/studio\/pg-preview\/projects\/([0-9a-f-]{36})\/clients(?:\/(batch|[0-9a-f-]{36}))?$/);
  if (!match) bad(404, 'Маршрут PostgreSQL Preview не найден');
  const projectId = checkId(match[1]), target = match[2] || null;
  // Refuse the request before opening even one connection to PostgreSQL.
  ensureOwnerProject(studioDb, actor.id, projectId);
  if (req.method === 'GET' && !target) {
    const limit = url.searchParams.get('limit') ?? '25';
    if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit)) bad(400, 'Лимит: от 1 до 50');
    const clients = await runtime.adapter.transaction({actorId: actor.id, projectId}, async scope => {
      const result = await scope.query(`SELECT id, full_name, phone, email, source, notes, created_at, updated_at
        FROM clients WHERE archived_at IS NULL ORDER BY created_at DESC, id DESC LIMIT $1`, [Number(limit)]);
      return result.rows.map(mapClient);
    });
    return ok(res, {source:'postgresql-preview', projectId, clients});
  }
  if (req.method === 'GET' && target && target !== 'batch') {
    checkId(target);
    const found = await runtime.adapter.transaction({actorId:actor.id,projectId}, async scope => {
      const result = await scope.query(`SELECT id, full_name, phone, email, source, notes, created_at, updated_at
        FROM clients WHERE id=$1 AND archived_at IS NULL`, [target]);
      return result.rows[0] ? mapClient(result.rows[0]) : null;
    });
    if (!found) bad(404, 'Клиент не найден');
    return ok(res, {client: found, source: 'postgresql-preview'});
  }
  if (req.method === 'POST' && !target) {
    const input = await bodyJson(req);
    const client = await runtime.adapter.transaction({actorId:actor.id,projectId,mode:'write'}, scope => insertClient(scope,input));
    return json(res, {ok:true, client, source:'postgresql-preview'}, 201);
  }
  if (req.method === 'POST' && target === 'batch') {
    const data = await bodyJson(req);
    onlyKeys(data, ['items']);
    if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 10) bad(400, 'Пакет: от 1 до 10 клиентов');
    // Validate each item INSIDE the transaction: an invalid later item
    // must roll back earlier inserts, not silently persist a partial batch.
    const clients = await runtime.adapter.transaction({actorId:actor.id,projectId,mode:'write'}, async scope => {
      const result = [];
      for (const input of data.items) result.push(await insertClient(scope, input));
      return result;
    });
    return json(res, {ok:true, clients, source:'postgresql-preview'}, 201);
  }
  if (req.method === 'PATCH' && target && target !== 'batch') {
    checkId(target);
    const data = clientValues(await bodyJson(req), true);
    const columns = Object.keys(data), values = columns.map(key=>data[key]);
    const assignments = columns.map((key,i)=>`"${COLUMNS[key]}"=${i+1}`);
    const client = await runtime.adapter.transaction({actorId:actor.id,projectId,mode:'write'}, async scope => {
      // Serialize updates to one client so every committed audit after-image
      // has a strictly increasing version even for writes within one millisecond.
      const locked = await scope.query(
        'SELECT updated_at FROM clients WHERE id=$1 AND archived_at IS NULL FOR UPDATE',[target]);
      if(!locked.rows?.length) return null;
      const oldTick=Date.parse(locked.rows[0].updated_at);
      if(!Number.isFinite(oldTick))throw Error('Invalid client version in PostgreSQL');
      const updatedAt=new Date(Math.max(Date.now(),oldTick+1)).toISOString();
      const args=[...values,updatedAt,target];
      const result = await scope.query(`UPDATE clients SET ${assignments.join(', ')}, updated_at=${columns.length+1}
        WHERE id=${columns.length+2} AND archived_at IS NULL
        RETURNING id, full_name, phone, email, source, notes, created_at, updated_at`, args);
      if(result.rows[0]&&auditEnabled())await writePgPreviewAudit(scope,{action:'update',entity:'clients',entityId:target,afterImage:result.rows[0]});
      return result.rows[0] ? mapClient(result.rows[0]) : null;
    });
    if (!client) bad(404, 'Клиент не найден');
    return ok(res, {client, source:'postgresql-preview'});
  }
  bad(405, 'Метод не поддерживается');
}
