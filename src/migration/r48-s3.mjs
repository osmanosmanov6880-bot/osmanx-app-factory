// R4.8: fixed-endpoint S3-compatible encrypted object transport.
// SigV4, no redirects, no arbitrary URL/key or request body from HTTP callers.
// Only opt-in synthetic use; real S3 needs independently reviewed credentials.
import {createHmac,createHash} from 'node:crypto';
import https from 'node:https';
import http from 'node:http';

const OBJ=/^(?:archives\/[a-f0-9]{32}\.oxb|catalog\/[a-f0-9]{64}\.jsonl|head\.json|r53\/head\.json|r53\/segments\/[a-f0-9]{64}\.oxd|r60\/audit\/[a-f0-9]{64}\.json)$/;
const BUCKET=/^(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const REGION=/^[a-z0-9-]{2,32}$/,ACCESS=/^[A-Z0-9]{8,40}$/;
const MAX=128*1024*1024+128;
function deny(ok,message){if(!ok)throw Error('R4.8 S3 denied: '+message);}
function hash(b){return createHash('sha256').update(b).digest('hex');}
function mac(key,value){return createHmac('sha256',key).update(value).digest();}
function isoTime(date){return date.toISOString().replace(/[:-]|\.\d{3}/g,'');}
function enc(s){return encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());}
export function signR48S3Request({method,path,query='',body=Buffer.alloc(0),host,region,
  accessKey,secretKey,sessionToken,now=new Date(),headers={}}){
  deny(Buffer.isBuffer(body)&&Number.isFinite(now.getTime()),'invalid signed request');
  const date=isoTime(now),day=date.slice(0,8);
  const fields={'host':host,'x-amz-content-sha256':hash(body),'x-amz-date':date,...headers};
  if(sessionToken)fields['x-amz-security-token']=sessionToken;
  const keys=Object.keys(fields).map(k=>k.toLowerCase()).sort();
  deny(keys.length===new Set(keys).size,'duplicate signature headers');
  const canonicalHeaders=keys.map(k=>k+':'+String(fields[k]).trim().replace(/\s+/g,' ')+'\n').join('');
  const names=keys.join(';');
  const canonical=[method,path,query,canonicalHeaders,names,hash(body)].join('\n');
  const scope=day+'/'+region+'/s3/aws4_request';
  const signedText=['AWS4-HMAC-SHA256',date,scope,hash(Buffer.from(canonical))].join('\n');
  const key=mac(mac(mac(mac(Buffer.from('AWS4'+secretKey),day),region),'s3'),'aws4_request');
  const signature=mac(key,signedText).toString('hex');key.fill(0);
  return {...fields,authorization:'AWS4-HMAC-SHA256 Credential='+accessKey+'/'+scope+
    ', SignedHeaders='+names+', Signature='+signature};
}
export function createR48S3Transport({endpoint,bucket,region,accessKey,secretKey,
  sessionToken,projectPrefix='',allowSyntheticLoopback=false}={}){
  let url;try{url=new URL(endpoint);}catch{throw Error('R4.8 S3 denied: endpoint invalid');}
  const loopback=allowSyntheticLoopback===true&&url.protocol==='http:'&&
    ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  deny((url.protocol==='https:'||loopback)&&url.pathname==='/'&&
    !url.username&&!url.password&&!url.search&&!url.hash,
    'fixed HTTPS root required; HTTP only in isolated loopback tests');
  deny(typeof bucket==='string'&&BUCKET.test(bucket)&&!bucket.includes('..')&&
    typeof region==='string'&&REGION.test(region)&&
    typeof accessKey==='string'&&ACCESS.test(accessKey)&&
    typeof secretKey==='string'&&secretKey.length>=32&&secretKey.length<=128,
    'bucket, region, and external SigV4 credentials required');
  deny(typeof projectPrefix==='string'&&
    (projectPrefix===''||/^[a-f0-9]{24}\/$/.test(projectPrefix)),
    'strict tenant object prefix required');
  if(sessionToken)deny(typeof sessionToken==='string'&&sessionToken.length<=2048,'invalid session token');
  const agent=loopback?http:https;
  function location(key){
    deny(OBJ.test(key),'unsupported object key');
    return '/'+enc(bucket)+'/'+projectPrefix+key.split('/').map(enc).join('/');
  }
  async function request(method,path,{query='',body=Buffer.alloc(0),immutable=false,ifMatch=null,ifNoneMatch=false}={}){
    deny(Buffer.isBuffer(body)&&body.length<=MAX,'body exceeds archive limit');
    deny(!ifMatch||(
      typeof ifMatch==='string'&&/^"[a-fA-F0-9-]{1,128}"$/.test(ifMatch)&&
      !immutable&&!ifNoneMatch),
      'invalid conditional ETag for S3 pointer');
    deny(!ifNoneMatch||(!immutable&&!ifMatch),
      'conflicting S3 pointer creation conditions');
    const conditions=immutable||ifNoneMatch?{'if-none-match':'*'}:
      ifMatch?{'if-match':ifMatch}:{};
    const host=url.host;
    const headers=signR48S3Request({method,path,query,body,host,region,accessKey,secretKey,
      sessionToken,headers:conditions});
    return new Promise((resolve,reject)=>{
      const request=agent.request({protocol:url.protocol,hostname:url.hostname,port:url.port,
        method,path:path+(query?'?'+query:''),headers,timeout:15000,maxHeaderSize:8192},res=>{
        const status=res.statusCode||0;
        const parts=[];let size=0;
        res.on('data',b=>{size+=b.length;if(size>MAX){request.destroy(Error('R4.8 S3 denied: oversize response'));return;}parts.push(b);});
        res.on('end',()=>resolve({status,body:Buffer.concat(parts),responseHeaders:res.headers}));
        res.on('error',reject);
      });
      request.on('timeout',()=>request.destroy(Error('R4.8 S3 denied: timeout')));
      request.on('error',reject);
      request.end(body);
    });
  }
  async function getWithMetadata(key){
    const result=await request('GET',location(key));
    deny(result.status===200,'GET status '+result.status);
    const etag=String(result.responseHeaders?.etag||'');
    deny(/^"[a-fA-F0-9-]{1,128}"$/.test(etag),
      'S3 GET missing a usable strong ETag');
    return {body:result.body,etag,
      versionId:result.responseHeaders?.['x-amz-version-id']||null};
  }
  async function get(key){
    const result=await request('GET',location(key));
    deny(result.status===200,'GET status '+result.status);
    return result.body;
  }
  async function put(key,data,{ifMatch=null,ifNoneMatch=false}={}){
    deny(Buffer.isBuffer(data)&&data.length>0&&data.length<=MAX,
      'encrypted object bytes required');
    const isImmutable=key!=='head.json'&&key!=='r53/head.json';
    deny((!ifMatch&&!ifNoneMatch)||key==='r53/head.json',
      'conditional writes only permitted for incremental CDC pointer');
    const out=await request('PUT',location(key),{
      body:data,immutable:isImmutable,ifMatch,ifNoneMatch
    });
    if(key==='r53/head.json'&&(ifMatch||ifNoneMatch)&&
      [409,412].includes(out.status))
      throw Error('R4.8 S3 denied: conditional CDC pointer compare-and-swap conflict');
    if(isImmutable&&out.status===412){
      const previous=await get(key);
      try{deny(previous.equals(data),'immutable object key reused for different content');}
      finally{previous.fill(0);}
    }else deny([200,201,204].includes(out.status),'PUT status '+out.status);
    return true;
  }
  async function assertBucketControls(){
    const [versions,lock]=await Promise.all([
      request('GET','/'+enc(bucket),{query:'versioning='}),
      request('GET','/'+enc(bucket),{query:'object-lock='})
    ]);
    deny(versions.status===200&&/<Status>\s*Enabled\s*<\/Status>/.test(versions.body.toString('utf8')),
      'S3 bucket versioning is not enabled');
    deny(lock.status===200&&
      /<ObjectLockEnabled>\s*Enabled\s*<\/ObjectLockEnabled>/.test(lock.body.toString('utf8')),
      'S3 Object Lock is not enabled');
    return {versioningEnabled:true,objectLockEnabled:true,
      providerChecksVerified:true,productionCutoverAllowed:false};
  }
  // R4.9 checks real provider responses for actual WORM retention on
  // new object versions. Merely enabling Object Lock is insufficient.
  async function inspectR49Worm(key,{minRemainingMinutes=5}={}){
    deny(Number.isSafeInteger(minRemainingMinutes)&&minRemainingMinutes>=1&&
      minRemainingMinutes<=10080,'invalid object retention minimum');
    await assertBucketControls();
    const config=await request('GET','/'+enc(bucket),{query:'object-lock='});
    const xml=config.body.toString('utf8');
    deny(config.status===200&&
      /<DefaultRetention>\s*<Mode>\s*COMPLIANCE\s*<\/Mode>[\s\S]*?<Days>\s*\d+\s*<\/Days>[\s\S]*?<\/DefaultRetention>/.test(xml),
      'default COMPLIANCE retention in days is required');
    const item=await request('HEAD',location(key));
    deny(item.status===200,'S3 HEAD encrypted object status '+item.status);
    const hdr=item.responseHeaders||{};
    const until=Date.parse(String(hdr['x-amz-object-lock-retain-until-date']||''));
    deny(String(hdr['x-amz-object-lock-mode']||'')==='COMPLIANCE'&&
      Number.isFinite(until)&&until-Date.now()>=minRemainingMinutes*60000,
      'S3 object version lacks future COMPLIANCE retention');
    deny(typeof hdr['x-amz-version-id']==='string'&&hdr['x-amz-version-id'].length>0&&
      hdr['x-amz-version-id']!=='null','S3 encrypted object lacks a version ID');
    return {objectLockVerified:true,retentionMode:'COMPLIANCE',
      retentionUntil:new Date(until).toISOString(),versionId:hdr['x-amz-version-id'],versioned:true,
      productionCutoverAllowed:false};
  }
  return Object.freeze({put,get,getWithMetadata,assertBucketControls,inspectR49Worm,transport:'s3-sigv4-v1',
    syntheticLoopbackOnly:loopback,tenantPrefix:projectPrefix});
}
