import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequestDrain} from '../src/common/request-drain.mjs';
import {exportDeploymentBundle} from '../src/studio/deployment.mjs';
import {parseStoredZip} from '../src/common/archive.mjs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const project=id=>({id,name:'Drain smoke',type:'crm',industry:'restaurant',modules:['auth','clients'],settings:{accent:'#556677',currency:'RUB',primaryAction:'navigate_overview'},pages:[],entities:[],automationPresets:[]});

test('R3.3 request gate drains an in-flight write before SQLite cleanup, and stop is idempotent',async()=>{
  let release,markStarted;
  const started=new Promise(r=>markStarted=r);
  const hold=new Promise(r=>release=r);
  const calls=[];
  const drain=createRequestDrain(async(req,res)=>{
    calls.push('handler-start');markStarted();await hold;calls.push('commit');res.end('committed');
  },{graceMs:4000});
  const server=createServer(drain.handle);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  try{
    const pending=fetch(origin+'/write',{method:'POST'});
    await started;
    let cleaned=0;
    const stopping=drain.stop(server,()=>{cleaned++;calls.push('db-close')});
    assert.equal(drain.draining,true);
    assert.equal(drain.active,1);
    assert.equal(drain.stop(server,()=>{throw Error('should not run twice')}),stopping);
    await new Promise(r=>setTimeout(r,25));assert.equal(cleaned,0,'SQLite must stay open while request is active');
    release();const response=await pending;assert.equal(response.status,200);assert.equal(await response.text(),'committed');
    assert.equal((await stopping).drained,true);
    assert.deepEqual(calls,['handler-start','commit','db-close']);
    assert.equal(cleaned,1);assert.equal(drain.active,0);
  }finally{release();server.close()}
});

test('R3.3 request gate rejects requests after drain started without starting another DB write',async()=>{
  let handled=0;
  const drain=createRequestDrain(async(req,res)=>{handled++;res.end('ok')});
  const before={method:'POST'};
  const fake=()=>{
    const record={headers:null,body:null};
    return {record,res:{writeHead(status,headers){record.status=status;record.headers=headers},end(body){record.body=body}}};
  };
  const first=fake();await drain.handle(before,first.res);assert.equal(handled,1);
  const server={close(callback){callback()},closeIdleConnections(){}};
  await drain.stop(server,()=>{});
  const after=fake();await drain.handle(before,after.res);
  assert.equal(after.record.status,503);assert.equal(after.record.headers['Retry-After'],'30');
  assert.equal(handled,1);assert.match(after.record.body,/temporarily unavailable/);
});

test('R3.3 drain timeout never closes SQLite while a handler is unresolved',async()=>{
  let release,markStarted;const started=new Promise(r=>markStarted=r);
  const work=new Promise(r=>release=r);
  const drain=createRequestDrain(async(req,res)=>{markStarted();await work;res.end('ok')},{graceMs:120});
  const server=createServer(drain.handle);server.listen(0,'127.0.0.1');await once(server,'listening');
  const pending=fetch('http://127.0.0.1:'+server.address().port+'/long');
  await started;
  let closedDb=false;
  try{await assert.rejects(drain.stop(server,()=>{closedDb=true}),/HTTP drain exceeded/);assert.equal(closedDb,false);}
  finally{release();await pending;}
});

test('R3.3 every exported CRM and site includes a graceful server plus a longer Docker stop deadline',async()=>{
  for(const type of ['crm','site']){
    const p={...project('a65eab0d-e9b6-4df7-b3de-dc9931260ad1'),type,industry:type==='site'?'business':'restaurant',modules:type==='site'?['auth','cms','leads']:['auth','clients']};
    const zip=parseStoredZip(await exportDeploymentBundle(p,root,'customer.osmanx.co'),{maxFiles:400,maxBytes:80e6});
    assert.match(zip.get('run.mjs').toString(),/createRequestDrain/);
    assert.ok(zip.has('src/common/request-drain.mjs'));
    assert.match(zip.get('compose.yaml').toString(),/stop_grace_period: 90s/);
    assert.match(zip.get('deploy/upgrade.mjs').toString(),/\['stop','--timeout','90','app'\]/);
  }
});
