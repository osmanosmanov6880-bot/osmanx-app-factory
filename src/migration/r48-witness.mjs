// R4.8: independently hosted monotonic recovery witness.
// Separate host/root/secret from object storage. Rejects replay of older
// otherwise-valid remote heads. Synthetic receiver is test-only.
import {createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import {constants} from 'node:fs';
import {mkdir,open,rename,unlink,lstat,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const HEX=/^[a-f0-9]{64}$/,TENANT=/^[a-f0-9]{24}$/,ZERO='0'.repeat(64);
function deny(ok,msg){if(!ok)throw Error('R4.8 witness refused: '+msg);}
function mac(key,domain,payload){return createHmac('sha256',key).update(domain+'\0').update(payload).digest('hex');}
function eq(a,b){return typeof a==='string'&&typeof b==='string'&&HEX.test(a)&&HEX.test(b)&&
  timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function signed(key,record){return {...record,mac:mac(key,'OSMANX-R48-WITNESS-v1',JSON.stringify(record))};}
function validate(key,value,tenant){
  deny(value&&typeof value==='object'&&value.tenant===tenant&&HEX.test(value.catalogSha256)&&
    HEX.test(value.manifestSha256)&&HEX.test(value.previousHash)&&
    Number.isSafeInteger(value.entries)&&value.entries>=1&&value.entries<=2000&&
    typeof value.committedAt==='string'&&!Number.isNaN(Date.parse(value.committedAt)),
    'invalid monotonic anchor');
  const {mac:signature,...payload}=value;
  deny(eq(signature,mac(key,'OSMANX-R48-WITNESS-v1',JSON.stringify(payload))),
    'invalid witness signature');
  return payload;
}
function clientURL(endpoint,loopbackAllowed){
  let u;try{u=new URL(endpoint);}catch{throw Error('R4.8 witness refused: malformed endpoint');}
  const local=loopbackAllowed&&u.protocol==='http:'&&
    ['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  deny((u.protocol==='https:'||local)&&u.pathname==='/'&&
    !u.search&&!u.hash&&!u.username&&!u.password,'fixed HTTPS witness required');
  return {u,local};
}
export function createR48WitnessClient({endpoint,token,secret,tenant,allowSyntheticLoopback=false}={}){
  deny(typeof token==='string'&&/^[A-Za-z0-9._~-]{32,256}$/.test(token)&&
    Buffer.isBuffer(secret)&&secret.length===32&&TENANT.test(tenant||''),
    'external independent witness credentials required');
  const {u,local}=clientURL(endpoint,allowSyntheticLoopback);
  const transport=local?http:https;
  async function call(method,body){
    const bytes=body?Buffer.from(JSON.stringify(body)):undefined;
    return new Promise((resolve,reject)=>{
      const req=transport.request({protocol:u.protocol,hostname:u.hostname,port:u.port,
        method,path:'/v1/witness/'+tenant,timeout:10000,maxHeaderSize:8192,
        headers:{authorization:'Bearer '+token,'accept':'application/json',
          ...(bytes?{'content-type':'application/json','content-length':String(bytes.length)}:{})}},res=>{
        const chunks=[];let total=0;
        res.on('data',b=>{total+=b.length;if(total>8192){req.destroy(Error('R4.8 witness refused: response too large'));return;}chunks.push(b);});
        res.on('end',()=>{
          let obj;try{obj=JSON.parse(Buffer.concat(chunks).toString('utf8'));}
          catch{reject(Error('R4.8 witness refused: malformed witness response'));return;}
          resolve({status:res.statusCode,data:obj});
        });
        res.on('error',reject);
      });
      req.on('timeout',()=>req.destroy(Error('R4.8 witness refused: timed out')));
      req.on('error',reject);req.end(bytes);
    });
  }
  async function current(){
    const r=await call('GET');
    if(r.status===404)return null;
    deny(r.status===200,'read witness status '+r.status);
    return validate(secret,r.data,tenant);
  }
  async function commit({catalogSha256,manifestSha256,entries,committedAt=new Date().toISOString()}={}){
    deny(HEX.test(catalogSha256)&&HEX.test(manifestSha256)&&
      Number.isSafeInteger(entries)&&entries>0,'invalid candidate remote catalog');
    const prior=await current();
    if(prior&&prior.entries===entries&&prior.catalogSha256===catalogSha256)return prior;
    deny(!prior||entries>prior.entries,'remote catalog must advance witness sequence');
    const value=signed(secret,{tenant,catalogSha256,manifestSha256,entries,
      previousHash:prior?.catalogSha256||ZERO,committedAt});
    const reply=await call('POST',value);
    deny(reply.status===200||reply.status===201,'witness conflict '+reply.status);
    return validate(secret,reply.data,tenant);
  }
  async function verify({catalogSha256,manifestSha256,entries}={}){
    const anchor=await current();
    deny(anchor&&anchor.catalogSha256===catalogSha256&&
      anchor.manifestSha256===manifestSha256&&anchor.entries===entries,
      'remote head older than or different from independent witness');
    return {anchorVerified:true,entries:anchor.entries,committedAt:anchor.committedAt,
      catalogSha256:anchor.catalogSha256};
  }
  return Object.freeze({current,commit,verify,transport:'independent-witness-hmac-v1'});
}
export function createR48WitnessReceiver({root,token,secret}={}){
  deny(typeof root==='string'&&root.length>0&&typeof token==='string'&&token.length>=32&&
    Buffer.isBuffer(secret)&&secret.length===32,'private witness server configuration required');
  const base=resolve(root);
  async function ensure(){
    await mkdir(base,{recursive:true,mode:0o700});
    const st=await lstat(base);
    deny(st.isDirectory()&&!st.isSymbolicLink()&&
      (process.platform==='win32'||(st.mode&0o077)===0),'unsafe witness directory');
  }
  async function read(tenant){
    let f;try{f=await open(join(base,tenant+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW);}
    catch(e){if(e.code==='ENOENT')return null;throw e;}
    try{
      const st=await f.stat();deny(st.isFile()&&st.nlink===1&&st.size<=8192,'unsafe witness file');
      const parsed=JSON.parse(await f.readFile({encoding:'utf8'}));
      validate(secret,parsed,tenant);return parsed;
    }finally{await f.close();}
  }
  const send=(res,status,obj={})=>{
    res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify(obj));
  };
  async function handle(req,res){
    const m=String(req.url||'').match(/^\/v1\/witness\/([a-f0-9]{24})$/);
    const expected=Buffer.from(token),header=String(req.headers.authorization||'');
    const given=Buffer.from(header.startsWith('Bearer ')?header.slice(7):'');
    if(!m||!['GET','POST'].includes(req.method)){req.resume();return send(res,404);}
    // Only an authenticated GET may use 404 to mean "no witness yet".
    if(given.length!==expected.length||!timingSafeEqual(given,expected)){
      req.resume();return send(res,401);
    }
    const tenant=m[1];
    try{
      await ensure();
      if(req.method==='GET'){
        const prev=await read(tenant);
        return send(res,prev?200:404,prev||{});
      }
      const lock=await open(join(base,tenant+'.lock'),'wx',0o600);
      try{
        let bytes=Buffer.alloc(0);
        for await(const chunk of req){
          deny(bytes.length+chunk.length<=8192,'witness request too large');
          bytes=Buffer.concat([bytes,chunk]);
        }
        const value=JSON.parse(bytes.toString('utf8'));
        validate(secret,value,tenant);
        const prior=await read(tenant);
        if(prior){
          if(prior.entries===value.entries&&prior.catalogSha256===value.catalogSha256)
            return send(res,200,prior);
          deny(value.entries>prior.entries&&value.previousHash===prior.catalogSha256&&
            value.manifestSha256===prior.manifestSha256,'monotonic witness fork or rollback');
        }else deny(value.previousHash===ZERO,'first witness hash must be empty');
        const stage=join(base,tenant+'.'+randomBytes(8).toString('hex')+'.tmp');
        let f;try{f=await open(stage,'wx',0o600);await f.writeFile(JSON.stringify(value));await f.sync();}
        finally{await f?.close();}
        await rename(stage,join(base,tenant+'.json'));
        return send(res,201,value);
      }finally{await lock.close();await unlink(join(base,tenant+'.lock'));}
    }catch{return send(res,409,{error:'witness operation rejected'});}
  }
  return handle;
}
