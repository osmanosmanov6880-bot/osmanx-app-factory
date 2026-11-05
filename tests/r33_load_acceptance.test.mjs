import test from 'node:test';
import assert from 'node:assert/strict';
import {runLocalLoadAcceptance} from '../scripts/r33_load_acceptance.mjs';

test('R3.3: exported CRM and site persist all concurrent writes and close cleanly after SIGTERM', {timeout:80000},async()=>{
 const result=await runLocalLoadAcceptance();
 assert.equal(result.realHttp,true);assert.equal(result.realSqlite,true);
 assert.equal(result.publicNetworkUsed,false);assert.equal(result.realDocker,false);
 assert.equal(result.results.length,2);
 assert.deepEqual(result.results.map(x=>x.committed),[36,6]);
 assert.ok(result.results.every(x=>x.gracefulExit&&x.integrity==='ok'&&x.healthChecks===40));
});

test('R3.3: synthetic load runner refuses excessive writes before opening any server',async()=>{
 await assert.rejects(runLocalLoadAcceptance({crmWrites:10000}),/limits exceeded/);
 await assert.rejects(runLocalLoadAcceptance({siteWrites:100}),/limits exceeded/);
});
