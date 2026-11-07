import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const file=fileURLToPath(new URL('../ops/r54/worker.mjs',import.meta.url));
const exec=env=>spawnSync(process.execPath,[file],{
  env:{...process.env,...env},encoding:'utf8',timeout:15000
});
test('R5.4 CLI will not run without two independent isolated synthetic flags',()=>{
  const r=exec({OX_R40_EPHEMERAL:'YES',OX_R54_SYNTHETIC_ONLY:'NO'});
  assert.equal(r.status,4);
  assert.match(r.stderr,/only runs on an isolated synthetic CRM/);
});
test('R5.4 CLI refuses missing signed project before opening any SQLite',()=>{
  const r=exec({OX_R40_EPHEMERAL:'YES',OX_R54_SYNTHETIC_ONLY:'YES',
    OX_R54_PROJECT_ID:''});
  assert.equal(r.status,4);
  assert.match(r.stderr,/OX_R54_PROJECT_ID required/);
});
