import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {createR48S3Transport,signR48S3Request} from '../src/migration/r48-s3.mjs';
const accessKey='TESTSYNTHETICKEY0001',secretKey=randomBytes(32).toString('hex');
const bucket='ox-r48-test-bucket',region='eu-north-1',tenant='a'.repeat(24)+'/';
async function setup(){
  const objects=new Map();let requests=0,authenticated=0,controls=true;
  const server=createServer(async(req,res)=>{
    requests++;
    let chunks=[];for await(const x of req)chunks.push(x);
    const body=Buffer.concat(chunks);
    const [path,query='']=req.url.split('?');
    const signed=signR48S3Request({method:req.method,path,query,body,host:req.headers.host,
      region,accessKey,secretKey,now:new Date(req.headers['x-amz-date'].replace(
        /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/,'$1-$2-$3T$4:$5:$6Z')),
      headers:req.headers['if-none-match']?{'if-none-match':req.headers['if-none-match']}:{}
    });
    if(req.headers.authorization!==signed.authorization){res.writeHead(403);res.end();return;}
    authenticated++;
    if(query==='versioning='){
      res.writeHead(200);res.end(controls?'<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>':'<Status>Suspended</Status>');return;
    }
    if(query==='object-lock='){
      res.writeHead(200);res.end(controls?'<ObjectLockConfiguration><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>':'<ObjectLockEnabled>Disabled</ObjectLockEnabled>');return;
    }
    if(req.method==='PUT'){
      if(req.headers['if-none-match']==='*'&&objects.has(path)){res.writeHead(412);res.end();return;}
      objects.set(path,body);res.writeHead(204);res.end();return;
    }
    const existing=objects.get(path);
    if(!existing){res.writeHead(404);res.end();return;}
    res.writeHead(200);res.end(existing);
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const cfg={endpoint:'http://127.0.0.1:'+server.address().port+'/',bucket,region,
    accessKey,secretKey,projectPrefix:tenant,allowSyntheticLoopback:true};
  return {transport:createR48S3Transport(cfg),cfg,objects,
    metrics:()=>({requests,authenticated}),disableControls:()=>{controls=false;},
    close:()=>new Promise(ok=>server.close(ok))};
}
test('R4.8 signs all object requests, enforces enabled object lock and round-trips encrypted objects',async()=>{
  const f=await setup();
  try{
    assert.equal((await f.transport.assertBucketControls()).objectLockEnabled,true);
    const key='archives/'+'b'.repeat(32)+'.oxb',data=randomBytes(1500);
    assert.equal(await f.transport.put(key,data),true);
    assert.deepEqual(await f.transport.get(key),data);
    assert.equal(await f.transport.put(key,data),true,'immutable retry with identical payload');
    await assert.rejects(f.transport.put(key,randomBytes(1500)),
      /immutable object key reused for different content/);
    assert.equal(f.metrics().requests,f.metrics().authenticated);
    assert(f.metrics().requests>=6);
  }finally{await f.close();}
});
test('R4.8 denies missing S3 Object Lock and bucket versioning',async()=>{
  const f=await setup();try{
    f.disableControls();
    await assert.rejects(f.transport.assertBucketControls(),/versioning is not enabled/);
  }finally{await f.close();}
});
test('R4.8 refuses SSRF-like arbitrary endpoints, keys, and plaintext HTTP',async()=>{
  const cfg={bucket,region,accessKey,secretKey,projectPrefix:tenant};
  assert.throws(()=>createR48S3Transport({...cfg,endpoint:'http://example.com/'}),
    /fixed HTTPS root/);
  assert.throws(()=>createR48S3Transport({...cfg,endpoint:'https://name:pass@example.com/'}),
    /fixed HTTPS root/);
  const f=await setup();try{
    await assert.rejects(f.transport.get('../../secret'),/unsupported object key/);
    await assert.rejects(f.transport.put('head.json',Buffer.alloc(0)),/encrypted object bytes required/);
  }finally{await f.close();}
});
