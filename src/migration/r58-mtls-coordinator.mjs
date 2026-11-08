// R5.8 isolated mTLS checkpoint protocol, strictly pinned to one tenant.
// Transport authentication, signed request/response, durable nonce consumption.
// Never accepts arbitrary SQL, S3 paths, bucket names or caller-supplied URLs.
import https from 'node:https';
import tls from 'node:tls';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';

const PROTOCOL='osmanx-r58-mtls-v1',HEX=/^[a-f0-9]{64}$/,
  TENANT=/^[a-f0-9]{24}$/,NONCE=/^[a-f0-9]{32}$/,
  OPID=/^[a-f0-9]{32}$/,MAX=12*1024,MAX_BODY=4096,WINDOW=30000;
const OPS=new Set(['acquire','renew','assert','release','publish','recover','inspect']);
function deny(ok,reason){if(!ok)throw Error('R5.8 mTLS refused: '+reason);}
function hex(buf){return createHash('sha256').update(buf).digest('hex');}
function equal(a,b){
  return typeof a==='string'&&typeof b==='string'&&HEX.test(a)&&HEX.test(b)&&
    timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
function mac(key,role,body){
  return createHmac('sha256',key).update('OSMANX-R58-'+role+'-v1\0')
    .update(JSON.stringify(body)).digest('hex');
}
function onlyKeys(obj,required,optional=[]){
  deny(obj&&typeof obj==='object'&&!Array.isArray(obj)&&
    Object.keys(obj).every(k=>[...required,...optional].includes(k))&&
    required.every(k=>Object.hasOwn(obj,k)), 'unsupported payload shape');
}
function keyCheck(key,tenant){
  deny(Buffer.isBuffer(key)&&key.length===32&&TENANT.test(tenant||''),
    'independent 32-byte signature secret and opaque tenant required');
}
function requestFields({tenant,nonce,issuedAt,op,payload}){
  return {protocol:PROTOCOL,tenant,nonce,issuedAt,op,payload};
}
export function signR58Request(key,{tenant,nonce,issuedAt,op,payload}){
  keyCheck(key,tenant);
  const value=requestFields({tenant,nonce,issuedAt,op,payload});
  return {...value,mac:mac(key,'REQUEST',value)};
}
function verifyRequest(key,body,tenant,now){
  onlyKeys(body,['protocol','tenant','nonce','issuedAt','op','payload','mac']);
  const {mac:signature,...value}=body;
  deny(value.protocol===PROTOCOL&&value.tenant===tenant&&
    NONCE.test(value.nonce||'')&&OPS.has(value.op)&&
    Number.isSafeInteger(value.issuedAt)&&Math.abs(now-value.issuedAt)<=WINDOW&&
    value.payload&&typeof value.payload==='object'&&!Array.isArray(value.payload)&&
    equal(signature,mac(key,'REQUEST',value)), 'invalid signed request or timestamp');
  return value;
}
function responseFields(tenant,nonce,ok,result,errorCode){
  return {protocol:PROTOCOL,tenant,nonce,ok,result,errorCode};
}
function signResponse(key,tenant,nonce,ok,result=null,errorCode=null){
  const fields=responseFields(tenant,nonce,ok,result,errorCode);
  return {...fields,mac:mac(key,'RESPONSE',fields)};
}
function verifyResponse(key,tenant,nonce,body){
  onlyKeys(body,['protocol','tenant','nonce','ok','result','errorCode','mac']);
  const {mac:signature,...value}=body;
  deny(value.protocol===PROTOCOL&&value.tenant===tenant&&value.nonce===nonce&&
    typeof value.ok==='boolean'&&
    equal(signature,mac(key,'RESPONSE',value)), 'invalid signed response');
  return value;
}
function decodePointer(base64){
  deny(typeof base64==='string'&&base64.length>0&&base64.length<MAX&&
    /^[A-Za-z0-9+/]+={0,2}$/.test(base64), 'invalid pointer encoding');
  const buffer=Buffer.from(base64,'base64');
  deny(buffer.length>0&&buffer.length<=MAX_BODY&&
    buffer.toString('base64')===base64, 'noncanonical signed pointer encoding');
  return buffer;
}
async function dispatch(coordinator,op,payload,tenant){
  switch(op){
    case 'acquire':
      onlyKeys(payload,['holder'],['ttlMs']);
      return coordinator.acquire({tenant,...payload});
    case 'renew':
      onlyKeys(payload,['lease'],['ttlMs']);
      return coordinator.renew(payload.lease,payload.ttlMs??10000);
    case 'assert':
      onlyKeys(payload,['lease']);
      return coordinator.assertCurrent(payload.lease);
    case 'release':
      onlyKeys(payload,['lease']);
      return coordinator.release(payload.lease);
    case 'publish':{
      onlyKeys(payload,['lease','bodyBase64','operation'],['ifMatch','ifNoneMatch']);
      deny(OPID.test(payload.operation||''),'idempotent write ID required');
      const body=decodePointer(payload.bodyBase64);
      try{
        return await coordinator.publish({
          lease:payload.lease,body,operation:payload.operation,
          ifMatch:payload.ifMatch??null,ifNoneMatch:payload.ifNoneMatch===true
        });
      }finally{body.fill(0);}
    }
    case 'recover':
      onlyKeys(payload,[]);
      return coordinator.recover(tenant);
    case 'inspect':
      onlyKeys(payload,[]);
      return coordinator.inspect(tenant);
    default:throw Error('operation not allowed');
  }
}
export function createR58MtlsHandler({
  tenantId,coordinator,nonceStore,sharedKey,clientFingerprintSha256,now=()=>Date.now()
}={}){
  keyCheck(sharedKey,tenantId);
  deny(coordinator?.syntheticOnly===true&&nonceStore?.tenantId===tenantId&&
    typeof nonceStore.consume==='function'&&
    HEX.test(clientFingerprintSha256||'')&&typeof now==='function',
    'mTLS peer pin, durable nonce store and isolated coordinator required');
  return async function handler(req,res){
    const peer=req.socket.getPeerCertificate?.(true);
    const fingerprint=peer?.raw?hex(peer.raw):'';
    function reply(status,body){
      res.writeHead(status,{'content-type':'application/json','cache-control':'no-store',
        'x-content-type-options':'nosniff'});
      res.end(JSON.stringify(body));
    }
    if(req.socket.encrypted!==true||req.socket.authorized!==true||
      !equal(fingerprint,clientFingerprintSha256)){
      req.resume();return reply(401,{error:'unauthorized'});
    }
    if(req.method!=='POST'||req.url!=='/v1/r58/'+tenantId||
      req.headers['content-type']!=='application/json'){
      req.resume();return reply(404,{error:'unsupported'});
    }
    let value,nonce;
    try{
      const chunks=[];let length=0;
      for await(const part of req){
        length+=part.length;
        deny(length<=MAX,'request too large');
        chunks.push(part);
      }
      const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      value=verifyRequest(sharedKey,parsed,tenantId,now());
      nonce=value.nonce;
      // Durable monotonic uniqueness is committed BEFORE any operation.
      await nonceStore.consume(nonce);
      const result=await dispatch(coordinator,value.op,value.payload,tenantId);
      return reply(200,signResponse(sharedKey,tenantId,nonce,true,result));
    }catch(error){
      // No access to sensitive error text, credentials, query values or S3
      // responses on the HTTP wire. Authenticated faults are signed.
      if(nonce)return reply(409,
        signResponse(sharedKey,tenantId,nonce,false,null,'operation_refused'));
      return reply(401,{error:'invalid request'});
    }
  };
}
export function createR58MtlsClient({
  endpoint,tenantId,sharedKey,ca,cert,key,serverFingerprintSha256,
  now=()=>Date.now()
}={}){
  keyCheck(sharedKey,tenantId);
  deny(HEX.test(serverFingerprintSha256||'')&&
    (typeof ca==='string'||Buffer.isBuffer(ca))&&
    (typeof cert==='string'||Buffer.isBuffer(cert))&&
    (typeof key==='string'||Buffer.isBuffer(key))&&typeof now==='function',
    'trusted CA, client certificate, private key and server pin required');
  let u;try{u=new URL(endpoint);}catch{throw Error('R5.8 mTLS refused: invalid endpoint');}
  deny(u.protocol==='https:'&&u.pathname==='/'&&!u.username&&!u.password&&
    !u.search&&!u.hash,'fixed HTTPS root required');
  async function call(op,payload){
    const nonce=randomBytes(16).toString('hex');
    const signed=signR58Request(sharedKey,{
      tenant:tenantId,nonce,issuedAt:now(),op,payload
    });
    const wire=Buffer.from(JSON.stringify(signed));
    deny(wire.length<=MAX,'oversize coordinator request');
    return new Promise((resolve,reject)=>{
      const request=https.request({
        hostname:u.hostname,port:u.port,method:'POST',
        path:'/v1/r58/'+tenantId,agent:false,ca,cert,key,
        minVersion:'TLSv1.2',rejectUnauthorized:true,timeout:10000,
        maxHeaderSize:8192,checkServerIdentity(host,peer){
          const error=tls.checkServerIdentity(host,peer);
          if(error)return error;
          if(!peer.raw||!equal(hex(peer.raw),serverFingerprintSha256))
            return Error('R5.8 mTLS refused: server certificate pin mismatch');
          return undefined;
        },
        headers:{'content-type':'application/json','accept':'application/json',
          'content-length':String(wire.length)}
      },res=>{
        const chunks=[];let bytes=0;
        res.on('data',part=>{
          bytes+=part.length;
          if(bytes>MAX){
            request.destroy(Error('R5.8 mTLS refused: response too large'));
            return;
          }
          chunks.push(part);
        });
        res.on('end',()=>{
          try{
            deny([200,409].includes(res.statusCode),'unexpected HTTP status');
            const value=verifyResponse(sharedKey,tenantId,nonce,
              JSON.parse(Buffer.concat(chunks).toString('utf8')));
            deny((res.statusCode===200)===value.ok,'response status mismatch');
            if(!value.ok)throw Error('R5.8 mTLS refused: remote operation denied');
            resolve(value.result);
          }catch(e){reject(e);}
        });
        res.on('error',reject);
      });
      request.on('error',reject);
      request.on('timeout',()=>request.destroy(Error('R5.8 mTLS refused: timeout')));
      request.end(wire);
    });
  }
  return Object.freeze({
    acquire:(holder,{ttlMs=10000}={})=>call('acquire',{holder,ttlMs}),
    renew:(lease,ttlMs=10000)=>call('renew',{lease,ttlMs}),
    assertCurrent:lease=>call('assert',{lease}),
    release:lease=>call('release',{lease}),
    publish:({lease,body,ifMatch=null,ifNoneMatch=false,
      operation=randomBytes(16).toString('hex')}={})=>{
      deny(Buffer.isBuffer(body)&&body.length>0&&body.length<=MAX_BODY,
        'signed pointer buffer required');
      return call('publish',{lease,bodyBase64:body.toString('base64'),
        ifMatch,ifNoneMatch,operation});
    },
    recover:tenant=>{deny(tenant===tenantId,'cross-tenant recovery');return call('recover',{});},
    inspect:tenant=>{deny(tenant===tenantId,'cross-tenant inspect');return call('inspect',{});},
    syntheticOnly:true,productionCutoverAllowed:false,
    transport:'mtls-hmac-pinned-pg-nonce-v1'
  });
}
