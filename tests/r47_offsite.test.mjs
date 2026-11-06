import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createR47ObjectReceiver} from '../src/migration/r47-receiver.mjs';
import {createR47Transport} from '../src/migration/r47-transport.mjs';
import {createR46VaultBackup} from '../src/migration/r46-vault.mjs';
import {r47TenantToken,synchronizeR47Offsite,recoverR47Offsite,inspectR47OffsiteStatus}
  from '../src/migration/r47-offsite.mjs';
import {runR47DueTick,readR47Schedule,assessR47BackupHealth,startR47Scheduler}
  from '../src/migration/r47-scheduler.mjs';
import {validateR47Options} from '../src/migration/r47-http.mjs';

const P='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const fixtureBytes=Buffer.concat([Buffer.from('SQLite format 3\0'),randomBytes(5000)]);
async function setup(){
  const root=await mkdtemp(join(tmpdir(),'ox-r47-unit-'));
  const catalogKey=randomBytes(32),encKey=randomBytes(32),token=randomBytes(32).toString('hex');
  const vault={directory:join(root,'vault'),projectId:P,manifestSha256:'a'.repeat(64),
    catalogKey,keyRing:{activeId:'key_one',keys:{key_one:encKey}}};
  const receiver=createServer(createR47ObjectReceiver({root:join(root,'remote'),token}));
  await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));
  const endpoint='http://127.0.0.1:'+receiver.address().port+'/';
  const transport=()=>createR47Transport({endpoint,token,
    tenantToken:r47TenantToken(catalogKey,P),allowLoopbackHttp:true});
  return {root,vault,receiver,endpoint,token,transport,catalogKey,
    async close(){await new Promise(resolve=>receiver.close(resolve));await rm(root,{recursive:true,force:true});}};
}
test('R4.7 persists only encrypted objects and restores without the local vault disk',async()=>{
  const f=await setup();
  try{
    await createR46VaultBackup(f.vault,{plaintext:fixtureBytes});
    await createR46VaultBackup(f.vault,{plaintext:fixtureBytes});
    const report=await synchronizeR47Offsite({vault:f.vault,remote:f.transport()});
    assert.equal(report.uploadedArchives,2);assert.equal(report.remoteReadbackVerified,true);
    assert.equal((await inspectR47OffsiteStatus({vault:f.vault,remote:f.transport()})).healthy,true);
    await rm(f.vault.directory,{recursive:true,force:true}); // local disk lost
    const remote=await recoverR47Offsite({vault:f.vault,remote:f.transport()});
    try{assert.deepEqual(remote.plaintext,fixtureBytes);assert.equal(remote.catalogVerified,true);}
    finally{remote.plaintext.fill(0);}
    const listing=await f.transport().get('head.json');
    assert(!listing.includes(Buffer.from('SQLite format 3')));
  }finally{await f.close();}
});
test('R4.7 retries interrupted uploads idempotently; head appears only after all blobs',async()=>{
  const f=await setup();
  try{
    await createR46VaultBackup(f.vault,{plaintext:fixtureBytes});
    await createR46VaultBackup(f.vault,{plaintext:fixtureBytes});
    let count=0;const actual=f.transport();
    const interrupted={get:key=>actual.get(key),put:async(key,body)=>{
      count++;if(count===2)throw Error('simulated network failure');return actual.put(key,body);
    }};
    await assert.rejects(synchronizeR47Offsite({vault:f.vault,remote:interrupted}),/simulated network failure/);
    await assert.rejects(actual.get('head.json'),/remote HTTP 404/);
    const repaired=await synchronizeR47Offsite({vault:f.vault,remote:actual});
    assert.equal(repaired.uploadedArchives,2);
    const again=await synchronizeR47Offsite({vault:f.vault,remote:actual});
    assert.equal(again.remoteReadbackVerified,true);
  }finally{await f.close();}
});
test('R4.7 detects ciphertext alteration on the remote disk and fails closed',async()=>{
  const f=await setup();
  try{
    const saved=await createR46VaultBackup(f.vault,{plaintext:fixtureBytes});
    await synchronizeR47Offsite({vault:f.vault,remote:f.transport()});
    const path=join(f.root,'remote',r47TenantToken(f.catalogKey,P),
      'archives',saved.record.id+'.oxb');
    const original=await readFile(path),corrupt=Buffer.from(original);
    corrupt[corrupt.length-1]^=1;await writeFile(path,corrupt);
    await assert.rejects(recoverR47Offsite({vault:f.vault,remote:f.transport()}),
      /remote encrypted blob digest mismatch/);
  }finally{await f.close();}
});
test('R4.7 refuses cross-tenant replay, unauthorized token and HTTP redirects',async()=>{
  const f=await setup();
  try{
    await createR46VaultBackup(f.vault,{plaintext:fixtureBytes});
    await synchronizeR47Offsite({vault:f.vault,remote:f.transport()});
    const wrongToken=createR47Transport({endpoint:f.endpoint,
      token:randomBytes(32).toString('hex'),tenantToken:r47TenantToken(f.catalogKey,P),
      allowLoopbackHttp:true});
    await assert.rejects(wrongToken.get('head.json'),/remote HTTP 401/);
    const other=createR47Transport({endpoint:f.endpoint,token:f.token,
      tenantToken:r47TenantToken(f.catalogKey,OTHER),allowLoopbackHttp:true});
    await assert.rejects(recoverR47Offsite({vault:{...f.vault,projectId:OTHER},remote:other}),
      /remote HTTP 404/);
    const redirect=createServer((req,res)=>{res.writeHead(302,{location:'http://127.0.0.1/unsafe'});res.end();});
    await new Promise(resolve=>redirect.listen(0,'127.0.0.1',resolve));
    try{
      const x=createR47Transport({endpoint:'http://127.0.0.1:'+redirect.address().port+'/',
        token:f.token,tenantToken:r47TenantToken(f.catalogKey,P),allowLoopbackHttp:true});
      await assert.rejects(x.get('head.json'),/remote HTTP 302/);
    }finally{await new Promise(resolve=>redirect.close(resolve));}
  }finally{await f.close();}
});
test('R4.7 refuses plaintext HTTP outside loopback and arbitrary remote object keys',async()=>{
  assert.throws(()=>createR47Transport({endpoint:'http://public.example/',
    token:randomBytes(32).toString('hex'),tenantToken:'a'.repeat(24),allowLoopbackHttp:true}),
    /HTTPS fixed root endpoint/);
  const f=await setup();
  try{
    await assert.rejects(f.transport().put('../../secrets',Buffer.from('x')),/unsupported remote object key/);
    await assert.rejects(f.transport().get('https://evil.test'),/unsupported remote object key/);
  }finally{await f.close();}
});
test('R4.7 schedule commits only proven remote restore; cooldown survives restart',async()=>{
  const f=await setup();
  try{
    const input={directory:join(f.root,'schedule'),projectId:P,catalogKey:f.catalogKey};
    const at=Date.parse('2026-11-06T08:00:00Z');
    let called=0;
    const executor=async()=>{called++;return {remoteReadbackVerified:true,
      restoredIntegrityVerified:true,productionCutoverAllowed:false};};
    const first=await runR47DueTick(input,{now:at,intervalMinutes:60,execute:executor});
    assert.equal(first.ran,true);assert.equal(called,1);
    const ignored=await runR47DueTick(input,{now:at+1000,intervalMinutes:60,execute:executor});
    assert.equal(ignored.reason,'not-due');assert.equal(called,1);
    const status=assessR47BackupHealth(await readR47Schedule(input),
      {now:at+1000,maxAgeMinutes:180});
    assert.equal(status.healthy,true);
    assert.equal((await runR47DueTick(input,{now:at+61*60000,intervalMinutes:60,
      execute:executor})).ran,true);assert.equal(called,2);
  }finally{await f.close();}
});
test('R4.7 failed upload remains degraded and retries after backoff without false success',async()=>{
  const f=await setup();
  try{
    const input={directory:join(f.root,'schedule'),projectId:P,catalogKey:f.catalogKey},now=Date.now();
    await assert.rejects(runR47DueTick(input,{now,execute:async()=>{throw Error('remote offline');}}),
      /remote offline/);
    assert.equal((await readR47Schedule(input)).status,'failed');
    assert.equal(assessR47BackupHealth(await readR47Schedule(input),{now}).healthy,false);
    const skipped=await runR47DueTick(input,{now:now+30000,execute:async()=>{throw Error('unexpected');}});
    assert.equal(skipped.reason,'retry-backoff');
    const restored=await runR47DueTick(input,{now:now+61000,execute:async()=>({
      remoteReadbackVerified:true,restoredIntegrityVerified:true,productionCutoverAllowed:false})});
    assert.equal(restored.ran,true);assert.equal(restored.state.failedAttempts,0);
  }finally{await f.close();}
});
test('R4.7 stale running checkpoint is retried and tampered checkpoint is rejected',async()=>{
  const f=await setup();
  try{
    const dir=join(f.root,'schedule'),input={directory:dir,projectId:P,catalogKey:f.catalogKey};
    await mkdir(dir,{recursive:true,mode:0o700});
    const now=Date.parse('2026-11-06T08:00:00Z');
    const fields={format:'osmanx-r47-schedule-v1',projectId:P,sequence:3,
      status:'running',lastAttemptAt:new Date(now).toISOString(),lastSuccessAt:null,failedAttempts:0};
    const mac=createHmac('sha256',f.catalogKey)
      .update('OSMANX-R47-SCHEDULE-v1\0').update(JSON.stringify(fields)).digest('hex');
    await writeFile(join(dir,'state.json'),JSON.stringify({...fields,mac}),{mode:0o600});
    const resumed=await runR47DueTick(input,{now:now+120000,execute:async()=>({
      remoteReadbackVerified:true,restoredIntegrityVerified:true,productionCutoverAllowed:false})});
    assert.equal(resumed.recoveredInterruptedRun,true);
    const bad=await readFile(join(dir,'state.json'),'utf8');
    await writeFile(join(dir,'state.json'),bad.replace('"status":"ok"','"status":"failed"'));
    await assert.rejects(readR47Schedule(input),/schedule checkpoint authentication failed/);
  }finally{await f.close();}
});
test('R4.7 automated scheduler only invokes explicitly configured IDs',async()=>{
  const ids=[P],called=[];
  const timer=startR47Scheduler({projects:ids,periodMs:1000,run:async id=>called.push(id)});
  try{await timer.tick();assert.deepEqual(called,[P]);}
  finally{timer.stop();}
});
test('R4.7 remote/schedule startup is disabled by default and insists on signed synthetic base',()=>{
  assert.equal(validateR47Options({}),null);
  assert.throws(()=>validateR47Options({OX_R47_OFFSITE:'YES'}),/only isolated synthetic/);
});
