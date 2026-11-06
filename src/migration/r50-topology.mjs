// R5.0: evidence-only network preflight for separate S3 and witness systems.
// DNS separation is NOT proof of independent providers or failure domains.
// Never turns on production cutover and never receives cloud credentials.
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
const HOST=/^(?=.{4,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/i;
function deny(ok,reason){if(!ok)throw Error('R5.0 topology refused: '+reason);}
function endpoint(value,{synthetic=false}={}){
  let url;try{url=new URL(value);}catch{throw Error('R5.0 topology refused: malformed endpoint URL');}
  const local=synthetic&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  deny((url.protocol==='https:'||local)&&!url.username&&!url.password&&
    !url.search&&!url.hash&&url.pathname==='/'&&!!url.hostname,
    'fixed HTTPS root endpoint required');
  deny(local||(!isIP(url.hostname)&&HOST.test(url.hostname)&&
    !url.hostname.endsWith('.local')&&!url.hostname.endsWith('.internal')&&
    !url.hostname.endsWith('.localhost')),
    'public FQDN required outside synthetic loopback');
  if(!local)deny(!url.port||url.port==='443','public HTTPS endpoint must use standard TLS port');
  return {url,local};
}
function publicIP(v){
  if(typeof v!=='string')return false;
  if(isIP(v)===4){
    const q=v.split('.').map(Number);
    // Deny private, loopback, link-local, multicast, CGNAT and reserved.
    return q.length===4&&q.every(x=>Number.isInteger(x)&&x>=0&&x<=255)&&
      q[0]>0&&q[0]<224&&q[0]!==10&&q[0]!==127&&q[0]!==169&&
      !(q[0]===172&&q[1]>=16&&q[1]<=31)&&
      !(q[0]===192&&(q[1]===168||q[1]===0))&&
      !(q[0]===100&&q[1]>=64&&q[1]<=127)&&
      !(q[0]===198&&(q[1]===18||q[1]===19))&&
      !(q[0]===192&&q[1]===0&&q[2]===2)&&
      !(q[0]===198&&q[1]===51&&q[2]===100)&&
      !(q[0]===203&&q[1]===0&&q[2]===113);
  }
  if(isIP(v)===6){
    const x=v.toLowerCase();
    return !/^(::|::1$|::ffff:|fc|fd|fe8|fe9|fea|feb|ff|2001:db8:)/.test(x)&&
      !x.startsWith('2001:0db8:')&&!x.startsWith('2001:db8::');
  }
  return false;
}
export async function inspectR50Topology({storageEndpoint,witnessEndpoint,alertEndpoint,
  allowSyntheticLoopback=false,resolver=dnsLookup}={}){
  deny(typeof resolver==='function','DNS resolver is required');
  const s=endpoint(storageEndpoint,{synthetic:allowSyntheticLoopback});
  const w=endpoint(witnessEndpoint,{synthetic:allowSyntheticLoopback});
  const a=alertEndpoint?endpoint(alertEndpoint,{synthetic:allowSyntheticLoopback}):null;
  deny(s.url.origin!==w.url.origin,'object storage and witness share an origin');
  if(a)deny(a.url.origin!==s.url.origin&&a.url.origin!==w.url.origin,
    'alert endpoint cannot share storage or witness origin');
  const synthetic=s.local||w.local||Boolean(a?.local);
  deny(!synthetic||allowSyntheticLoopback,
    'loopback forbidden outside explicit synthetic test mode');
  const endpoints=[s,w,...(a?[a]:[])];
  const groups=[];
  for(const e of endpoints){
    let resolved;
    try{resolved=await resolver(e.url.hostname,{all:true,verbatim:true});}
    catch{throw Error('R5.0 topology refused: DNS lookup failed');}
    deny(Array.isArray(resolved)&&resolved.length>0&&resolved.length<=32,
      'DNS lookup missing or unexpectedly large');
    const addresses=[...new Set(resolved.map(x=>x.address))];
    deny(addresses.every(x=>isIP(x)>0&&(synthetic||publicIP(x))),
      'DNS resolves to nonpublic or invalid addresses');
    groups.push(addresses);
  }
  const storage=new Set(groups[0]),witness=new Set(groups[1]);
  const addressOverlap=groups[1].some(ip=>storage.has(ip));
  deny(!addressOverlap||synthetic,'object storage and witness share DNS addresses');
  return Object.freeze({
    format:'osmanx-r50-topology-v1',
    endpointCount:endpoints.length,
    tlsRequired:!synthetic,
    dnsChecked:true,
    originSeparated:true,
    dnsAddressSeparated:!addressOverlap,
    sameHostSimulation:synthetic,
    syntheticOnly:synthetic,
    // Addresses and different public hostnames cannot establish geographic
    // failure-domain separation or independent administrative control.
    physicallyIndependentInfrastructureVerified:false,
    providerOwnershipIndependentlyVerified:false,
    dnsRebindingProtected:false,
    needsIndependentOperatorReview:true,
    productionCutoverAllowed:false
  });
}
