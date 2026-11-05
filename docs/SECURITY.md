# Дополнения безопасности R0.5

Публичный website runtime HTML-экранирует текст, проверяет href (только `/...` и HTTPS), не разрешает произвольный JS/SQL, защищает CMS cookie/Origin/CSRF. Публичная форма лимитируется на адрес источника и имеет honeypot, но эта защита недостаточна для промышленного интернета. SETUP_TOKEN обязателен до первого администратора на публичном HOST; первый администратор сайта внутри Factory требует session владельца Studio и отдельный X-Studio-CSRF-Token. По умолчанию noindex/robots Disallow без PUBLIC_SITE_URL. Копии SQLite содержат личные данные и не шифруются автоматически. Нужны HTTPS, договорная правовая основа для заявок, хранение/удаление данных, CAPTCHA по необходимости, security audit и мониторинг.

---

# Security model and deployment restrictions

**Status: development MVP. NOT audited or certified for production.** Do not store sensitive medical data, payment card details, or large volumes of personal data without a dedicated privacy/security compliance review.

## Implemented controls

1. **Passwords:** salted scrypt hashes, per-user salt, constant-time hash comparison.
2. **Sessions:** cryptographically random tokens; only SHA-256 token hashes stored in database; HttpOnly, SameSite=Lax cookies; 7-day expiration.
3. **CSRF:** authenticated mutations require the session's `X-CSRF-Token`, with same-origin `Origin` validation and mandatory JSON Content-Type.
4. **Authorization:** server-side role checks for payments, analytics, staff provisioning and audit; module-gated routes.
5. **Tenant data boundaries:** every CRM project has its own SQLite DB under a server-generated UUID filename; separate authentication stores.
6. **Input checks:** upper bounds on strings and payloads, enums, prepared SQL statements, UUID validation, immutable positive integer payment amounts.
7. **Response protections:** strict CSP, no-sniff, DENY framing, same-origin referrers, no-store API caching.
8. **Login throttling:** basic in-memory IP attempt limit (single-process only).
9. **Audit logging:** records important changes without storing raw guest details or passwords.
10. **Source exports:** do not bundle sessions, passwords, client records, database files or payment records.
11. **First-admin takeover protection:** first CRM user in the studio must be created by its authorized factory owner with an additional factory CSRF header.
12. **Public bootstrap protection:** when binding the factory/standalone application to a non-loopback interface and there is no owner yet, a `SETUP_TOKEN` environment variable (at least 20 characters) is required. The first-admin API checks the token.

## Launch model

- Local `HOST=127.0.0.1`: recommended default for development.
- Public `HOST=0.0.0.0`: **not recommended without a security pass**. For first install, provide `SETUP_TOKEN`, for example from an OS password manager. Do not hardcode it in git. Complete bootstrap before distributing access.
- Configure a TLS terminator/reverse proxy and set `COOKIE_SECURE=1` for HTTPS production. Without TLS, session cookies can be intercepted.
- Firewall, authentication upstream, storage permissions, encrypted backups and operational monitoring must be in place. Never expose a fresh first-run app to untrusted traffic.
- Data files must not be committed or included in ZIP exports.

## Known limitations requiring engineering work

- `node:sqlite` on Node 22 is experimental. Production needs maintained DB migrations, safe concurrency, failover, backup/restore testing and supported database clients.
- The first user of a **standalone** instance is protected by a setup token only when configured; local default relies on loopback binding. For internet-facing deployments the token must be set before binding.
- Studio initial bootstrap is protected by a setup token only when configured or when bound publicly; on localhost any local process/user can attempt the first bootstrap. Protect workstation access.
- Rate limiting is in-memory and resets on restart; use distributed and account-level throttling for public deployments.
- No password reset, MFA, SSO, invitation acceptance, account suspension UI, session revocation UI or device management.
- No structured migration framework for general schema changes; one backward-compatible SQLite column migration exists.
- No implemented automatic backups, disaster recovery, secret rotation, anti-virus file scanning, infrastructure monitoring, or formal penetration testing.
- No fine-grained per-record visibility within a CRM: authenticated staff can access that restaurant's customer data. Configure organization permissions before production.
- Guest contacts are personal data. No retention schedule, customer data subject request workflow, consent controls, DPA or GDPR/Russian privacy compliance implementation is supplied.
- Manual payment records must not be mistaken for actual processor reconciliation; UI and API explicitly report `manual_ledger_only`.

