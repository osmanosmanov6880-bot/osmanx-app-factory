import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireLock} from '../src/common/maintenance.mjs';
import {createRuntimeCounters,loadRuntimeSummary} from '../src/common/runtime-health.mjs';
const id='d193604d-0dea-41ea-bc00-1fb01cb96a3c';
const fixture=async fn=>{const dir=await mkdtemp(join(tmpdir(),'osmanx-r36-'));try{return await fn(dir)}finally{await rm(dir,{recursive:true,force:true})}};

test('R3.6 PID reuse: dead container PID 1 or reused live PID no longer blocks safe restart',()=>fixture(async dir=>{
 const lock=join(dir,'server.lock');
 if(process.platform!=='linux')return;
 await writeFile(lock,JSON.stringify({kind:'server',pid:process.pid,startTicks:'0'}),{mode:0o600});
 const unlock=acquireLock(dir,'server');
 const value=JSON.parse(await readFile(lock,'utf8'));
 assert.equal(value.pid,process.pid);assert.match(value.startTicks,/^\d+$/);
 assert.throws(()=>acquireLock(dir,'maintenance'),/active/);
 unlock();
 await writeFile(lock,JSON.stringify({kind:'server',pid:process.pid}),{mode:0o600});
 assert.throws(()=>acquireLock(dir,'server'),/active/, 'old PID-only locks must fail closed');
}));

test('R3.6 lock validation refuses symlinks, malformed locks, and wrong process kind',()=>fixture(async dir=>{
 const lock=join(dir,'server.lock');
 await writeFile(join(dir,'target'),'locked');await symlink(join(dir,'target'),lock);
 assert.throws(()=>acquireLock(dir,'server'),/Invalid lock/);
 await rm(lock);await writeFile(lock,JSON.stringify({pid:process.pid,kind:'maintenance',startTicks:'1'}),{mode:0o600});
 assert.throws(()=>acquireLock(dir,'server'),/Invalid lock identity/);
}));

test('R3.6 counters are private, bounded, aggregate and survive a graceful restart',()=>fixture(async dir=>{
 const options={dataDir:dir,projectId:id,service:'crm',releaseSequence:3,flushDelayMs:50};
 const a=await createRuntimeCounters(options);
 for(const status of [200,200,404,503,500,200])a.record(status);
 await a.flush();
 const text=await readFile(join(dir,'.osmanx-observability','summary.json'),'utf8');
 assert.ok(!text.includes('customer')&&!text.includes('url')&&!text.includes('body'));
 const summary=await loadRuntimeSummary({...options,now:Date.now()});
 assert.equal(summary.status,'observed');
 assert.deepEqual([summary.requests,summary.clientErrors,summary.serverErrors,summary.maintenanceUnavailable],[6,1,2,1]);
 if(process.platform!=='win32')assert.equal((await stat(join(dir,'.osmanx-observability','summary.json'))).mode&0o077,0);
 const b=await createRuntimeCounters(options);b.record(200);await b.flush();
 const next=await loadRuntimeSummary({...options,now:Date.now()});assert.equal(next.requests,7);
 const newer=await createRuntimeCounters({...options,releaseSequence:4});newer.record(200);await newer.flush();
 const newSum=await loadRuntimeSummary({...options,releaseSequence:4,now:Date.now()});assert.equal(newSum.requests,1);
}));

test('R3.6 runtime counters reject linked storage and identities from another project',()=>fixture(async dir=>{
 const a=await createRuntimeCounters({dataDir:dir,projectId:id,service:'site',releaseSequence:0});a.record(500);await a.flush();
 await assert.rejects(loadRuntimeSummary({dataDir:dir,projectId:'0d9e27b9-18a0-4ef1-92d6-80671c4cc0ce',service:'site',releaseSequence:0}),/identity/);
 const actual=join(dir,'.osmanx-observability','summary.json');const backup=join(dir,'backup');
 await writeFile(backup,await readFile(actual));await rm(actual);await symlink(backup,actual);
 await assert.rejects(loadRuntimeSummary({dataDir:dir,projectId:id,service:'site',releaseSequence:0}),/Unsafe/);
 await assert.rejects(createRuntimeCounters({dataDir:dir,projectId:id,service:'site',releaseSequence:0}),/Unsafe/);
}));
