import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createR48AlertOutbox,createR48AlertSender} from '../src/migration/r48-alerts.mjs';
const P='11111111-1111-4111-8111-111111111111',TOKEN='a'.repeat(24);
test('R4.8 durable alerts retry failures, deduplicate pending events and survive re-open',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ox-r48-outbox-'));
  const queueKey=randomBytes(32),events=[];
  let attempt=0;const sender=async x=>{attempt++;if(attempt===1)throw Error('offline');events.push(x);};
  const make=()=>createR48AlertOutbox({directory:dir,projectId:P,
    tenantToken:TOKEN,queueKey,sender,backoffMs:1000});
  try{
    const a=make(),first=await a.emit('REMOTE_UNAVAILABLE',{now:10000});
    const same=await a.emit('REMOTE_UNAVAILABLE',{now:10001});
    assert.equal(same.id,first.id);assert.equal(same.deduplicated,true);
    assert.deepEqual(await a.flush({now:10000}),{delivered:0,failed:1,
      pending:1,privacySafe:true,productionCutoverAllowed:false});
    const reopened=make();
    assert.equal((await reopened.status()).pending,1);
    assert.equal((await reopened.flush({now:10500})).delivered,0);
    assert.equal((await reopened.flush({now:11001})).delivered,1);
    assert.equal((await reopened.status()).pending,0);
    assert.deepEqual(Object.keys(events[0]).sort(),
      ['code','createdAt','format','id','tenantToken'].sort());
    assert.equal(JSON.stringify(events).includes(P),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('R4.8 signed notification webhook sends only allowlisted event fields and signed payload',async()=>{
  const secret=randomBytes(32),received=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const x of req)chunks.push(x);
    const data=Buffer.concat(chunks);
    const expected=createHmac('sha256',secret)
      .update('OSMANX-R48-WEBHOOK-v1\0').update(req.headers['x-ox-alert-at'])
      .update('\0').update(data).digest('hex');
    if(req.headers['x-ox-alert-signature']!==expected){res.writeHead(403);res.end();return;}
    received.push(JSON.parse(data));res.writeHead(204);res.end();
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try{
    const sender=createR48AlertSender({endpoint:'http://127.0.0.1:'+
      server.address().port+'/',secret,allowSyntheticLoopback:true});
    await sender({format:'osmanx-r48-alert-v1',id:'a'.repeat(24),
      code:'ROLLBACK_DETECTED',tenantToken:TOKEN,createdAt:new Date().toISOString()});
    assert.equal(received.length,1);
    assert.equal(received[0].code,'ROLLBACK_DETECTED');
    await assert.rejects(sender({code:'CLIENT_PHONE',tenantToken:TOKEN}),/unrecognized/);
  }finally{await new Promise(ok=>server.close(ok));}
});
test('R4.8 outbox fails closed on disk alteration and invalid identifiers',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ox-r48-tamper-'));
  const queueKey=randomBytes(32),sender=async()=>{};
  const opts={directory:dir,projectId:P,tenantToken:TOKEN,queueKey,sender};
  try{
    const q=createR48AlertOutbox(opts);
    await q.emit('RESTORE_FAILED');
    const path=join(dir,'queue.json'),raw=await readFile(path,'utf8');
    await writeFile(path,raw.replace('"code":"RESTORE_FAILED"','"code":"RECOVERED"'));
    await assert.rejects(q.status(),/outbox authentication failed/);
    assert.throws(()=>createR48AlertSender({endpoint:'http://example.org/',secret:queueKey}),
      /fixed HTTPS webhook/);
    await assert.rejects(q.emit('ARBITRARY_MESSAGE'),/invalid alert/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
