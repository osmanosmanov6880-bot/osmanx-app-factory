import { randomBytes, randomUUID, scryptSync, createHash, timingSafeEqual } from 'node:crypto';
import { bad } from './http.mjs';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
const hashToken = token => createHash('sha256').update(token).digest('hex');
export const passwordRules = value => {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) bad(400, 'Пароль: от 12 до 128 символов');
};
export function hashPassword(password) {
  passwordRules(password);
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt}$${derived.toString('hex')}`;
}
export function verifyPassword(password, encoded) {
  try {
    const [alg, n, r, p, salt, stored] = encoded.split('$');
    if (alg !== 'scrypt' || Number(n) > 65536 || Number(r) > 16 || Number(p) > 2) return false;
    const expected = Buffer.from(stored, 'hex');
    const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length, { N:Number(n), r:Number(r), p:Number(p) });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}
const safePath = v => v.startsWith('/') && !/[;\r\n]/.test(v) ? v : '/';
export function cookie(value, name, path='/', maxAge=60*60*24*7) {
  const flags = [`${name}=${encodeURIComponent(value)}`, `Path=${safePath(path)}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (process.env.COOKIE_SECURE === '1') flags.push('Secure');
  return flags.join('; ');
}
export function sessionFromRequest(req, db, cookieName) {
  const raw = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v=>v.startsWith(`${cookieName}=`));
  if (!raw) return null;
  let value;
  try { value = decodeURIComponent(raw.slice(cookieName.length+1)); } catch { return null; }
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  const record = db.prepare(`SELECT s.token_hash,s.csrf_token,s.expires_at,u.id,u.email,u.name,u.role,u.active
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(hashToken(value));
  if (!record || !record.active || record.expires_at < now()) return null;
  return { id:record.id, name:record.name, email:record.email, role:record.role,
    csrf:record.csrf_token, sessionHash: record.token_hash };
}
export function issueSession(db, userId) {
  const token = randomBytes(32).toString('hex');
  const csrf = randomBytes(32).toString('hex');
  const exp = new Date(Date.now() + 7*24*3600*1000).toISOString();
  db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
    .run(hashToken(token),userId,csrf,exp,now());
  return {token, csrf};
}
export function revokeSession(db, current) {
  if (current) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(current.sessionHash);
}
export function requireUser(req, db, cookieName, roles = null) {
  const user = sessionFromRequest(req, db, cookieName);
  if (!user) bad(401, 'Выполните вход');
  if (roles && !roles.includes(user.role)) bad(403, 'Недостаточно прав');
  if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || token !== user.csrf) bad(403, 'CSRF-проверка не пройдена');
  }
  return user;
}
const attempts = new Map();
export function checkLoginThrottle(req, scope) {
  const ip = req.socket.remoteAddress || 'unknown';
  const key = `${scope}:${ip}`;
  const nowMs = Date.now();
  const r = attempts.get(key) || { start:nowMs, n:0 };
  if (nowMs-r.start > 15*60*1000) { r.start=nowMs; r.n=0; }
  r.n++;
  attempts.set(key,r);
  if (attempts.size > 5000) attempts.clear();
  if (r.n > 25) bad(429,'Слишком много попыток входа. Повторите позже.');
}
export function requireSetupToken(value) {
  if (!process.env.SETUP_TOKEN) return;
  const expected = Buffer.from(process.env.SETUP_TOKEN);
  const actual = Buffer.from(typeof value === 'string' ? value : '');
  if (actual.length !== expected.length || !timingSafeEqual(actual,expected)) bad(403,'Неверный ключ первоначальной установки');
}
export function assertSafePublicBootstrap(host, initialized) {
  if (!['127.0.0.1','localhost','::1'].includes(host) && !initialized && !process.env.SETUP_TOKEN) {
    throw new Error('Public first run requires SETUP_TOKEN (at least 20 characters)');
  }
  if (process.env.SETUP_TOKEN && process.env.SETUP_TOKEN.length < 20) {
    throw new Error('SETUP_TOKEN must be at least 20 characters');
  }
}
export function validateEmail(value) {
  const email = String(value||'').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) bad(400,'Введите корректный email');
  return email;
}
export function shortText(value, label, max=120, required=true) {
  const text = String(value ?? '').trim();
  if ((required && !text) || text.length > max) bad(400,`Поле «${label}»: ${required ? 'обязательно, ' : ''}не более ${max} символов`);
  return text;
}
export function checkId(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value||'')) bad(400,'Некорректный идентификатор');
  return value;
}
export function enumValue(value, values, label) {
  if (!values.includes(value)) bad(400, `Недопустимое значение поля «${label}»`);
  return value;
}
export function optionalIso(value, label) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) bad(400, `Некорректная дата: ${label}`);
  return new Date(value).toISOString();
}
export function nullableId(value) { return value == null || value === '' ? null : checkId(value); }
export function audit(db, userId, action, entity, entityId, metadata = {}) {
  db.prepare('INSERT INTO audit_log(id,user_id,action,entity,entity_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id(), userId||null, action, entity, entityId||null, JSON.stringify(metadata), now());
}
