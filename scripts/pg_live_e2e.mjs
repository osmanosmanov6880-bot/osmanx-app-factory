#!/usr/bin/env node
// Optional *real* PostgreSQL smoke test. No customer data, no auto-drop.
// Requires a manually created, dedicated empty PostgreSQL test database.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { preflightPostgres, applyPostgres } from '../src/migration/pg-operations.mjs';
import { createSigningIdentity, signMigration } from '../src/migration/pg-trust.mjs';

const args=process.argv.slice(2);
const database=process.env.PGDATABASE||'';
if(!args.includes('--confirm-test-database') || !/^ox_test_[a-z0-9_]{3,54}$/.test(database)){
 console.error('REFUSED: use a dedicated, manually created PGDATABASE=ox_test_* and --confirm-test-database.');
 console.error('Never run this against a production database. No database is created or dropped by this script.');
 process.exitCode=2;
}else{
 const root=await mkdtemp(join(tmpdir(),'ox-pg-live-'));
 try{
  const out=join(root,'migration');
  const demo=spawnSync(process.execPath,['scripts/pg_demo.mjs','--out',out],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  if(demo.status!==0)throw Error('Synthetic demo setup failed (no customer data was read)');
  const keys=await createSigningIdentity(join(root,'signing'));
  await signMigration(out,keys.privateKey);
  const preflight=await preflightPostgres(out);
  if(preflight.database!==database)throw Error('Connected database differs from PGDATABASE!');
  const result=await applyPostgres(out,{confirm:true,trustedPublicKey:keys.publicKey});
  console.log(JSON.stringify({ok:true,synthetic:true,pgDatabase:database,preflight,importResult:result,
   note:'No cleanup performed; drop the dedicated test database manually after inspection. ACL SQL was not applied.'},null,2));
 }catch(e){console.error('[LIVE PG E2E] '+e.message);process.exitCode=1;}
 finally{await rm(root,{recursive:true,force:true});}
}
