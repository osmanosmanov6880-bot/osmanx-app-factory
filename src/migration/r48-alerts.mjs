// R4.8 privacy-safe durable alert queue: HMAC signed state, fixed HTTPS
// webhook and retry backoff. Does not transmit CRM rows, IDs or credentials.
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {mkdir,open,rename,unlink,readFile,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import https from 'node:https';
import http from 'node:http';
const TYPES=new Set(['BACKUP_STALE','REMOTE_UNAVAILABLE','ROLLBACK_DETECTED',
  'RESTORE_FAILED','RESTORE_SLOW','RECOVERED']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX=/^[a-f0-9]{64}$/;
function deny(ok,msg){if(!ok)throw Error('R4.8 alerts refused: '+msg);}
function sign(key,text){return createHmac('sha256',key).update('OSMANX-R48-ALERT-QUEUE-v1\0').update(text).digest('hex');}
function eq(a,b){return typeof a==='string'&&HEX.test(a)&&HEX.test(b)&&
  timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function urlConfig(endpoint,allowSyntheticLoopback){
  let u;try{u=new URL(endpoint);}catch{throw Error('R4.8 alerts refused: invalid webhook URL');}
  const local=allowSyntheticLoopback===true&&u.protocol==='http:'&&
    ['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  deny((u.protocol==='https:'||local)&&u.pathname==='/'&&
    !u.search&&!u.hash&&!u.username&&!u.password,'fixed HTTPS webhook required');
  return {u,local};
}
export function createR48AlertSender({endpoint,secret,allowSyntheticLoopback=false}={}){
  deny(Buffer.isBuffer(secret)&&secret.length===32,'independent 32-byte webhook signing key required');
  const {u,local}=urlConfig(endpoint,allowSyntheticLoopback);
  const transport=local?http:https;
  return async function sendAlert(payload){
    const bytes=Buffer.from(JSON.stringify(payload));
    deny(bytes.length<=4096&&TYPES.has(payload?.code)&&
      /^[a-f0-9]{24}$/.test(payload?.tenantToken||''),
      'unrecognized or oversized notification');
    const stamp=new Date().toISOString();
    const signature=createHmac('sha256',secret)
      .update('OSMANX-R48-WEBHOOK-v1\0').update(stamp).update('\0').update(bytes).digest('hex');
    await new Promise((resolve,reject)=>{
      const req=transport.request({protocol:u.protocol,hostname:u.hostname,port:u.port,
        path:'/v1/alerts',method:'POST',timeout:9000,maxHeaderSize:8192,
        headers:{'content-type':'application/json','content-length':String(bytes.length),
          'x-ox-alert-at':stamp,'x-ox-alert-signature':signature,'cache-control':'no-store'}},res=>{
        res.resume();
        res.on('end',()=>[200,201,202,204].includes(res.statusCode)?
          resolve():reject(Error('R4.8 alerts refused: webhook HTTP '+res.statusCode)));
        res.on('error',reject);
      });
      req.on('timeout',()=>req.destroy(Error('R4.8 alerts refused: webhook timeout')));
      req.on('error',reject);req.end(bytes);
    });
    return true;
  };
}
export function createR48AlertOutbox({directory,projectId,tenantToken,queueKey,
  sender,backoffMs=60000}={}){
  deny(typeof directory==='string'&&directory.length>0&&UUID.test(projectId||'')&&
    /^[a-f0-9]{24}$/.test(tenantToken||'')&&
    Buffer.isBuffer(queueKey)&&queueKey.length===32&&typeof sender==='function'&&
    Number.isSafeInteger(backoffMs)&&backoffMs>=0&&backoffMs<=3600000,
    'private alert outbox configuration required');
  const root=resolve(directory),file=join(root,'queue.json');
  async function setup(){
    await mkdir(root,{recursive:true,mode:0o700});
    const st=await lstat(root);
    deny(st.isDirectory()&&!st.isSymbolicLink()&&
      (process.platform==='win32'||(st.mode&0o077)===0),'unsafe outbox directory');
  }
  async function load(){
    let content;try{content=await readFile(file,'utf8');}
    catch(e){if(e.code==='ENOENT')return {generation:0,events:[]};throw e;}
    deny(Buffer.byteLength(content)<=256*1024,'outbox too large');
    let rec;try{rec=JSON.parse(content);}catch{throw Error('R4.8 alerts refused: invalid outbox');}
    const {hmac,...payload}=rec;
    deny(payload?.format==='osmanx-r48-outbox-v1'&&payload.projectId===projectId&&
      Number.isSafeInteger(payload.generation)&&payload.generation>0&&
      Array.isArray(payload.events)&&payload.events.length<=500&&
      eq(hmac,sign(queueKey,JSON.stringify(payload))),'outbox authentication failed');
    for(const x of payload.events)deny(TYPES.has(x.code)&&
      /^[a-f0-9]{24}$/.test(x.tenantToken)&&x.tenantToken===tenantToken&&
      Number.isSafeInteger(x.attempts)&&x.attempts>=0&&x.attempts<=50&&
      typeof x.id==='string'&&/^[a-f0-9]{24}$/.test(x.id)&&
      typeof x.createdAt==='string'&&Number.isFinite(Date.parse(x.createdAt))&&
      ['pending','delivered'].includes(x.state),'invalid outbox event');
    return payload;
  }
  async function save(s){
    const payload={format:'osmanx-r48-outbox-v1',projectId,
      generation:s.generation+1,events:s.events};
    const record=JSON.stringify({...payload,hmac:sign(queueKey,JSON.stringify(payload))});
    deny(Buffer.byteLength(record)<256*1024,'outbox capacity exceeded');
    const tmp=join(root,'.outbox-'+randomBytes(9).toString('hex'));
    let f;try{
      f=await open(tmp,'wx',0o600);await f.writeFile(record);await f.sync();
      await f.close();f=null;await rename(tmp,file);
    }finally{await f?.close();await unlink(tmp).catch(()=>{});}
  }
  async function locked(fn){
    await setup();
    const lock=await open(join(root,'.queue.lock'),'wx',0o600);
    try{const current=await load();return await fn(current);}
    finally{await lock.close();await unlink(join(root,'.queue.lock'));}
  }
  async function emit(code,{now=Date.now()}={}){
    deny(TYPES.has(code)&&Number.isFinite(now),'invalid alert');
    return locked(async state=>{
      const recent=state.events.find(x=>x.code===code&&x.state==='pending');
      if(recent)return {id:recent.id,deduplicated:true};
      deny(state.events.length<500,'alert queue full');
      const entry={id:randomBytes(12).toString('hex'),code,tenantToken,
        createdAt:new Date(now).toISOString(),state:'pending',attempts:0,nextAttemptAt:now};
      state.events.push(entry);await save(state);
      return {id:entry.id,queued:true};
    });
  }
  async function flush({now=Date.now(),maxEvents=20}={}){
    deny(Number.isFinite(now)&&Number.isSafeInteger(maxEvents)&&maxEvents>=1&&maxEvents<=50,
      'invalid alert flush limits');
    return locked(async state=>{
      let delivered=0,failed=0;
      for(const x of state.events.filter(x=>x.state==='pending'&&x.nextAttemptAt<=now).slice(0,maxEvents)){
        try{
          await sender({format:'osmanx-r48-alert-v1',id:x.id,code:x.code,
            tenantToken,createdAt:x.createdAt});
          x.state='delivered';delivered++;
        }catch{
          x.attempts++;x.nextAttemptAt=now+backoffMs*Math.min(32,2**Math.min(x.attempts-1,5));failed++;
        }
        await save(state);
      }
      return {delivered,failed,pending:state.events.filter(x=>x.state==='pending').length,
        privacySafe:true,productionCutoverAllowed:false};
    });
  }
  async function status(){return locked(async state=>({pending:state.events.filter(x=>x.state==='pending').length,
    delivered:state.events.filter(x=>x.state==='delivered').length,
    lastCode:state.events.at(-1)?.code||null,
    productionCutoverAllowed:false}));}
  return Object.freeze({emit,flush,status});
}
