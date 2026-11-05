/** R3.7 public edge acceptance: explicit opt-in only. Each A/AAAA target is
 * independently pinned to the TCP connection; TLS SNI and /api/health identify
 * the exact project/release. We never use hostnames or IPs provided by clients.
 * A DNS-only audit NEVER makes outbound HTTP connections. */
import {resolve4,resolve6} from 'node:dns/promises';
import {readFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyPublicHttps,isAllowedPublicV4,isAllowedPublicV6} from './verify-live.mjs';

const absent = error => ['ENODATA','ENOTFOUND','NXDOMAIN'].includes(error?.code);
const limit=8;
function validIdentity(expected){
  return expected && ['osmanx-business-crm','osmanx-website'].includes(expected.service) &&
   /^[0-9a-f-]{36}$/i.test(expected.projectId||'') &&
   Number.isSafeInteger(expected.releaseSequence) && expected.releaseSequence>=0;
}
function normalizeError(e){
  // No diagnostic output should contain the remote HTTP response/body or secret env.
  const message=String(e?.message||'connection failed');
  if(/does not match expected application/.test(message))return 'WRONG_DEPLOYMENT_IDENTITY';
  if(/certificate|tls|ssl|self.signed|hostname/i.test(message))return 'TLS_CERTIFICATE_ERROR';
  if(/timed out|timeout/i.test(message))return 'CONNECT_TIMEOUT';
  if(/health returned/.test(message))return 'UNEXPECTED_HTTP_STATUS';
  return 'HTTPS_CONNECTION_FAILED';
}
async function queryOne(fn,domain,timeoutMs){
  let timer;
  try{return await Promise.race([
    Promise.resolve().then(()=>fn(domain)),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('DNS timed out'),{code:'ETIMEOUT'})),timeoutMs)})
  ]);}finally{clearTimeout(timer)}
}
export async function auditPublicEdge(domain,{expected,live=false,resolveA=resolve4,resolveAAAA=resolve6,
    probe=verifyPublicHttps,timeoutMs=6500}={}){
  if(typeof domain!=='string'||domain.length>253||!/^[a-z0-9.-]+$/.test(domain)||
    domain.split('.').length<2||domain.split('.').some(label=>label.length<1||label.length>63||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))throw Error('Invalid public domain');
  if(!validIdentity(expected))throw Error('Expected project and release are required');
  if(typeof live!=='boolean'||!Number.isSafeInteger(timeoutMs)||timeoutMs<500||timeoutMs>30000)
    throw Error('Invalid opt-in edge parameters');
  const answers=await Promise.allSettled([queryOne(resolveA,domain,Math.min(timeoutMs,5000)),
    queryOne(resolveAAAA,domain,Math.min(timeoutMs,5000))]);
  const addresses=[];
  for(let i=0;i<2;i++){
    const kind=i?'AAAA':'A',ans=answers[i];
    if(ans.status==='rejected'){
      if(absent(ans.reason))continue;
      throw Error('DNS '+kind+' lookup failed: '+String(ans.reason?.code||'ERROR'));
    }
    if(!Array.isArray(ans.value)||ans.value.length>limit)throw Error('Unbounded DNS '+kind+' answer');
    for(const ip of ans.value){
      if(!(i?isAllowedPublicV6(ip):isAllowedPublicV4(ip)))
        throw Error('DNS includes a non-public '+kind+' address; refusing connections');
      if(!addresses.some(x=>x.ip===ip))addresses.push({ip,family:i?6:4});
    }
  }
  if(addresses.length===0)throw Error('No public A/AAAA addresses');
  if(addresses.length>limit)throw Error('Too many edge addresses; cannot verify every target');
  const endpoints=[];
  for(const address of addresses){
    if(!live){endpoints.push({...address,ok:null,errorCode:null});continue}
    try{
      const result=await probe(domain,{pinnedIp:address.ip,expected,timeoutMs});
      if(result?.httpsVerified!==true||result?.sslCertificateValidated!==true||result?.identityVerified!==true)
        throw Error('HTTPS probe did not confirm expected identity');
      endpoints.push({...address,ok:true,errorCode:null});
    }catch(e){endpoints.push({...address,ok:false,errorCode:normalizeError(e)})}
  }
  return {format:'osmanx-public-edge-audit',version:1,domain,projectId:expected.projectId,
    releaseSequence:expected.releaseSequence,service:expected.service,
    dnsChecked:true,liveHttpsChecked:live,targets:addresses.length,
    verified:live?endpoints.filter(x=>x.ok).length:0,
    ready:live && endpoints.every(x=>x.ok===true),endpoints,
    warning:live?null:'DNS only. No HTTPS requests were made; not ready for public acceptance.'};
}
export async function auditInstalledEdge(root,{live=false,...deps}={}){
  root=resolve(root);
  const [deploy,app]=await Promise.all([
    readFile(join(root,'deploy/manifest.json'),'utf8').then(JSON.parse),
    readFile(join(root,'manifest.json'),'utf8').then(JSON.parse)]);
  if(deploy.projectId!==app.projectId)throw Error('Installed project identity mismatch');
  const service=app.format==='osmanx-standalone-site'?'osmanx-website':
    app.format==='osmanx-standalone-release'?'osmanx-business-crm':null;
  if(!service)throw Error('Unsupported installed application format');
  return auditPublicEdge(deploy.domain,{expected:{service,projectId:app.projectId,
    releaseSequence:app.release?.sequence},live,...deps});
}
const main=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(main){
 const args=process.argv.slice(2);
 const root=resolve(args.find(x=>x.startsWith('--installed='))?.slice(12)||dirname(dirname(fileURLToPath(import.meta.url))));
 if(!args.includes('--dns-only')&&!args.includes('--live')){
   console.error('Usage: node deploy/edge-audit.mjs --dns-only | --live [--installed=/absolute/path]');
   process.exitCode=2;
 }else auditInstalledEdge(root,{live:args.includes('--live')}).then(r=>{
   console.log(JSON.stringify(r,null,2));
   if(args.includes('--live')&&!r.ready)process.exitCode=1;
 }).catch(e=>{console.error('OSMANX EDGE AUDIT: '+e.message);process.exitCode=1});
}
