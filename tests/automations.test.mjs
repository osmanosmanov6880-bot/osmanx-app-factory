import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crmDb } from '../src/crm/db.mjs';
import { fireAutomations } from '../src/crm/automations.mjs';
import { withTransaction } from '../src/common/db.mjs';
import { randomUUID } from 'node:crypto';

const stamp=()=>new Date().toISOString();
test('R0.9: automation creates linked task, is idempotent, respects disable and survives DB reopen', async()=>{
 const folder=await mkdtemp(join(tmpdir(),'osmanx-r09-'));const file=join(folder,'test.sqlite');let db=crmDb(file);
 const uid=randomUUID(),cid=randomUUID(),event=randomUUID(),rid=randomUUID();
 db.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)').run(uid,'user@test.example','Tester','mock','admin',stamp());
 db.prepare('INSERT INTO automations(id,name,event,task_title,priority,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run(rid,'Первый контакт','client_created','Позвонить гостю','high',uid,stamp());
 withTransaction(db,()=>{
   db.prepare('INSERT INTO clients(id,full_name,phone,email,source,notes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(cid,'Тестовый гость','','','unknown','',stamp(),stamp());
   fireAutomations(db,{event:'client_created',eventId:event,clientId:cid,userId:uid});
 });
 assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);
 assert.equal(db.prepare('SELECT * FROM tasks').get().client_id,cid);
 fireAutomations(db,{event:'client_created',eventId:event,clientId:cid,userId:uid});
 assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);
 db.prepare('UPDATE automations SET enabled=0 WHERE id=?').run(rid);
 fireAutomations(db,{event:'client_created',eventId:randomUUID(),clientId:cid,userId:uid});
 assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);
 db.close();db=crmDb(file);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM automation_runs').get().n,1);
 assert.equal(db.prepare('SELECT enabled FROM automations WHERE id=?').get(rid).enabled,0);
 db.close();
});
