// R4.7 receiver for a SEPARATELY HOSTED HTTPS object service.
// Synthetic test servers use loopback HTTP. Encrypted data only; no SQLite
// content, remote key custody, cookie auth or bearer tokens are logged.
import {createHash,timingSafeEqual,randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,link,rename,unlink,lstat,readFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
const ROUTE=/^\/v1\/objects\/([a-f0-9]{24})\/(archives\/[a-f0-9]{32}\.oxb|catalog\/[a-f0-9]{64}\.jsonl|head\.json)$/;
const MAX=128*1024*1024+128;
function sha(x){return createHash('sha256').update(x).digest('hex');}
function validBearer(given,expected){
  if(typeof given!=='string'||!given.startsWith('Bearer '))return false;
  const a=Buffer.from(given.slice(7)),b=Buffer.from(expected);
  return a.length===b.length&&timingSafeEqual(a,b);
}
function maxBytes(key){return key==='head.json'?4096:key.startsWith('catalog/')?8*1024*1024:MAX;}
async function ensureDir(dir){
  await mkdir(dir,{recursive:true,mode:0o700});
  const s=await lstat(dir);
  if(!s.isDirectory()||s.isSymbolicLink()||(process.platform!=='win32'&&(s.mode&0o077)!==0))
    throw Error('unsafe remote storage directory');
}
async function safeRead(file,limit){
  const f=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const s=await f.stat();
    if(!s.isFile()||s.nlink!==1||s.size>limit||
      (process.platform!=='win32'&&(s.mode&0o077)!==0))throw Error('unsafe remote object');
    return f.readFile();
  }finally{await f.close();}
}
async function store(file,body,mutable){
  const folder=dirname(file);await ensureDir(folder);
  const staging=join(folder,'.staged-'+randomBytes(12).toString('hex'));
  let f,staged=false;
  try{
    f=await open(staging,'wx',0o600);staged=true;
    await f.writeFile(body);await f.sync();await f.close();f=null;
    if(mutable){
      await rename(staging,file);staged=false;
    }else{
      try{await link(staging,file);}
      catch(e){
        if(e.code!=='EEXIST')throw e;
        const current=await safeRead(file,body.length);
        if(!current.equals(body))return false;
      }
    }
    return true;
  }finally{await f?.close();if(staged)await unlink(staging).catch(()=>{});}
}
async function readBody(req,limit){
  const len=Number(req.headers['content-length']);
  if(!Number.isSafeInteger(len)||len<1||len>limit)throw Error('invalid content length');
  const parts=[];let n=0;
  for await(const chunk of req){
    n+=chunk.length;if(n>limit)throw Error('object exceeded bounded limit');
    parts.push(chunk);
  }
  if(n!==len)throw Error('short object body');
  return Buffer.concat(parts);
}
export function createR47ObjectReceiver({root,token}={}){
  if(typeof root!=='string'||!root||
    typeof token!=='string'||token.length<32||token.length>256)
    throw Error('R4.7 receiver requires a private root and external token');
  const directory=resolve(root);
  return async(req,res)=>{
    const send=(status,data=Buffer.alloc(0))=>{
      res.writeHead(status,{'content-type':'application/octet-stream',
        'cache-control':'no-store','x-content-sha256':sha(data)});
      res.end(data);
    };
    if(!validBearer(req.headers.authorization,token)){req.resume();return send(401);}
    const match=String(req.url||'').match(ROUTE);
    if(!match||!['PUT','GET'].includes(req.method)){req.resume();return send(404);}
    const [tenant,key]=match.slice(1),path=join(directory,tenant,key),limit=maxBytes(key);
    try{
      await ensureDir(directory);
      await ensureDir(join(directory,tenant));
      if(req.method==='PUT'){
        const body=await readBody(req,limit);
        if(!/^[a-f0-9]{64}$/.test(String(req.headers['x-content-sha256']))||
          sha(body)!==req.headers['x-content-sha256'])return send(422);
        if(key.startsWith('catalog/')){
          if(sha(body)!==key.slice(8,-6))return send(422);
        }
        const accepted=await store(path,body,key==='head.json');
        return send(accepted?201:409);
      }
      let body;
      try{body=await safeRead(path,limit);}
      catch(e){if(e.code==='ENOENT')return send(404);throw e;}
      return send(200,body);
    }catch{req.resume();return send(503);}
  };
}
