// R5.1: authenticated, nonce-bound DR alert acknowledgement.
// An HTTP 200 is not proof of delivery. Only a fresh response signed by a
// separate alert receiver is accepted. No customer details are transmitted.
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
const TENANT=/^[a-f0-9]{24}$/,NONCE=/^[a-f0-9]{32}$/,HEX=/^[a-f0-9]{64}$/;
function deny(ok,msg){if(!ok)throw Error('R5.1 alert acknowledgement refused: '+msg);}
function mac(key,domain,data){return createHmac('sha256',key)
  .update(domain+'\0').update(data).digest('hex');}
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&
  HEX.test(a)&&HEX.test(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function endpoint(value,synthetic){
  let u;try{u=new URL(value);}catch{throw Error('R5.1 alert acknowledgement refused: invalid endpoint');}
  const local=synthetic===true&&u.protocol==='http:'&&
    ['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  deny((u.protocol==='https:'||local)&&u.pathname==='/'&&
    !u.username&&!u.password&&!u.search&&!u.hash,
    'fixed HTTPS root required; HTTP loopback only in isolated CI');
  return {u,local};
}
export function createR51AlertChallengeClient({
  endpoint:address,token,secret,tenantToken,allowSyntheticLoopback=false
}={}){
  deny(Buffer.isBuffer(secret)&&secret.length===32&&
    typeof token==='string'&&/^[A-Za-z0-9._~-]{32,256}$/.test(token)&&
    TENANT.test(tenantToken||''),'independent alert key, token and tenant required');
  const {u,local}=endpoint(address,allowSyntheticLoopback),agent=local?http:https;
  async function probe({now=Date.now()}={}){
    deny(Number.isSafeInteger(now)&&now>0,'invalid request timestamp');
    const nonce=randomBytes(16).toString('hex');
    const body=Buffer.from(JSON.stringify({format:'osmanx-r51-alert-challenge-v1',
      code:'DR_TEST',tenantToken,nonce,issuedAt:now}));
    const signature=mac(secret,'OSMANX-R51-ALERT-REQUEST-v1',body);
    const received=await new Promise((resolve,reject)=>{
      const req=agent.request({protocol:u.protocol,hostname:u.hostname,port:u.port,
        method:'POST',path:'/v1/dr-challenge',timeout:8000,maxHeaderSize:8192,
        headers:{authorization:'Bearer '+token,'content-type':'application/json',
          'content-length':String(body.length),
          'x-ox-dr-request-signature':signature}},res=>{
        let total=0;const chunks=[];
        res.on('data',part=>{
          total+=part.length;
          if(total>4096){req.destroy(Error('R5.1 alert acknowledgement refused: response too large'));return;}
          chunks.push(part);
        });
        res.on('end',()=>resolve({status:res.statusCode||0,
          bytes:Buffer.concat(chunks),signature:res.headers['x-ox-dr-ack-signature']}));
        res.on('error',reject);
      });
      req.on('timeout',()=>req.destroy(Error('R5.1 alert acknowledgement refused: timeout')));
      req.on('error',reject);req.end(body);
    });
    deny(received.status===200,'receiver HTTP status '+received.status);
    deny(equal(received.signature,mac(secret,'OSMANX-R51-ALERT-ACK-v1',received.bytes)),
      'receiver acknowledgement signature invalid');
    let ack;try{ack=JSON.parse(received.bytes.toString('utf8'));}
    catch{throw Error('R5.1 alert acknowledgement refused: invalid response JSON');}
    deny(ack.format==='osmanx-r51-alert-ack-v1'&&ack.code==='DR_TEST_ACK'&&
      ack.nonce===nonce&&ack.tenantToken===tenantToken&&
      Number.isSafeInteger(ack.receivedAt)&&
      Math.abs(ack.receivedAt-now)<=60000,
      'receiver acknowledged wrong nonce, tenant or time');
    return Object.freeze({format:ack.format,acknowledged:true,
      signedAckVerified:true,nonceMatched:true,tenantMatched:true,
      humanOnCallVerified:false,productionCutoverAllowed:false});
  }
  return Object.freeze({probe});
}
export function createR51AlertChallengeReceiver({token,secret}={}){
  deny(typeof token==='string'&&/^[A-Za-z0-9._~-]{32,256}$/.test(token)&&
    Buffer.isBuffer(secret)&&secret.length===32,'receiver key and bearer required');
  const auth=Buffer.from(token);
  function send(res,status,body){
    res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify(body));
  }
  return async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/v1/dr-challenge'){
      req.resume();return send(res,404,{error:'not_found'});
    }
    const raw=String(req.headers.authorization||'');
    const supplied=Buffer.from(raw.startsWith('Bearer ')?raw.slice(7):'');
    if(supplied.length!==auth.length||!timingSafeEqual(supplied,auth)){
      req.resume();return send(res,401,{error:'unauthorized'});
    }
    try{
      let size=0,chunks=[];
      for await(const part of req){
        size+=part.length;deny(size<=2048,'oversized request');chunks.push(part);
      }
      const body=Buffer.concat(chunks);
      deny(equal(req.headers['x-ox-dr-request-signature'],
        mac(secret,'OSMANX-R51-ALERT-REQUEST-v1',body)),
        'request signature rejected');
      const value=JSON.parse(body.toString('utf8'));
      deny(value?.format==='osmanx-r51-alert-challenge-v1'&&
        value.code==='DR_TEST'&&TENANT.test(value.tenantToken||'')&&
        NONCE.test(value.nonce||'')&&Number.isSafeInteger(value.issuedAt)&&
        Math.abs(Date.now()-value.issuedAt)<=60000,
        'invalid or stale synthetic challenge');
      // No receipt claims to represent a human responder. This is a machine ack.
      const reply=Buffer.from(JSON.stringify({format:'osmanx-r51-alert-ack-v1',
        code:'DR_TEST_ACK',nonce:value.nonce,tenantToken:value.tenantToken,
        receivedAt:Date.now()}));
      res.writeHead(200,{'content-type':'application/json',
        'cache-control':'no-store',
        'x-ox-dr-ack-signature':mac(secret,'OSMANX-R51-ALERT-ACK-v1',reply)});
      res.end(reply);
    }catch{send(res,400,{error:'challenge_rejected'});}
  };
}
