import {resolve4 as dns4} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import {readFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

export function isAllowedPublicV4(ip){
 if(isIP(ip)!==4)return false;
 const [a,b,c]=ip.split('.').map(Number);
 if(a===0||a===10||a===127||a>=224)return false;
 if(a===100&&b>=64&&b<=127)return false;
 if(a===169&&b===254)return false;
 if(a===172&&b>=16&&b<=31)return false;
 if(a===192&&(b===0||b===2||b===168||(b===88&&c===99)))return false;
 if(a===198&&(b===18||b===19||b===51&&c===100))return false;
 if(a===203&&b===0&&c===113)return false;
 return true;
}

/** Public/global-unicast IPv6 only. Never probe loopback, ULA, link-local,
 * multicast, mapped IPv4 or documentation prefixes. */
export function isAllowedPublicV6(ip) {
 if(isIP(ip)!==6)return false;
 const groups=ip.toLowerCase().split(':');
 const first=Number.parseInt(groups[0],16),second=Number.parseInt(groups[1]||'0',16);
 return Number.isInteger(first) && first>=0x2000 && first<=0x3fff &&
   !(first===0x2001 && [0,0x0db8].includes(second));
}
/** HTTPS probes pin the DNS-resolved PUBLIC address for the TCP connection.
 * Certificate SNI and hostname validation retain the original domain.
 * No redirects, credentials, cookies, or customer data are sent. */
export async function verifyPublicHttps(domain,{resolveA=dns4,request=httpsRequest,timeoutMs=6500,expected=null,pinnedIp=null}={}){
 if(typeof domain!=='string'||domain.length>253||!/^[a-z0-9.-]+$/.test(domain)||
    !domain.includes('.')||domain.split('.').some(label=>label.length<1||label.length>63||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))throw Error('Invalid domain');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<500||timeoutMs>30000)throw Error('Invalid HTTPS timeout');
 if(expected && (!['osmanx-business-crm','osmanx-website'].includes(expected.service) ||
     typeof expected.projectId!=='string' || !/^[a-f0-9-]{36}$/i.test(expected.projectId) ||
     !Number.isSafeInteger(expected.releaseSequence) || expected.releaseSequence<0))
   throw Error('Invalid expected deployment identity');
 let ips;
 if(pinnedIp!==null){
   if(!isAllowedPublicV4(pinnedIp)&&!isAllowedPublicV6(pinnedIp))
     throw Error('Refusing HTTPS check: pinned IP is not public');
   ips=[pinnedIp];
 }else{
   let dnsTimer;
   try{ips=await Promise.race([
      Promise.resolve().then(()=>resolveA(domain)),
      new Promise((_,reject)=>{dnsTimer=setTimeout(()=>reject(Object.assign(Error('DNS timeout'),{code:'ETIMEOUT'})),Math.min(timeoutMs,5000))})
   ])}catch(e){throw Error('Public DNS lookup failed: '+(e.code||'lookup error'))}
   finally{clearTimeout(dnsTimer)}
   if(!Array.isArray(ips)||!ips.length)throw Error('No public IPv4 A record: live check needs an A record');
   if(ips.some(ip=>!isAllowedPublicV4(ip)))throw Error('Refusing HTTPS check: DNS has private, reserved or invalid IPv4');
 }
 const pinned=ips[0],pinnedFamily=isIP(pinned);
 return await new Promise((ok,fail)=>{
  let settled=false;let timer;
  const done=(e,v)=>{if(settled)return;settled=true;clearTimeout(timer);e?fail(e):ok(v)};
  let req;
  try{
   req=request({hostname:domain,servername:domain,port:443,method:'GET',path:'/api/health',
     rejectUnauthorized:true,headers:{Accept:'application/json','Accept-Encoding':'identity'},agent:false,
     lookup:(_name,_options,cb)=>cb(null,pinned,pinnedFamily)},res=>{
     let size=0;const chunks=[];
     res.on('data',chunk=>{
       size+=chunk.length;
       if(size>8192){req.destroy(Error('HTTPS health response too large'));return}
       chunks.push(chunk);
     });
     res.on('error',done);
     res.on('end',()=>{
       if(res.statusCode!==200)return done(Error('HTTPS health returned '+res.statusCode));
       if(!String(res.headers?.['content-type']||'').includes('application/json'))return done(Error('Health response is not JSON'));
       let payload;try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return done(Error('Health response is invalid JSON'))}
       if(payload?.ok!==true)return done(Error('Health response does not report ok=true'));
       if(expected) {
         if(payload.service!==expected.service ||
            payload.deployment?.projectId!==expected.projectId ||
            payload.deployment?.releaseSequence!==expected.releaseSequence)
           return done(Error('HTTPS endpoint does not match expected application, project and release'));
       }
       done(null,{ok:true,domain,ip:pinned,httpsVerified:true,sslCertificateValidated:true,status:200,
         identityVerified:!!expected,releaseSequence:expected?.releaseSequence??null});
     });
   });
   timer=setTimeout(()=>req.destroy(Error('HTTPS check timed out')),timeoutMs);
   req.setTimeout(timeoutMs,()=>req.destroy(Error('HTTPS check timed out')));
   req.on('error',done);req.end();
  }catch(error){done(error)}
 });
}

const main=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(main){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 if(process.argv[2]!=='--live'){
  console.error('Explicit consent required: node deploy/verify-live.mjs --live');process.exitCode=1;
 }else{
  Promise.all([readFile(join(root,'deploy/manifest.json'),'utf8').then(JSON.parse),
    readFile(join(root,'manifest.json'),'utf8').then(JSON.parse)])
   .then(([meta,app])=>{
      if(meta.projectId!==app.projectId)throw Error('Local deployment identity mismatch');
      const service=app.format==='osmanx-standalone-site'?'osmanx-website':'osmanx-business-crm';
      return verifyPublicHttps(meta.domain,{expected:{service,projectId:app.projectId,releaseSequence:app.release?.sequence}});
   })
   .then(output=>console.log(JSON.stringify(output,null,2)))
   .catch(e=>{console.error('HTTPS verification failed: '+e.message);process.exitCode=1});
 }
}
