import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from '../common/db.mjs';
import { initializeAutomations, normalizeAutomationPreset } from './automations.mjs';
import { id,now } from '../common/security.mjs';
import { withTransaction } from '../common/db.mjs';
import { syncEntitySchema } from './entities.mjs';
const sql = readFileSync(fileURLToPath(new URL('./schema.sql',import.meta.url)), 'utf8');
export function crmDb(path,entities=[],automationPresets=[],modules=['auth','clients','tasks']) {
  const db=openDb(path);
  const existing=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get();
  db.exec(sql);
  // Backward-compatible migration for projects created before the fingerprint field.
  if (!db.prepare('PRAGMA table_info(payments)').all().some(x=>x.name==='request_fingerprint')) {
    db.exec('ALTER TABLE payments ADD COLUMN request_fingerprint TEXT');
  }
  initializeAutomations(db);
  syncEntitySchema(db,entities);
  if(!existing && automationPresets.length){
    if(automationPresets.length>30)throw Error('Too many automation presets');
    const rules=automationPresets.map(rule=>normalizeAutomationPreset(rule,entities,modules));
    withTransaction(db,()=>{
      const insert=db.prepare(`INSERT INTO automations(id,name,event,task_title,priority,enabled,created_by,created_at,entity_slug,condition_field,condition_value,due_days)
        VALUES(?,?,?,?,?,?,NULL,?,?,?,?,?)`);
      for(const rule of rules)insert.run(id(),rule.name,rule.event,rule.task_title,rule.priority,Number(rule.enabled),now(),rule.entity_slug,rule.condition_field,rule.condition_value,rule.due_days);
    });
  }
  return db;
}
