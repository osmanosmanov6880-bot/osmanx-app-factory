import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {diffR42Rows,assessCutoverReadiness} from '../src/migration/r42-reconcile.mjs';
import {appendR42Journal,verifyR42Journal} from '../src/migration/r42-journal.mjs';
import {validateR42Options} from '../src/migration/r42-pg-http.mjs';
import {writePgPreviewAudit} from '../src/migration/r42-pg-audit.mjs';
import {TenantPgAdapter} from '../src/migration/pg-tenant-adapter.mjs';
const P='22222222-2222-4222-8222-222222222222',secret=randomBytes(32);
const makeReceipt=ok=>({format:'osmanx-r42-reconciliation-v1',readOnly:true,
  productionCutoverAllowed:false,independentSnapshots:true,signedManifestVerified:true,
  ok,totalDifferences:ok?0:1,sourceBaselineMismatchTables:[],finishedAt:new Date().toISOString()});
test('diff detects missing, extra, changed records without disclosing IDs',()=>{
  const a=new Map([['["private1"]','a'],['["private2"]','b']]);
  const b=new Map([['["private1"]','c'],['["private3"]','b']]);
  const d=diffR42Rows(a,b,{secret});
  assert.deepEqual([d.missingInPostgres,d.extraInPostgres,d.changed,d.differences],[1,1,1,3]);
  assert(d.sample.every(x=>!JSON.stringify(x).includes('private')));
  assert.equal(diffR42Rows(a,a,{secret}).differences,0);
});
test('production cutover remains denied for pristine and divergent reports',()=>{
  assert.equal(assessCutoverReadiness(makeReceipt(true)).productionCutoverAllowed,false);
  assert.equal(assessCutoverReadiness(makeReceipt(true)).eligibleForFurtherReview,true);
  assert.equal(assessCutoverReadiness(makeReceipt(false)).eligibleForFurtherReview,false);
});
test('journal detects changed records and requires matching external secret',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ox-r42-'));
  try{
    await appendR42Journal({directory:dir,secret,receipt:makeReceipt(true)});
    await appendR42Journal({directory:dir,secret,receipt:makeReceipt(false)});
    const result=await verifyR42Journal({directory:dir,secret});
    assert.equal(result.entries,2);
    await assert.rejects(verifyR42Journal({directory:dir,secret:randomBytes(32)}),/signature mismatch/);
    const path=join(dir,'checks.jsonl'),raw=await readFile(path,'utf8');
    await writeFile(path,raw.replace('"totalDifferences":0','"totalDifferences":7'));
    await assert.rejects(verifyR42Journal({directory:dir,secret}),/checksum mismatch/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('reconciliation is disabled by default and enforces signed settings',()=>{
  assert.equal(validateR42Options({}),null);
  assert.throws(()=>validateR42Options({OX_R42_PG_RECONCILIATION:'YES'}),/requires/);
  assert.equal(validateR42Options({OX_R42_PG_RECONCILIATION:'YES',OX_R40_PG_PREVIEW:'YES',
    OX_R42_JOURNAL_HMAC_KEY:secret.toString('hex'),OX_R40_PG_BUNDLE:'/bundle',
    OX_R40_PG_TRUST_KEY:'/key'}).enabled,true);
});
test('mutation audit is parameterized and refuses unexpected actions',async()=>{
  const captured=[];const scope={query:async (...args)=>{captured.push(args);return {rows:[]};}};
  await writePgPreviewAudit(scope,{action:'update',entity:'tasks',entityId:P});
  assert.equal(captured.length,1);
  assert.match(captured[0][0],/^INSERT INTO audit_log/);
  assert.equal(captured[0][1][4],P);
  await assert.rejects(writePgPreviewAudit(scope,{action:'delete',entity:'tasks',entityId:P}),/invalid/);
});
test('repeatable read snapshots cannot be opened for writes',async()=>{
  const log=[];const c={query:async text=>{log.push(text);return {rows:[]};},release:()=>{}};
  const suffix=P.replaceAll('-',''),schema='ox_p_'+suffix;
  const adapter=new TenantPgAdapter({pool:{connect:async()=>c},
    manifest:{databases:[{projectId:P,schema}],access:{roles:[{schema,reader:'ox_ro_'+suffix,writer:'ox_rw_'+suffix}]}},
    authorize:async()=>true});
  await adapter.transaction({actorId:'owner',projectId:P,mode:'read',snapshot:true},scope=>scope.query('SELECT 1'));
  assert.equal(log[0],'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await assert.rejects(adapter.transaction({actorId:'owner',projectId:P,mode:'write',snapshot:true},()=>{}),/Snapshot must be read-only/);
});
