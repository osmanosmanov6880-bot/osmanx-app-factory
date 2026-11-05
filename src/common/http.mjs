import { readFile } from 'node:fs/promises';

export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const json = (res, data, status = 200, headers = {}) => {
  if (res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(data));
};
export const ok = (res, data = {}) => json(res, { ok: true, ...data });
export const bad = (status, message, code) => { throw new HttpError(status, message, code); };

export async function bodyJson(req) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') bad(415, 'Требуется Content-Type: application/json');
  const max = 128 * 1024;
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > max) bad(413, 'Слишком большой запрос');
    chunks.push(chunk);
  }
  let obj;
  try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { bad(400, 'Некорректный JSON'); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) bad(400, 'Ожидается JSON-объект');
  return obj;
}
export function protectOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return; // JSON-only APIs also prevent ordinary cross-site form POSTs.
  let host;
  try { host = new URL(origin).host; } catch { bad(403, 'Недопустимый Origin'); }
  if (host !== req.headers.host) bad(403, 'Запрос с другого сайта отклонён');
}
export function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp' };
export async function staticFile(res, file, ext = '.html') {
  try {
    const content = await readFile(file);
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
    });
    res.end(content);
  } catch (e) {
    if (e.code === 'ENOENT') bad(404, 'Файл не найден');
    throw e;
  }
}
export function respondError(res, err) {
  const status = err?.status && err.status >= 400 && err.status <= 499 ? err.status : 500;
  if (status === 500) console.error('[OSMANX]', err);
  if (!res.headersSent) json(res, { ok: false, error: status === 500 ? 'Внутренняя ошибка сервера' : err.message, code: err?.code || 'ERROR' }, status);
  else if (!res.writableEnded) res.end();
}
export function validateMethod(req, allowed) {
  if (!allowed.includes(req.method)) bad(405, 'Метод не поддерживается');
}
export function routePath(req, prefix='') {
  const url = new URL(req.url, 'http://localhost');
  let path = url.pathname;
  if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length) || '/';
  return { path, query: url.searchParams };
}
