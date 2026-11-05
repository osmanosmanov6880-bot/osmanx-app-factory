import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../common/db.mjs';
const sql = readFileSync(fileURLToPath(new URL('./schema.sql',import.meta.url)), 'utf8');
export function studioDb(path) {
  const db=openDb(path);
  // R1.0: expand product and industry CHECK constraints without losing referenced rows.
  // The old table is dropped with foreign keys temporarily disabled; all indexes are restored.
  const old=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'").get()?.sql;
  if(old && (!old.includes("'site'") || !old.includes("'dental'"))) {
    db.exec(`PRAGMA foreign_keys=OFF;
      BEGIN IMMEDIATE;
      CREATE TABLE projects_new (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('crm','site')),
        industry TEXT NOT NULL CHECK(industry IN ('restaurant','business','dental','auto','beauty','retail')),
        modules_json TEXT NOT NULL, settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO projects_new SELECT * FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_new RENAME TO projects;
      CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id,created_at);
      COMMIT;
      PRAGMA foreign_keys=ON;`);
    if(db.prepare('PRAGMA foreign_key_check').all().length) throw Error('Studio industry migration failed foreign-key check');
  }
  db.exec(sql);
  return db;
}
export function projectFromRow(row) {
  return row && { id:row.id, name:row.name, type:row.type, industry:row.industry,
    modules: JSON.parse(row.modules_json), settings: JSON.parse(row.settings_json),
    createdAt:row.created_at, updatedAt:row.updated_at };
}
