CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin')),
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pages (
 id TEXT PRIMARY KEY, source_id TEXT UNIQUE, source_revision INTEGER NOT NULL DEFAULT 1,
 slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL,
 published INTEGER NOT NULL DEFAULT 0, blocks_json TEXT NOT NULL,
 local_revision INTEGER NOT NULL DEFAULT 1, locally_edited INTEGER NOT NULL DEFAULT 0,
 position INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS leads (
 id TEXT PRIMARY KEY, page_slug TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL,
 email TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('new','in_progress','closed')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
CREATE TABLE IF NOT EXISTS site_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
