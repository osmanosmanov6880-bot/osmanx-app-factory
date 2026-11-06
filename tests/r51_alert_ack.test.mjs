import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes,createHmac} from 'node:crypto';
import {createR51AlertChallengeClient,createR51AlertChallengeReceiver}
  from '../src/migration/r51-alert-ack.mjs';
const tenant='a'.repeat(24);
async function setup(){
  const secret=randomBytes(32),token=randomBytes(32).toString('hex');
  const server=createServer(createR51AlertChallengeReceiver({token,secret}));
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const endpoint='http://127.0.0.1:'+server.address().port+'/';
  const client=createR51AlertChallengeClient({endpoint,token,secret,
    tenantToken:tenant,allowSyntheticLoopback:true});
  return {secret,token,endpoint,client,
    close:()=>new Promise(ok=>server.close(ok))};
}
test('R5.1 signed challenge verifies fresh machine ack, not a human pager',async()=>{
  const f=await setup();try{
    const ack=await f.client.probe();
    assert.equal(ack.signedAckVerified,true);
    assert.equal(ack.nonceMatched,true);
    assert.equal(ack.humanOnCallVerified,false);
    assert.equal(ack.productionCutoverAllowed,false);
  }finally{await f.close();}
});
test('R5.1 wrong bearer cannot masquerade as successful delivery',async()=>{
  const f=await setup();try{
    const bad=createR51AlertChallengeClient({endpoint:f.endpoint,
      token:randomBytes(32).toString('hex'),secret:f.secret,tenantToken:tenant,
      allowSyntheticLoopback:true});
    await assert.rejects(bad.probe(),/receiver HTTP status 401/);
  }finally{await f.close();}
});
test('R5.1 wrong-signature response fails even with HTTP 200',async()=>{
  const secret=randomBytes(32),token=randomBytes(32).toString('hex');
  const server=createServer(async(req,res)=>{
    for await(const b of req){}
    const body=JSON.stringify({format:'osmanx-r51-alert-ack-v1',
      code:'DR_TEST_ACK',nonce:'f'.repeat(32),tenantToken:tenant,receivedAt:Date.now()});
    res.writeHead(200,{'x-ox-dr-ack-signature':'a'.repeat(64)});res.end(body);
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try{
    const c=createR51AlertChallengeClient({endpoint:'http://127.0.0.1:'+server.address().port+'/',
      secret,token,tenantToken:tenant,allowSyntheticLoopback:true});
    await assert.rejects(c.probe(),/acknowledgement signature invalid/);
  }finally{await new Promise(ok=>server.close(ok));}
});
test('R5.1 correctly signed acknowledgement to a different nonce fails closed',async()=>{
  const secret=randomBytes(32),token=randomBytes(32).toString('hex');
  const server=createServer(async(req,res)=>{
    for await(const b of req){}
    const body=Buffer.from(JSON.stringify({format:'osmanx-r51-alert-ack-v1',
      code:'DR_TEST_ACK',nonce:'f'.repeat(32),tenantToken:tenant,receivedAt:Date.now()}));
    const signature=createHmac('sha256',secret)
      .update('OSMANX-R51-ALERT-ACK-v1\0').update(body).digest('hex');
    res.writeHead(200,{'x-ox-dr-ack-signature':signature});res.end(body);
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  try{
    const c=createR51AlertChallengeClient({endpoint:'http://127.0.0.1:'+server.address().port+'/',
      secret,token,tenantToken:tenant,allowSyntheticLoopback:true});
    await assert.rejects(c.probe(),/wrong nonce, tenant or time/);
  }finally{await new Promise(ok=>server.close(ok));}
});
test('R5.1 plain HTTP to non-loopback is forbidden',()=>{
  assert.throws(()=>createR51AlertChallengeClient({
    endpoint:'http://alerts.example.com/',secret:randomBytes(32),
    token:randomBytes(32).toString('hex'),tenantToken:tenant
  }),/fixed HTTPS root required/);
});
test('R5.1 receiver refuses expired and tampered request signatures',async()=>{
  const f=await setup();try{
    const bytes=Buffer.from(JSON.stringify({format:'osmanx-r51-alert-challenge-v1',
      code:'DR_TEST',tenantToken:tenant,nonce:'b'.repeat(32),issuedAt:Date.now()-180000}));
    const sig=createHmac('sha256',f.secret)
      .update('OSMANX-R51-ALERT-REQUEST-v1\0').update(bytes).digest('hex');
    const old=await fetch(f.endpoint+'v1/dr-challenge',{
      method:'POST',headers:{authorization:'Bearer '+f.token,
        'x-ox-dr-request-signature':sig},body:bytes});
    assert.equal(old.status,400);
    const altered=await fetch(f.endpoint+'v1/dr-challenge',{
      method:'POST',headers:{authorization:'Bearer '+f.token,
        'x-ox-dr-request-signature':'f'.repeat(64)},body:bytes});
    assert.equal(altered.status,400);
  }finally{await f.close();}
});
