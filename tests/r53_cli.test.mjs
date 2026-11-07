import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const entry=fileURLToPath(new URL('../ops/r53/recover.mjs',import.meta.url));
function run(env){
  return spawnSync(process.execPath,[entry],{
    env:{...process.env,...env},encoding:'utf8',timeout:15000
  });
}
test('R5.3 detached restore refuses any invocation without explicit synthetic isolation',()=>{
  const r=run({OX_R40_EPHEMERAL:'NO',OX_R53_SYNTHETIC_ONLY:'YES'});
  assert.equal(r.status,1);
  assert.match(r.stderr,/only supports isolated synthetic CRM/);
  assert.doesNotMatch(r.stderr,/sk-proj-|Authorization:|Bearer /);
});
test('R5.3 operator must provide signed CRM project and independent inputs',()=>{
  const r=run({OX_R40_EPHEMERAL:'YES',OX_R53_SYNTHETIC_ONLY:'YES',
    OX_R53_PROJECT_ID:''});
  assert.equal(r.status,1);
  assert.match(r.stderr,/OX_R53_PROJECT_ID is required/);
});
