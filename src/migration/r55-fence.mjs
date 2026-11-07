// R5.5 independent signed publisher fencing service (synthetic only).
// A server-assigned monotonic epoch prevents expired workers from passing a
// fresh fence check. S3 HEAD writes also require provider-side conditional CAS.
// This is deliberately NOT a substitute for atomic server-mediated S3 PUT.
import {createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {constants} from 'node:fs';
import {mkdir,lstat,open,rename,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const FORMAT='osmanx-r55-fencing-v1',TENANT=/^[a-f0-9]{24}$/,
  HOLDER=/^[a-f0-9]{24}$/,NONCE=/^[a-f0-9]{32}$/,HEX=/^[a-f0-9]{64}$/;
const MAX_TTL=30000;
function deny(ok,msg){if(!ok)throw Error('R5.5 distributed fence refused: '+msg);}
function mac(key,role,object){return createHmac('sha256',key)
  .update('OSMANX-R55-FENCE-'+role+'-v1\0').update(JSON.stringify(object)).digest('hex');}
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&
  HEX.test(a)&&HEX.test(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function validateCredentials(token,secret,tenant){
  deny(typeof token==='string'&&/^[A-Za-z0-9._~-]{32,256}$/.test(token)&&
    Buffer.isBuffer(secret)&&secret.length===32&&TENANT.test(tenant||''),
    'independent token, HMAC key and opaque tenant required');
}
function signed(key,role,fields){return {...fields,mac:mac(key,role,fields)};}
function verified(key,role,value){
  deny(value&&typeof value==='object'&&!Array.isArray(value),'invalid HMAC response');
  const {mac:signature,...payload}=value;
  deny(equal(signature,mac(key,role,payload)),'HMAC mismatch or forged response');
  return payload;
}
function parseEndpoint(endpoint,allowLoopback){
  let u;try{u=new URL(endpoint);}catch{throw Error('R5.5 distributed fence refused: invalid endpoint');}
  const local=allowLoopback===true&&u.protocol==='http:'&&
    ['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  deny((u.protocol==='https:'||local)&&u.pathname==='/'&&
    !u.username&&!u.password&&!u.search&&!u.hash,
    'fixed HTTPS endpoint required outside synthetic loopback');
  return {u,local};
}
export function createR55FenceClient({
  endpoint,token,secret,tenant,allowSyntheticLoopback=false
}={}){
  validateCredentials(token,secret,tenant);
  const {u,local}=parseEndpoint(endpoint,allowSyntheticLoopback);
  const transport=local?http:https;
  async function call(op,fields){
    const nonce=randomBytes(16).toString('hex');
    const reqBody=signed(secret,'REQUEST',{format:FORMAT,tenant,op,
      nonce,...fields});
    const body=Buffer.from(JSON.stringify(reqBody));
    return new Promise((resolve,reject)=>{
      const request=transport.request({protocol:u.protocol,hostname:u.hostname,
        port:u.port,method:'POST',path:'/v1/fence/'+tenant,
        timeout:10000,maxHeaderSize:8192,headers:{
          authorization:'Bearer '+token,accept:'application/json',
          'content-type':'application/json','content-length':String(body.length)
        }},res=>{
        const chunks=[];let size=0;
        res.on('data',b=>{
          size+=b.length;
          if(size>4096){request.destroy(Error('R5.5 distributed fence refused: oversize response'));return;}
          chunks.push(b);
        });
        res.on('end',()=>{
          if(res.statusCode!==200){
            reject(Error('R5.5 distributed fence refused: authority denied '+res.statusCode));
            return;
          }
          let parsed;try{parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
          catch{reject(Error('R5.5 distributed fence refused: invalid signed reply JSON'));return;}
          try{
            const value=verified(secret,'RESPONSE',parsed);
            deny(value.format===FORMAT&&value.tenant===tenant&&
              value.op===op&&value.nonce===nonce&&value.ok===true&&
              Number.isSafeInteger(value.epoch)&&value.epoch>=1&&
              value.epoch<=1000000&&HOLDER.test(value.holder)&&
              NONCE.test(value.leaseId)&&
              Number.isSafeInteger(value.expiresAt)&&value.expiresAt>=0,
              'wrong nonce, identity or response epoch');
            resolve(value);
          }catch(e){reject(e);}
        });
        res.on('error',reject);
      });
      request.on('timeout',()=>request.destroy(Error('R5.5 distributed fence refused: timeout')));
      request.on('error',reject);
      request.end(body);
    });
  }
  const fields=value=>({holder:value.holder,epoch:value.epoch,leaseId:value.leaseId});
  function lease(value){
    return Object.freeze({holder:value.holder,epoch:value.epoch,
      leaseId:value.leaseId,expiresAt:value.expiresAt,
      syntheticOnly:true,productionCutoverAllowed:false});
  }
  async function acquire(holder,{ttlMs=10000}={}){
    deny(HOLDER.test(holder)&&Number.isSafeInteger(ttlMs)&&ttlMs>=1000&&ttlMs<=MAX_TTL,
      'invalid proposed publisher or bounded lease duration');
    return lease(await call('acquire',{holder,ttlMs}));
  }
  async function renew(value,{ttlMs=10000}={}){
    deny(Number.isSafeInteger(ttlMs)&&ttlMs>=1000&&ttlMs<=MAX_TTL,
      'invalid renewal TTL');
    return lease(await call('renew',{...fields(value),ttlMs}));
  }
  async function assertCurrent(value){
    const response=await call('assert',fields(value));
    deny(response.epoch===value.epoch&&response.holder===value.holder&&
      response.leaseId===value.leaseId&&response.expiresAt>Date.now(),
      'publisher epoch was superseded or has expired');
    return {remoteFencingVerified:true,epoch:response.epoch,
      productionCutoverAllowed:false};
  }
  async function release(value){
    const response=await call('release',fields(value));
    deny(response.epoch===value.epoch,'released wrong epoch');
    return {released:true,epoch:response.epoch,productionCutoverAllowed:false};
  }
  return Object.freeze({acquire,renew,assertCurrent,release,
    protocol:'independent-signed-fencing-v1'});
}

export function createR55FenceReceiver({
  root,token,secret,now=()=>Date.now()
}={}){
  validateCredentials(token,secret,'a'.repeat(24));
  deny(typeof root==='string'&&root.length>0&&
    typeof now==='function','private separate receiver filesystem and clock required');
  const base=resolve(root);
  async function ensure(){
    await mkdir(base,{recursive:true,mode:0o700});
    const st=await lstat(base);
    deny(st.isDirectory()&&!st.isSymbolicLink()&&
      (process.platform==='win32'||(st.mode&0o077)===0),
      'private fencing authority directory must be 0700');
  }
  async function read(tenant){
    let fd;
    try{fd=await open(join(base,tenant+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW);}
    catch(e){if(e.code==='ENOENT')return null;throw e;}
    try{
      const st=await fd.stat();deny(st.isFile()&&st.nlink===1&&st.size<=2048&&
        (process.platform==='win32'||(st.mode&0o077)===0),'unsafe fencing state');
      const saved=JSON.parse(await fd.readFile({encoding:'utf8'}));
      const value=verified(secret,'STATE',saved);
      deny(value.format===FORMAT&&value.tenant===tenant&&
        Number.isSafeInteger(value.epoch)&&value.epoch>=1&&value.epoch<=1000000&&
        HOLDER.test(value.holder)&&NONCE.test(value.leaseId)&&
        Number.isSafeInteger(value.expiresAt)&&value.expiresAt>=0,
        'corrupt persisted fencing authority epoch');
      return value;
    }finally{await fd.close();}
  }
  async function persist(tenant,value){
    const stage=join(base,tenant+'.'+randomBytes(8).toString('hex')+'.tmp');
    let fd;try{
      fd=await open(stage,constants.O_EXCL|constants.O_CREAT|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      await fd.writeFile(JSON.stringify(signed(secret,'STATE',value))+'\n');
      await fd.sync();await fd.close();fd=null;
      await rename(stage,join(base,tenant+'.json'));
      const directory=await open(base,constants.O_RDONLY);
      try{await directory.sync();}finally{await directory.close();}
    }finally{await fd?.close();await unlink(stage).catch(()=>{});}
  }
  function send(res,status,payload){
    res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify(payload||{}));
  }
  return async function handler(req,res){
    const match=String(req.url||'').match(/^\/v1\/fence\/([a-f0-9]{24})$/);
    const raw=String(req.headers.authorization||'');
    const supplied=Buffer.from(raw.startsWith('Bearer ')?raw.slice(7):'');
    const expected=Buffer.from(token);
    if(!match||req.method!=='POST'){req.resume();return send(res,404);}
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){
      req.resume();return send(res,401);
    }
    const tenant=match[1];
    try{
      await ensure();
      let bytes=Buffer.alloc(0);
      for await(const chunk of req){
        deny(bytes.length+chunk.length<=4096,'fencing request too large');
        bytes=Buffer.concat([bytes,chunk]);
      }
      const value=verified(secret,'REQUEST',JSON.parse(bytes.toString('utf8')));
      deny(value.format===FORMAT&&value.tenant===tenant&&
        ['acquire','renew','assert','release'].includes(value.op)&&
        NONCE.test(value.nonce)&&HOLDER.test(value.holder),
        'invalid signed operation and sender');
      const lock=join(base,tenant+'.lock');
      const guard=await open(lock,'wx',0o600);
      let published;
      try{
        const previous=await read(tenant);
        const current=now();
        deny(Number.isSafeInteger(current)&&current>0,'receiver clock unavailable');
        if(value.op==='acquire'){
          deny(Number.isSafeInteger(value.ttlMs)&&
            value.ttlMs>=1000&&value.ttlMs<=MAX_TTL,'invalid lease TTL');
          deny(!previous||current>=previous.expiresAt,
            'another publisher still owns the lease');
          const epoch=(previous?.epoch||0)+1;
          deny(epoch<=1000000,'monotonic epoch exhausted');
          published={format:FORMAT,tenant,epoch,holder:value.holder,
            leaseId:randomBytes(16).toString('hex'),
            expiresAt:current+value.ttlMs};
          await persist(tenant,published);
        }else{
          deny(previous&&Number.isSafeInteger(value.epoch)&&
            NONCE.test(value.leaseId)&&
            previous.epoch===value.epoch&&
            previous.holder===value.holder&&
            previous.leaseId===value.leaseId&&current<previous.expiresAt,
            'stale, expired or altered publisher generation');
          if(value.op==='renew'){
            deny(Number.isSafeInteger(value.ttlMs)&&value.ttlMs>=1000&&
              value.ttlMs<=MAX_TTL,'invalid renewal TTL');
            published={...previous,expiresAt:current+value.ttlMs};
            await persist(tenant,published);
          }else if(value.op==='release'){
            published={...previous,expiresAt:0};
            await persist(tenant,published);
          }else published=previous;
        }
      }finally{await guard.close();await unlink(lock).catch(()=>{});}
      return send(res,200,signed(secret,'RESPONSE',{
        format:FORMAT,tenant,op:value.op,nonce:value.nonce,ok:true,
        epoch:published.epoch,holder:published.holder,
        leaseId:published.leaseId,expiresAt:published.expiresAt
      }));
    }catch{return send(res,409,{error:'fenced authority denied'});}
  };
}
