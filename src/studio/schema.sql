CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner')),
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
 name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('crm','site')),
 industry TEXT NOT NULL CHECK(industry IN ('restaurant','business','dental','auto','beauty','retail')),
 modules_json TEXT NOT NULL, settings_json TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id,created_at);
CREATE TABLE IF NOT EXISTS project_pages (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 slug TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
 blocks_json TEXT NOT NULL,
 position INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(project_id,slug)
);
CREATE INDEX IF NOT EXISTS idx_project_pages_order ON project_pages(project_id,position);

-- R0.3: per-project declarative entities; actual tenant record tables live in each CRM SQLite database.
CREATE TABLE IF NOT EXISTS project_entities (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 slug TEXT NOT NULL,
 definition_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(project_id,slug)
);
CREATE INDEX IF NOT EXISTS idx_project_entities_project ON project_entities(project_id,created_at);

-- R0.4: immutable snapshots for a particular project; never rewrite old releases.
CREATE TABLE IF NOT EXISTS project_releases (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL CHECK(sequence > 0),
 snapshot_json TEXT NOT NULL,
 snapshot_sha256 TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL REFERENCES users(id),
 created_at TEXT NOT NULL,
 UNIQUE(project_id,sequence)
);
CREATE INDEX IF NOT EXISTS idx_releases_project ON project_releases(project_id,sequence DESC);

-- R0.8: immutable, owner-private reusable project blueprints.
-- Snapshots never include CRM guest records, payments, website leads or passwords.
CREATE TABLE IF NOT EXISTS project_templates (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 type TEXT NOT NULL CHECK(type IN ('crm','site')),
 industry TEXT NOT NULL,
 source_project_id TEXT,
 snapshot_json TEXT NOT NULL,
 snapshot_sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_templates_owner ON project_templates(owner_id,created_at DESC);


-- R1.1: portable automation definitions. Separate from live operational CRM rules and runs.
CREATE TABLE IF NOT EXISTS project_workflows (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 definition_json TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_workflows ON project_workflows(project_id,created_at);

-- R3.4: owner-scoped, opt-in offline fleet snapshots; no customer records.
CREATE TABLE IF NOT EXISTS project_fleet_keys (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 public_key_pem TEXT NOT NULL, fingerprint TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_fleet_reports (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 observed_at TEXT NOT NULL, received_at TEXT NOT NULL,
 release_sequence INTEGER NOT NULL,
 service TEXT NOT NULL CHECK(service IN ('crm','site')),
 checks_json TEXT NOT NULL, nonce TEXT NOT NULL, fingerprint TEXT NOT NULL,
 PRIMARY KEY(project_id, observed_at), UNIQUE(project_id,nonce)
);
CREATE INDEX IF NOT EXISTS idx_project_fleet_reports ON project_fleet_reports(project_id,observed_at DESC);
