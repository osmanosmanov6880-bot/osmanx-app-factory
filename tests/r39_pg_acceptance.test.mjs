import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { guardEphemeralPostgres, exactSchemaNames, tenantProbePlan, verifyRoleProbes,
  requireEmptyTarget, runPsql } from '../src/migration/r39-acceptance.mjs';
const a = '22222222-2222-4222-8222-222222222222';
const b = '33333333-3333-4333-8333-333333333333';
const manifest = { databases: [
  { projectId: null, schema:'ox_studio', tables:[{ name:'users', primary:['id'], columns:[{name:'id'}] }] },
  ...[a,b].map(projectId=>({ projectId, schema:'ox_p_'+projectId.replaceAll('-',''),
    tables:[{ name:'users', primary:['id'], columns:[{name:'id'}] }] }))
], access:{roles:[{schema:'ox_studio',reader:'ox_ro_studio',writer:'ox_rw_studio'},
  ...[a,b].map(projectId=>({schema:'ox_p_'+projectId.replaceAll('-',''),
    reader:'ox_ro_'+projectId.replaceAll('-',''),writer:'ox_rw_'+projectId.replaceAll('-','')}))]} };
function e(overrides={}) {return {OX_R39_EPHEMERAL:'YES',PGDATABASE:'ox_test_factory_r39',PGHOST:'127.0.0.1',
  PGPORT:'5432',PGUSER:'postgres',...overrides};}

test('R3.9 requires explicit human action, test-only database and loopback',()=>{
  assert.throws(()=>guardEphemeralPostgres({args:[],env:e()}),/confirm-synthetic/);
  assert.throws(()=>guardEphemeralPostgres({args:['--confirm-synthetic'],env:e({PGDATABASE:'production'})}),/PGDATABASE/);
  assert.throws(()=>guardEphemeralPostgres({args:['--confirm-synthetic'],env:e({PGHOST:'database.company.net'})}),/PGHOST/);
  assert.throws(()=>guardEphemeralPostgres({args:['--confirm-synthetic'],env:e({PGHOSTADDR:'10.0.0.1'})}),/PGHOSTADDR/);
  assert.throws(()=>guardEphemeralPostgres({args:['--confirm-synthetic'],env:e({PGSERVICE:'default'})}),/service/);
  assert.throws(()=>guardEphemeralPostgres({args:['--confirm-synthetic'],env:e({PGOPTIONS:'-c search_path=public'})}),/PGOPTIONS/);
  assert.throws(()=>guardEphemeralPostgres({args:['--confirm-synthetic'],env:e({OX_R39_EPHEMERAL:'NO'})}),/EPHEMERAL/);
  assert.throws(()=>guardEphemeralPostgres({args:['--confirm-synthetic'],env:e({PGPORT:'0'})}),/PGPORT/);
  const result=guardEphemeralPostgres({args:['--confirm-synthetic'],env:e()});
  assert.equal(result.syntheticOnly,true);
});

test('R3.9 schema plan refuses duplicate, mixed or signed-identity mismatch',()=>{
  assert.deepEqual(exactSchemaNames(manifest).length,3);
  assert.throws(()=>exactSchemaNames({...manifest,databases:manifest.databases.slice(0,2)}),/exactly/);
  const bad=structuredClone(manifest);bad.databases[2].schema='ox_studio';
  assert.throws(()=>exactSchemaNames(bad),/synthetic project schemas/);
  const blank=structuredClone(manifest);blank.databases[1].tables=[];
  assert.throws(()=>exactSchemaNames(blank),/nonempty/);
});

test('R3.9 probes test BOTH tenant roles, cross-schema reads, writes and CREATE',()=>{
  const probes=tenantProbePlan(manifest);
  assert.equal(probes.length,30);
  assert.equal(probes.filter(p=>p.mustPass).length,9);
  assert.equal(probes.filter(p=>!p.mustPass).length,21);
  for(const test of probes){
    assert.match(test.sql,/SET LOCAL ROLE/);
    assert.match(test.sql,/ROLLBACK;/);
    if(test.kind==='cross-read-denied')assert.match(test.sql,/SELECT count\(\*\) FROM/);
    if(test.kind==='schema-create-denied')assert.match(test.sql,/BEGIN;\nSET LOCAL ROLE/);
    if(test.kind==='reader-write-denied')assert.match(test.sql,/BEGIN;\nSET LOCAL ROLE/);
  }
  assert.equal(new Set(probes.map(p=>p.schema)).size,3);
  assert.equal(probes.filter(p=>p.kind==='cross-read-denied').length,12);
});

test('R3.9 rejects non-permission query errors and broken role separation',()=>{
  const plan=tenantProbePlan(manifest);
  const normal=p=>({ok:p.mustPass,permissionDenied:!p.mustPass});
  let i=0;
  const ok=verifyRoleProbes(plan,()=>normal(plan[i++]));
  assert.deepEqual({total:ok.total,allowed:ok.allowed,denied:ok.denied},
    {total:30,allowed:9,denied:21});
  i=0;
  assert.throws(()=>verifyRoleProbes(plan,()=>({ok:plan[i++].mustPass,permissionDenied:false})),/not proven/);
  i=0;
  assert.throws(()=>verifyRoleProbes(plan,()=>({ok:true,permissionDenied:false})),/not proven/);
});

test('R3.9 empty target gate stops existing application tables and schemas',()=>{
  assert.equal(requireEmptyTarget(()=>({ok:true,stdout:'0'}),manifest),true);
  assert.throws(()=>requireEmptyTarget(()=>({ok:true,stdout:'7'})),/not completely empty/);
  let i=0;
  assert.throws(()=>requireEmptyTarget(()=>({ok:true,stdout:i++===0?'0':'1'}),manifest),/schemas already exist/);
});

test('R3.9 SQL probe rejects extremely long commands before spawn',()=>{
  assert.throws(()=>runPsql('a'.repeat(50001)),/exceeded bound/);
});

test('R3.9 command refuses startup without explicit opt-in before any DB connection',()=>{
  const child=spawnSync(process.execPath,['scripts/r39_pg_real_e2e.mjs'],{
    cwd:new URL('../',import.meta.url),encoding:'utf8',timeout:10000,
    env:{...process.env,OX_R39_EPHEMERAL:'NO'}
  });
  assert.equal(child.status,1);
  assert.match(child.stderr,/Safety gate denied/);
});
