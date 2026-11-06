import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { studioDb } from '../src/studio/db.mjs';
import { issueSession } from '../src/common/security.mjs';
import { respondError, securityHeaders } from '../src/common/http.mjs';
import { authorizePreviewProject, createR40Runtime,
  handleR40PreviewRequest, validateR40PreviewEnvironment } from '../src/migration/r40-pg-http.mjs';
import { TenantPgAdapter } from '../src/migration/pg-tenant-adapter.mjs';

const OWNER1='11111111-1111-4111-8111-111111111111';
const OWNER2='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT1='22222222-2222-4222-8222-222222222222';
const PROJECT2='33333333-3333-4333-8333-333333333333';
const CLIENT='44444444-4444-4444-8444-444444444444';
const timestamp='2026-11-06T00:00:00.000Z';
const env={OX_R40_PG_PREVIEW:'YES',PGHOST:'127.0.0.1',PGPORT:'5432',PGDATABASE:'ox_test_factory_r40',
  PGUSER:'ox_r40_runtime',PGPASSWORD:'only-for-test',OX_R40_PG_BUNDLE:'/tmp/example-bundle',OX_R40_PG_TRUST_KEY:'/tmp/pinned-key'};

async function setup() {
  const dir=await mkdtemp(join(tmpdir(),'ox-r40-unit-'));
  const db=studioDb(join(dir,'studio.sqlite'));
  for (const [owner,project] of [[OWNER1,PROJECT1],[OWNER2,PROJECT2]]) {
    db.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(owner,owner+'@example.test','synthetic','not-a-real-hash','owner',1,timestamp);
    db.prepare('INSERT INTO projects(id,owner_id,name,type,industry,modules_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(project,owner,'test','crm','restaurant',JSON.stringify(['auth','clients']),JSON.stringify({accent:'#234567'}),timestamp,timestamp);
  }
  const first=issueSession(db,OWNER1), second=issueSession(db,OWNER2);
  const calls=[];
  const fakeRuntime={adapter:{async transaction(args,callback) {
    calls.push({args});
    const scope={query:async(sql,params=[])=>{
      calls.push({sql,params});
      if(sql.startsWith('INSERT INTO clients'))return {rows:[{id:'55555555-5555-4555-8555-555555555555',full_name:params[1],phone:params[2],email:params[3],source:params[4],notes:params[5],created_at:timestamp,updated_at:timestamp}]};
      if(sql.startsWith('UPDATE clients'))return {rows:[{id:CLIENT,full_name:params[0],phone:'',email:'',source:'unknown',notes:'',created_at:timestamp,updated_at:timestamp}]};
      if(sql.includes('WHERE id='))return {rows:[{id:CLIENT,full_name:'one client',phone:'',email:'',source:'unknown',notes:'',created_at:timestamp,updated_at:timestamp}]};
      return {rows:[{id:CLIENT,full_name:'one client',phone:'',email:'',source:'unknown',notes:'',created_at:timestamp,updated_at:timestamp}]};
    }};
    return callback(scope);
  }}};
  const server=createServer(async(req,res)=>{
    securityHeaders(res);
    try{await handleR40PreviewRequest(req,res,{studioDb:db,runtime:fakeRuntime});}
    catch(e){respondError(res,e);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  return {db,calls,port,first,second,async end(){await new Promise(resolve=>server.close(resolve));db.close();await rm(dir,{recursive:true,force:true});},
    async request(path,{method='GET',session=first,csrf,body,origin}={}){
      const headers={};if(session)headers.cookie=`ox_studio=${session.token}`;
      if(csrf!==undefined)headers['x-csrf-token']=csrf;
      if(body!==undefined)headers['content-type']='application/json';
      if(origin)headers.origin=origin;
      const res=await fetch(`http://127.0.0.1:${port}`+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
      return {status:res.status,data:await res.json()};
    }};
}

const PREFIX='/api/studio/pg-preview/projects/';

test('R4.0 configuration stays disabled and rejects remote or elevated login',async()=>{
  assert.equal(await createR40Runtime({env:{OX_R40_PG_PREVIEW:'NO'}}),null);
  for (const [key,value] of [['PGHOST','db.example.com'],['PGHOSTADDR','192.168.1.2'],['PGDATABASE','app'],['PGUSER','postgres'],['PGPORT','13'],['PGOPTIONS','-c statement_timeout=0'],['PGSERVICE','evil']]) {
    assert.throws(()=>validateR40PreviewEnvironment({...env,[key]:value}),/denied|requires|restricted|unprivileged|required|cannot|PGPORT/i,key);
  }
  assert.deepEqual(validateR40PreviewEnvironment(env).database,'ox_test_factory_r40');
});

test('R4.0 signed preview creation rejects superuser before loading a tenant pool',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'ox-r40-startup-'));
  const db=studioDb(join(dir,'studio.sqlite'));
  let closed=false;
  try{
    await assert.rejects(createR40Runtime({studioDb:db,env,createPool:async()=>({
      query:async()=>({rows:[{db:env.PGDATABASE,usr:env.PGUSER,privileged:true,version:150000}]}),
      end:async()=>{closed=true;}
    })}),/unprivileged role verification failed/);
    assert.equal(closed,true);
  } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test('R4.0 HTTP refuses anonymous users, wrong owner and missing CSRF without touching PostgreSQL',async()=>{
  const f=await setup();try{
    const url=PREFIX+PROJECT2+'/clients';
    assert.equal((await f.request(url,{session:null})).status,401);
    assert.equal((await f.request(url)).status,404);
    assert.equal((await f.request(PREFIX+PROJECT1+'/clients',{method:'POST',body:{fullName:'A'}})).status,403);
    assert.equal((await f.request(PREFIX+PROJECT2+'/clients',{method:'POST',csrf:f.first.csrf,body:{fullName:'A'}})).status,404);
    assert.equal(f.calls.length,0);
  }finally{await f.end();}
});

test('R4.0 GET uses owner identity and bounded SQL parameters, not caller-provided project header',async()=>{
  const f=await setup();try{
    const r=await f.request(PREFIX+PROJECT1+'/clients?limit=10');
    assert.equal(r.status,200);
    assert.equal(r.data.clients[0].id,CLIENT);
    assert.equal(f.calls[0].args.actorId,OWNER1);
    assert.equal(f.calls[0].args.projectId,PROJECT1);
    assert.equal(f.calls[1].params[0],10);
    assert.equal((await f.request(PREFIX+PROJECT1+'/clients?limit=0')).status,400);
    assert.equal((await f.request(PREFIX+PROJECT1+'/clients?limit=51')).status,400);
    assert.equal((await f.request(PREFIX+PROJECT1+'/clients?limit=1%3BDROP')).status,400);
    const single=await f.request(PREFIX+PROJECT1+'/clients/'+CLIENT);
    assert.equal(single.status,200);
    assert.equal(f.calls.at(-1).params[0],CLIENT);
  }finally{await f.end();}
});

test('R4.0 write validates allowlist, origin and CSRF before SQL',async()=>{
  const f=await setup();try{
    const url=PREFIX+PROJECT1+'/clients';
    assert.equal((await f.request(url,{method:'POST',csrf:f.first.csrf,body:{fullName:'  Jane  ',phone:'+123',source:'social'}})).status,201);
    assert.equal(f.calls[0].args.mode,'write');
    assert.equal(f.calls[1].params[1],'Jane');
    assert.equal((await f.request(url,{method:'POST',csrf:f.first.csrf,body:{fullName:'',phone:''}})).status,400);
    assert.equal((await f.request(url,{method:'POST',csrf:f.first.csrf,body:{fullName:'Jane',ownerId:OWNER2}})).status,400);
    assert.equal((await f.request(url,{method:'POST',csrf:f.first.csrf,body:{fullName:'Jane',source:'postgres'}})).status,400);
    assert.equal((await f.request(url,{method:'POST',csrf:f.first.csrf,body:{fullName:'Jane'},origin:'https://attacker.example'})).status,403);
    const update=await f.request(url+'/'+CLIENT,{method:'PATCH',csrf:f.first.csrf,body:{fullName:'Updated'}});
    assert.equal(update.status,200);
    assert.ok(f.calls.at(-1).sql.startsWith('UPDATE clients'));
    assert.equal((await f.request(url+'/'+CLIENT,{method:'PATCH',csrf:f.first.csrf,body:{id:OWNER2}})).status,400);
  }finally{await f.end();}
});

test('R4.0 synthetic batch rejects malformed later entry inside one scoped transaction',async()=>{
  const f=await setup();try{
    const url=PREFIX+PROJECT1+'/clients/batch';
    const r=await f.request(url,{method:'POST',csrf:f.first.csrf,body:{items:[{fullName:'first'},{fullName:''}]}});
    assert.equal(r.status,400);
    assert.equal(f.calls.filter(x=>x.sql?.startsWith('INSERT INTO clients')).length,1);
    assert.equal(f.calls.filter(x=>x.args).length,1);
    const good=await f.request(url,{method:'POST',csrf:f.first.csrf,body:{items:[{fullName:'A'},{fullName:'B'}]}});
    assert.equal(good.status,201);assert.equal(good.data.clients.length,2);
    assert.equal((await f.request(url,{method:'POST',csrf:f.first.csrf,body:{items:[]}})).status,400);
  }finally{await f.end();}
});

test('R4.0 authorization callback checks SQLite ownership with no PG credentials in user input',async()=>{
  const f=await setup();try{
    const authorize=authorizePreviewProject(f.db);
    assert.equal(await authorize({actorId:OWNER1,projectId:PROJECT1}),true);
    assert.equal(await authorize({actorId:OWNER2,projectId:PROJECT1}),false);
    assert.equal(await authorize({actorId:OWNER1,projectId:PROJECT2}),false);
    assert.equal(await authorize({actorId:OWNER1,projectId:'zz'}),false);
    assert.equal((await f.request('/api/studio/pg-preview/status',{session:null})).status,401);
    const status=await f.request('/api/studio/pg-preview/status');
    assert.equal(status.status,200);assert.equal(status.data.productionCutoverApproved,false);
  }finally{await f.end();}
});

test('R4.0 adapter rolls back mid-transaction and rejects cross-tenant query context',async()=>{
  const suffix=PROJECT1.replaceAll('-','');const schema='ox_p_'+suffix;
  const events=[];
  const client={async query(sql,params){events.push({sql,params});return {rows:[]};},release(destroy){events.push({destroy});}};
  const pool={connect:async()=>client};
  const manifest={databases:[{projectId:PROJECT1,schema}],access:{roles:[{schema,reader:'ox_ro_'+suffix,writer:'ox_rw_'+suffix}]}};
  const adapter=new TenantPgAdapter({pool,manifest,authorize:async({actorId})=>actorId===OWNER1});
  await assert.rejects(adapter.transaction({actorId:OWNER1,projectId:PROJECT1,mode:'write'},async scope=>{
    await scope.query('INSERT INTO clients(id) VALUES($1)',[CLIENT]);
    throw Error('late validation failed');
  }),/late validation failed/);
  assert.ok(events.some(x=>x.sql==='ROLLBACK'));
  assert.ok(!events.some(x=>x.sql==='COMMIT'));
  assert.equal(events.at(-1).destroy,false);
  const count=events.length;
  await assert.rejects(adapter.transaction({actorId:OWNER2,projectId:PROJECT1,mode:'read'},async()=>{}),/authorization denied/);
  assert.equal(events.length,count);
});
