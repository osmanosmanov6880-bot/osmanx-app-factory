CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY,
 email TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','manager','staff')),
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf_token TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS clients (
 id TEXT PRIMARY KEY,
 full_name TEXT NOT NULL,
 phone TEXT NOT NULL DEFAULT '',
 email TEXT NOT NULL DEFAULT '',
 source TEXT NOT NULL DEFAULT 'unknown' CHECK(source IN ('unknown','walkin','social','referral','website','other')),
 notes TEXT NOT NULL DEFAULT '',
 archived_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_clients_created ON clients(created_at);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
CREATE TABLE IF NOT EXISTS visits (
 id TEXT PRIMARY KEY,
 client_id TEXT NOT NULL REFERENCES clients(id),
 occurred_at TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '',
 created_by TEXT REFERENCES users(id),
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visits_client ON visits(client_id,occurred_at);
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','done','cancelled')),
 priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
 due_at TEXT,
 client_id TEXT REFERENCES clients(id),
 assigned_to TEXT REFERENCES users(id),
 created_by TEXT REFERENCES users(id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status,due_at);
CREATE TABLE IF NOT EXISTS payments (
 id TEXT PRIMARY KEY,
 client_id TEXT REFERENCES clients(id),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0 AND amount_minor<=999999999999),
 currency TEXT NOT NULL CHECK(currency IN ('RUB','EUR','USD')),
 method TEXT NOT NULL CHECK(method IN ('cash','bank_transfer','terminal','other')),
 status TEXT NOT NULL CHECK(status IN ('pending','paid','refunded','cancelled')),
 external_reference TEXT NOT NULL DEFAULT '',
 note TEXT NOT NULL DEFAULT '',
 idem_key TEXT UNIQUE,
 request_fingerprint TEXT,
 created_by TEXT REFERENCES users(id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_status_date ON payments(status,created_at);
CREATE TABLE IF NOT EXISTS audit_log (
 id TEXT PRIMARY KEY,
 user_id TEXT REFERENCES users(id),
 action TEXT NOT NULL,
 entity TEXT NOT NULL,
 entity_id TEXT,
 metadata_json TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
