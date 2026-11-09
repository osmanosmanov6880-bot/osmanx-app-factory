// R6.0 forensic READ-ONLY S3 version investigation: never releases a fence.
// Deliberately separate from worker/coordinator IAM identities.
import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {signR48S3Request} from './r48-s3.mjs';
const TENANT=/^[a-f0-9]{24}$/,BUCKET=/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  REGION=/^[a-z0-9-]{2,32}$/,ACCESS=/^[A-Z0-9]{8,40}$/,
  VERSION=/^[a-zA-Z0-9_.-]{1,256}$/,SHA=/^[a-f0-9]{64}$/;
const HEAD='r53/head.json';
const hash=body=>createHash('sha256').update(body).digest('hex');
function deny(ok,why){if(!ok)throw Error('R6.0 forensic S3 denied: '+why);}
function tag(xml,name){
  const match=xml.match(new RegExp('<'+name+'>([^<>]{1,512})</'+name+'>'));
  return match?.[1]||null;
}
function records(xml,name){
  return [...xml.matchAll(new RegExp('<'+name+'>([\\s\\S]*?)</'+name+'>','g'))]
    .map(m=>m[1]);
}
export function createR60S3VersionForensics({
  endpoint,bucket,region,tenantId,accessKey,secretKey,
  sessionToken,allowSyntheticLoopback=false,now=()=>new Date()
}={}){
  deny(TENANT.test(tenantId||'')&&BUCKET.test(bucket||'')&&
    !bucket.includes('..')&&REGION.test(region||'')&&
    ACCESS.test(accessKey||'')&&typeof secretKey==='string'&&
    secretKey.length>=32&&secretKey.length<=128&&typeof now==='function',
    'pinned tenant, bucket, isolated reviewer role and SigV4 credentials required');
  let u;try{u=new URL(endpoint);}catch{throw Error('R6.0 forensic S3 denied: endpoint');}
  const loopback=allowSyntheticLoopback===true&&u.protocol==='http:'&&
    ['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  deny((u.protocol==='https:'||loopback)&&u.pathname==='/'&&
    !u.username&&!u.password&&!u.search&&!u.hash,
    'only pinned HTTPS or isolated loopback root');
  const agent=loopback?http:https,target=tenantId+'/'+HEAD;
  async function request(method,path,query='',cap=256*1024){
    deny((method==='GET'||method==='HEAD')&&
      (path==='/'+bucket||path==='/'+bucket+'/'+target)&&
      cap<=256*1024&&cap>=0,'immutable read-only request allowlist');
    const headers=signR48S3Request({
      method,path,query,body:Buffer.alloc(0),host:u.host,region,
      accessKey,secretKey,sessionToken,now:now()
    });
    return new Promise((resolve,reject)=>{
      const req=agent.request({
        protocol:u.protocol,hostname:u.hostname,port:u.port,
        method,path:path+(query?'?'+query:''),
        headers,timeout:10000,maxHeaderSize:8192
      },res=>{
        let size=0;const chunks=[];
        res.on('data',chunk=>{
          size+=chunk.length;
          if(size>cap){req.destroy(Error('R6.0 forensic S3 denied: response bound'));return;}
          chunks.push(chunk);
        });
        res.on('error',reject);
        res.on('end',()=>resolve({
          status:res.statusCode,body:Buffer.concat(chunks),headers:res.headers
        }));
      });
      req.on('error',reject);
      req.on('timeout',()=>req.destroy(Error('R6.0 forensic S3 denied: timeout')));
      req.end();
    });
  }
  async function inventory(){
    const prefix=encodeURIComponent(target);
    const query='max-keys=100&prefix='+prefix+'&versions=';
    const data=await request('GET','/'+bucket,query);
    deny(data.status===200,'ListObjectVersions HTTP '+data.status);
    const xml=data.body.toString('utf8');
    deny(!xml.includes('<!DOCTYPE')&&!xml.includes('<!ENTITY')&&
      !xml.includes('<![CDATA[')&&xml.length<=256*1024&&
      /<ListVersionsResult(?: [^>]*)?>/.test(xml)&&
      tag(xml,'IsTruncated')==='false',
      'incomplete or unsupported version inventory');
    const items=records(xml,'Version');
    const markers=records(xml,'DeleteMarker');
    deny(items.length+markers.length<=100,'version inventory exceeds bounded page');
    const ids=new Set(),versions=[];
    for(const item of items){
      const key=tag(item,'Key'),id=tag(item,'VersionId');
      deny(key===target&&VERSION.test(id||'')&&!ids.has(id),
        'untrusted object key, version ID or duplicated version');
      ids.add(id);
      deny(['true','false'].includes(tag(item,'IsLatest')),
        'missing S3 latest flag');
      const stamp=tag(item,'LastModified');
      deny(stamp&&Number.isFinite(Date.parse(stamp)),
        'missing S3 version timestamp');
      versions.push({versionId:id,isLatest:tag(item,'IsLatest')==='true',
        lastModified:stamp});
    }
    deny(markers.length===0,'delete marker requires independent manual investigation');
    deny(versions.filter(v=>v.isLatest).length===1,
      'cannot unambiguously identify latest object version');
    return versions;
  }
  async function inspectVersion(versionId){
    deny(VERSION.test(versionId||''),'strict version ID required');
    const query='versionId='+encodeURIComponent(versionId);
    const path='/'+bucket+'/'+target;
    const [get,head]=await Promise.all([
      request('GET',path,query,4096),request('HEAD',path,query,0)
    ]);
    deny(get.status===200&&head.status===200,
      'version-specific GET/HEAD requires access and status 200');
    const left=get.headers['x-amz-version-id'],
      right=head.headers['x-amz-version-id'];
    deny(left===versionId&&right===versionId,
      'version identity mismatch across GET and HEAD');
    deny(get.body.length>0&&get.body.length<=4096,
      'invalid signed checkpoint size');
    const hdr=head.headers||{};
    const until=Date.parse(String(hdr['x-amz-object-lock-retain-until-date']||''));
    deny(hdr['x-amz-object-lock-mode']==='COMPLIANCE'&&
      Number.isFinite(until)&&until>Date.now()+5*60000,
      'version not held by future COMPLIANCE retention');
    return {versionId,sha256:hash(get.body),length:get.body.length,
      retentionMode:'COMPLIANCE',retainedUntil:new Date(until).toISOString()};
  }
  async function investigate({pendingSha256,previousVersionId=null}={}){
    deny(SHA.test(pendingSha256||'')&&
      (previousVersionId===null||VERSION.test(previousVersionId)),
      'exact signed pending digest and previous version required');
    const items=await inventory();
    const inspected=[];
    for(const item of items)inspected.push({
      ...item,...await inspectVersion(item.versionId)
    });
    const matching=inspected.filter(x=>x.sha256===pendingSha256&&
      x.versionId!==previousVersionId);
    // A matching version does NOT authorize clearing a PG pending_op.
    return Object.freeze({
      format:'osmanx-r60-version-forensic-v1',tenantId,
      reviewedVersions:inspected,
      matchingPendingVersions:matching.map(v=>v.versionId),
      requiresManualWitnessReview:true,
      canUnquarantine:false,canAdvanceCheckpoint:false,
      syntheticOnly:true,productionCutoverAllowed:false
    });
  }
  return Object.freeze({inventory,inspectVersion,investigate,tenantId,
    readonly:true,productionCutoverAllowed:false});
}
