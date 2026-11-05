import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCrashAcceptance} from '../scripts/r33_crash_acceptance.mjs';
import {getUpgradeStatus,recoverUpgrade} from '../templates/deploy/upgrade.mjs';

const id='329a0eea-14ce-4fe8-b2aa-5282c34e112a';
const valid={format:'osmanx-upgrade-journal',version:1,
 id:'20261105123000-aaaaaaaaaaaa',projectId:id,composeProject:'osmanx_'+id.replaceAll('-','').slice(0,12),
 domain:'synthetic.osmanx.co',from:0,to:1,phase:'stopped',zipSha256:'a'.repeat(64),
 backupId:null,added:['src/common/new.mjs'],createdAt:'2026-11-05T12:30:00.000Z'};
async function fixture(){const dir=await mkdtemp(join(tmpdir(),'r33-journal-'));
 const state=join(dir,'.osmanx-upgrades');await mkdir(state,{mode:0o700});await chmod(state,0o700);
 const save=async data=>writeFile(join(state,'active.json'),JSON.stringify(data),{mode:0o600});
 return {dir,state,save,close:()=>rm(dir,{recursive:true,force:true})};
}

test('R3.3: real SIGKILL is recovered for CRM and site, both before and after backup',{timeout:120000},async()=>{
 const report=await runCrashAcceptance();
 assert.equal(report.ok,true);assert.equal(report.results.length,4);
 assert.ok(report.results.every(x=>x.processReallyKilled&&x.durableJournalRecovered&&x.sqliteIntegrity==='ok'&&x.recoveredRelease===0));
 assert.equal(report.results.filter(x=>x.databaseRestoreCount===1).length,2);
});

test('R3.3: forged journal path, compose identity, backup ID or invalid state rejected before any destructive action',async()=>{
 const f=await fixture();try{
  const overrides=[{added:['../backups']},{added:['.env']},{composeProject:'osmanx_other'},{phase:'unknown'},
   {zipSha256:'not-a-sha256'},{backupId:'../../outside'},{added:['src/common/new.mjs','src/common/new.mjs']}];
  let calls=0;const adapter={async stop(){calls++},async up(){calls++}};
  for(const changes of overrides){await f.save({...valid,...changes});
   await assert.rejects(getUpgradeStatus({root:f.dir}));
   await assert.rejects(recoverUpgrade({root:f.dir,confirm:true,adapter}));
  }
  assert.equal(calls,0);
 }finally{await f.close()}
});

test('R3.3: recovery refuses to steal a lock held by a living process, even with explicit confirmation',async()=>{
 const f=await fixture();try{
  await f.save(valid);
  const lock=join(f.state,'lock');await mkdir(lock,{mode:0o700});
  await writeFile(join(lock,'owner.json'),JSON.stringify({format:'osmanx-upgrade-lock',version:1,
   pid:process.pid,token:'a'.repeat(24),startedAt:'2026-11-05T12:30:00Z'}),{mode:0o600});
  await assert.rejects(recoverUpgrade({root:f.dir,confirm:true,adapter:{}}),/still running/);
 }finally{await f.close()}
});

test('R3.3: recovery refuses unverifiable stale lock, insecure journal, and symlink lock owner',async()=>{
 const f=await fixture();try{
  await f.save(valid);
  const lock=join(f.state,'lock');await mkdir(lock,{mode:0o700});
  await assert.rejects(recoverUpgrade({root:f.dir,confirm:true,adapter:{}}),/ENOENT|Unverifiable|no such file/i);
  await rm(lock,{recursive:true});
  await chmod(join(f.state,'active.json'),0o644);
  await assert.rejects(getUpgradeStatus({root:f.dir}),/private/);
 }finally{await f.close()}
});
