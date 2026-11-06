// R4.7: fixed-endpoint HTTPS object transport for encrypted-only archives.
// No redirects, cookies, dynamic hosts or caller-specified URLs. The loopback
// HTTP exception is exclusively for isolated synthetic integration tests.
import http from 'node:http';
import https from 'node:https';
import {createHash} from 'node:crypto';
const KEY=/^(?:archives\/[a-f0-9]{32}\.oxb|catalog\/[a-f0-9]{64}\.jsonl|head\.json)$/;
const TOKEN=/^[A-Za-z0-9._~+/-]{32,256}$/;
const HEX=/^[a-f0-9]{64}$/;
const MAX=128*1024*1024+128;
function check(ok,message){if(!ok)throw Error('R4.7 remote object refused: '+message);}
function sha(data){return createHash('sha256').update(data).digest('hex');}
export function createR47Transport({endpoint,token,tenantToken,allowLoopbackHttp=false}={}){
  check(typeof endpoint==='string'&&endpoint.length>0,'remote endpoint missing');
  let url;try{url=new URL(endpoint);}catch{throw Error('R4.7 remote object refused: invalid remote URL');}
  const loopback=allowLoopbackHttp===true&&url.protocol==='http:'&&
    (url.hostname==='127.0.0.1'||url.hostname==='localhost'||url.hostname==='[::1]');
  check((url.protocol==='https:'||loopback)&&!url.username&&!url.password&&!url.search&&
    !url.hash&&url.pathname==='/'&&!url.hostname.endsWith('.invalid'),
    'HTTPS fixed root endpoint required (loopback only in synthetic tests)');
  check(typeof token==='string'&&TOKEN.test(token),'external bearer token must be 32-256 safe characters');
  check(typeof tenantToken==='string'&&/^[a-f0-9]{24}$/.test(tenantToken),'opaque tenant token required');
  const agent=url.protocol==='https:'?https:http;
  async function requestObject(method,key,body){
    check(typeof key==='string'&&KEY.test(key),'unsupported remote object key');
    if(body!==undefined)check(Buffer.isBuffer(body)&&body.length<=MAX,'bounded encrypted blob required');
    const path='/v1/objects/'+tenantToken+'/'+key;
    return new Promise((resolve,reject)=>{
      const headers={
        'authorization':'Bearer '+token,'accept':'application/octet-stream',
        'cache-control':'no-store','x-ox-r47-version':'1'
      };
      if(body!==undefined){
        headers['content-type']='application/octet-stream';
        headers['content-length']=String(body.length);
        headers['x-content-sha256']=sha(body);
      }
      const req=agent.request({protocol:url.protocol,hostname:url.hostname,port:url.port,
        method,path,headers,timeout:12000,maxHeaderSize:8192},res=>{
        const status=res.statusCode||0;
        if(![200,201,204].includes(status)){
          res.resume();reject(Error('R4.7 remote object refused: remote HTTP '+status));return;
        }
        const chunks=[];let total=0,failed=false;
        res.on('data',part=>{
          total+=part.length;
          if(total>MAX){failed=true;req.destroy(Error('R4.7 remote object refused: response too large'));return;}
          chunks.push(part);
        });
        res.on('end',()=>{
          if(failed)return;
          const result=Buffer.concat(chunks);
          if(method==='GET'&&res.headers['x-content-sha256']&&
             (!HEX.test(String(res.headers['x-content-sha256']))||
              sha(result)!==res.headers['x-content-sha256'])){
            reject(Error('R4.7 remote object refused: response digest mismatch'));return;
          }
          resolve(result);
        });
        res.on('error',reject);
      });
      req.on('timeout',()=>req.destroy(Error('R4.7 remote object refused: request timed out')));
      req.on('error',reject);
      req.end(body);
    });
  }
  return Object.freeze({
    put:async(key,encryptedBytes)=>{await requestObject('PUT',key,encryptedBytes);return true;},
    get:key=>requestObject('GET',key),
    transport:'fixed-host-https-v1',
    loopbackTestOnly:loopback,
  });
}
