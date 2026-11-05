import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { TenantPgAdapter,openSignedTenantPgAdapter } from '../src/migration/pg-tenant-adapter.mjs';
import { createSigningIdentity,signMigration } from '../src/migration/pg-trust.mjs';

const projectId='44444444-4444-4444-8444-444444444444';
const suffix=projectId.replaceAll('-','');
const schema='ox_p_'+suffix;
const manifest={databases:[
  {projectId:null,schema:'ox_studio'},
  {projectId,schema}
 ],access:{roles:[
   {schema:'ox_studio',reader:'ox_ro_studio',writer:'ox_rw_studio'},
   {schema,reader:'ox_ro_'+suffix,writer:'ox_rw_'+suffix}
 ]}};
function fakePool({failOn,failRollback=false}={}){
 const log=[];
 const client={
  async query(text,params){
   log.push({text,params});
   if((failOn && text.includes(failOn)) || (failRollback && text==='ROLLBACK'))throw Error('mock database error');
   return {rows:[{result:7}]};
  },
  release(destroy){log.push({release:destroy===true});}
 };
 return {log,connects:0,async connect(){this.connects++;return client;}};
}
const auth=async({actorId,projectId:target})=>actorId==='owner' && target===projectId;

test('PG adapter requires auth and rejects unknown tenant before opening a DB connection',async()=>{
 const pool=fakePool();
 const adapter=new TenantPgAdapter({pool,manifest,authorize:auth});
 await assert.rejects(adapter.transaction({actorId:'stranger',projectId},()=>{}),/authorization denied/);
 await assert.rejects(adapter.transaction({actorId:'owner',projectId:'55555555-5555-4555-8555-555555555555'},()=>{}),/Unknown project/);
 await assert.rejects(adapter.transaction({actorId:'owner',projectId,mode:'admin'},()=>{}),/transaction mode/);
 assert.equal(pool.connects,0);
});

test('PG adapter selects only project reader role and read-only transaction; releases connection',async()=>{
 const pool=fakePool();
 const adapter=new TenantPgAdapter({pool,manifest,authorize:auth});
 let leakedScope;
 const output=await adapter.transaction({actorId:'owner',projectId,mode:'read'},async scope=>{
  leakedScope=scope;
  const result=await scope.query('SELECT id FROM customers WHERE id=$1',['abc']);
  await assert.rejects(scope.query('SET ROLE pg_read_all_data'),/Only parameterized/);
  await assert.rejects(scope.query('SELECT 1; DELETE FROM users'),/multiple SQL/);
  return result.rows[0].result;
 });
 assert.equal(output,7);
 assert.equal(pool.log[0].text,'BEGIN READ ONLY');
 assert.ok(pool.log.some(x=>x.text===`SET LOCAL ROLE "ox_ro_${suffix}"`));
 assert.ok(pool.log.some(x=>x.text===`SET LOCAL search_path = "${schema}", pg_catalog`));
 assert.equal(pool.log.at(-2).text,'COMMIT');
 assert.deepEqual(pool.log.at(-1),{release:false});
 await assert.rejects(leakedScope.query('SELECT 1'),/already closed/);
});

test('PG adapter uses scoped writer role; errors roll back before returning connection',async()=>{
 const pool=fakePool();
 const adapter=new TenantPgAdapter({pool,manifest,authorize:auth});
 await assert.rejects(adapter.transaction({actorId:'owner',projectId,mode:'write'},async scope=>{
  await scope.query('UPDATE customers SET status=$1 WHERE id=$2',['active','abc']);
  throw Error('business failure');
 }),/business failure/);
 assert.equal(pool.log[0].text,'BEGIN');
 assert.ok(pool.log.some(x=>x.text===`SET LOCAL ROLE "ox_rw_${suffix}"`));
 assert.equal(pool.log.at(-2).text,'ROLLBACK');
 assert.deepEqual(pool.log.at(-1),{release:false});
});

test('PG adapter drops broken connections after rollback errors and forbids invalid manifest roles',async()=>{
 const pool=fakePool({failOn:'DELETE FROM',failRollback:true});
 const adapter=new TenantPgAdapter({pool,manifest,authorize:auth});
 await assert.rejects(adapter.transaction({actorId:'owner',projectId,mode:'write'},scope=>scope.query('DELETE FROM customers WHERE id=$1',['abc'])),/mock database error/);
 assert.deepEqual(pool.log.at(-1),{release:true});
 const malicious=structuredClone(manifest);
 malicious.access.roles[1].writer='ox_rw_other_project';
 assert.throws(()=>new TenantPgAdapter({pool,manifest:malicious,authorize:auth}),/role mismatch/);
 assert.throws(()=>new TenantPgAdapter({pool,manifest}),/authorization callback/);
});

test('PG adapter can be initialized only from a separately signed synthetic migration bundle',async()=>{
 const base=await mkdtemp(join(tmpdir(),'ox-pg-adapter-'));
 try{
  const dir=join(base,'bundle');
  const demo=spawnSync(process.execPath,['scripts/pg_demo.mjs','--out',dir],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
  assert.equal(demo.status,0,demo.stderr);
  const keys=await createSigningIdentity(join(base,'key'));
  await signMigration(dir,keys.privateKey);
  const adapter=await openSignedTenantPgAdapter({pool:fakePool(),bundleDir:dir,trustedPublicKey:keys.publicKey,
    authorize:async()=>true});
  assert.equal(adapter.projects.size,2);
  const alien=await createSigningIdentity(join(base,'alien'));
  await assert.rejects(openSignedTenantPgAdapter({pool:fakePool(),bundleDir:dir,trustedPublicKey:alien.publicKey,authorize:auth}),/untrusted key/);
 }finally{await rm(base,{force:true,recursive:true});}
},{timeout:30000});