## Production readiness gate

Do not claim production readiness until: audited auth/session security, externalized secrets, ingress/TLS/reverse-proxy design, account recovery, migration system, PostgreSQL or supported database strategy, backup-and-restore drills, GDPR/privacy analysis, load testing and incident runbooks are complete.

---
## R0.2 page-builder threat model additions

- Page structure is checked server-side, not merely by dropdown controls. Allowed types: hero, text, metric, button, form, table and divider. Actions and field names come from fixed allowlists; arbitrary URLs, HTML, JS, SQL and API methods cannot be configured.
- All page, block and client text is HTML-escaped in both editor preview and CRM runtime. The tests include malicious-looking markup as inert data.
- Creation, update and deletion of pages are factory-owner-only and require CSRF tokens; stale revisions are rejected with HTTP 409.
- CRM exposes only published pages to authenticated staff. Drafts remain owner-only in Studio.
- Metric values are generated by controlled SQL queries and role/module checks. Staff accounts never receive `paid_minor` and `repeat_share` via the page metric API.
- Generated forms use existing CRM API authorization, input validation and audit logs. Merely placing a block on a page cannot bypass server-side privileges.
- Page builder intentionally supports no arbitrary HTML/JS blocks, external embed URLs, workflow scripting or arbitrary API endpoints.
- Limits mitigate abuse: 20 pages per project, 30 blocks per page, request <=128 KiB, lengths and identifiers validated.
- R0.2 does **not** add encryption at rest, external backup, data retention controls, real payment processing, compliance audit or internet-scale isolation. These require separate implementation and verification.

## R0.3 entity security controls and limitations

- All identifiers (entity slugs, field keys) must pass a strict ASCII regex, must not be reserved and must come from normalized project configuration. SQL identifiers are double quoted, values bound as parameters; no arbitrary SQL API.
- Only the Studio owner can modify definitions; entity revisions reject stale writers (409). Existing columns cannot be changed or dropped.
- Runtime validates option sets, ISO date-only values, safe integers, numeric bounds, typed booleans and reference UUIDs against the target active row. SQLite foreign keys offer secondary integrity.
- CRM authorization is enforced **server-side** against per-entity read/write role arrays. CSRF required for every write. Individual row versioning protects concurrent edits.
- Dynamic UI escapes every label and data cell; no field definition contains executable code.
- Entity archive is a soft delete; records are not purged. Implement retention policies, legal deletion and encrypted backups before production.
- `reference` dropdown currently loads at most 100 rows: large datasets need server-side search before production.
- No public SaaS security certification, DPA, rate limits on CRUD endpoints, MFA, credential recovery, managed database, automated backup or infrastructure monitoring. These are release blockers for internet-facing production.


## R0.4 upgrade and backup security notes

- All release API routes require the owner session. Publishing (POST) requires the CSRF token. Old snapshots are immutable and download requires the same owner identity as the parent project.
- Standalone updates check project UUID, monotonic version, engine `0.4.0`, file SHA-256, stored ZIP CRC, safe entry names, local modifications, and schema compatibility on a backup clone. They are refused while the server process holds its lock. `--confirm` is mandatory for update, restore and recovery.
- The exported archive **has no trusted digital signature**. Its hashes can be recomputed by an attacker who controls the whole ZIP. Only install packages obtained through a trusted authenticated channel; signed release provenance is future work.
- Backups are local unencrypted copies of real user records, payment **ledger** data, password hashes and sessions. Use restrictive filesystem permissions, encrypted offsite copies, retention/deletion procedures, and recovery drills before processing valuable production records.
- Auto-rollback is best-effort; multi-file code replacement is not fully atomic across filesystem crashes. An interruption marker causes the standalone server to refuse startup until explicit `recover --confirm`.
- The maintenance locks use PID liveness checks and are for local single-host operations only. They are not a multi-node distributed lease. Do not use with multiple replicas.
- Database-only restore can regress recent records while keeping newer application code; a full pre-upgrade snapshot restores code+DB together. Both intentionally require downtime and pre-restore safety backup.
