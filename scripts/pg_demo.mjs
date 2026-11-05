#!/usr/bin/env node
// Synthetic fixture only; never opens or touches the real factory data directory.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { studioDb } from '../src/studio/db.mjs';
import { crmDb } from '../src/crm/db.mjs';
import { siteDb } from '../src/site/db.mjs';
import { exportMigration, verifyMigration } from '../src/migration/pg-kit.mjs';

const owner='11111111-1111-4111-8111-111111111111';
const crmId='22222222-2222-4222-8222-222222222222';
const siteId='33333333-3333-4333-8333-333333333333';
const client='44444444-4444-4444-8444-444444444444';
const ts='2026-11-05T00:00:00.000Z';
const index=process.argv.indexOf('--out');
const dest=resolve(index>=0?process.argv[index+1]||'':'./OSMANX_PG_DEMO');
const tmp=await mkdtemp(join(tmpdir(),'ox-pg-demo-'));
try{
  const data=join(tmp,'data');await mkdir(join(data,'projects'),{recursive:true});
  const studio=studioDb(join(data,'studio.sqlite'));
  try{
    studio.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
      .run(owner,'demo-owner@example.test','Демо-владелец','DEMO_ONLY_NOT_A_REAL_HASH','owner',ts);
    for(const [id,type] of [[crmId,'crm'],[siteId,'site']]){
      studio.prepare('INSERT INTO projects(id,owner_id,name,type,industry,modules_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id,owner,type==='crm'?'Демо-кофейня':'Демо-сайт',type,'restaurant',JSON.stringify(['auth','clients','tasks']),JSON.stringify({accent:'#174368'}),ts,ts);
    }
  } finally {studio.close();}
  const crm=crmDb(join(data,'projects',crmId+'.sqlite'));
  try{
    crm.prepare('INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)')
      .run(owner,'demo-admin@example.test','Демо-администратор','DEMO_ONLY_NOT_A_REAL_HASH','admin',ts);
    crm.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,created_at) VALUES(?,?,?,?,?)')
      .run('DEMO_SESSION_TO_REMOVE',owner,'DEMO_CSRF_TO_REMOVE',ts,ts);
    crm.prepare('INSERT INTO clients(id,full_name,phone,email,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(client,'Тестовый клиент','+70000000000','client@example.test',ts,ts);
    crm.prepare('INSERT INTO visits(id,client_id,occurred_at,created_at) VALUES(?,?,?,?)')
      .run('55555555-5555-4555-8555-555555555555',client,ts,ts);
  } finally {crm.close();}
  const site=siteDb(join(data,'projects',siteId+'.sqlite'),{name:'Демо-сайт',settings:{accent:'#174368'},modules:['auth','cms','leads'],pages:[]});
  try{site.prepare('INSERT INTO leads(id,page_slug,name,phone,email,message,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('66666666-6666-4666-8666-666666666666','home','Тестовая заявка','+70000000001','lead@example.test','Демонстрация','new',ts,ts);} finally {site.close();}
  const result=await exportMigration(data,dest,{allowSensitive:true});
  await verifyMigration(dest);
  console.log(JSON.stringify({ok:true,demo:true,path:result.path,databases:result.databases,tables:result.tables,realData:false},null,2));
}catch(e){console.error('[PG-DEMO] '+e.message);process.exitCode=1;}
finally{await rm(tmp,{recursive:true,force:true});}
