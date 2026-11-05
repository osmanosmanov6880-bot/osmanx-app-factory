import test from 'node:test';
import assert from 'node:assert/strict';
import {runIsolated,tapSummary,runRegression} from '../scripts/r35_regression.mjs';

test('R3.5 bounded test runner returns real exit status and parses TAP summary',{timeout:10000},async()=>{
 const result=await runIsolated(process.execPath,['-e',"console.log('# tests 1\\n# pass 1\\n# fail 0\\n# skipped 0\\n# cancelled 0')"]);
 assert.equal(result.exitCode,0);assert.equal(result.timedOut,false);
 assert.deepEqual(tapSummary(result.outputTail),{tests:1,passed:1,failed:0,skipped:0,cancelled:0});
});
test('R3.5 reports a green TAP tail with hanging handles as a failure',{timeout:10000},async()=>{
 const result=await runIsolated(process.execPath,['-e',"console.log('# tests 1\\n# pass 1\\n# fail 0'); setInterval(()=>{},10000)"],{timeoutMs:400});
 assert.equal(result.timedOut,true);assert.notEqual(result.exitCode,0);
});
test('R3.5 isolated runner rejects unsafe filter and missing test file',{timeout:10000},async()=>{
 await assert.rejects(runRegression({focus:'../any'}),/Unsafe test filter/);
 await assert.rejects(runRegression({focus:'nonexistent'}),/No matching test files/);
});
