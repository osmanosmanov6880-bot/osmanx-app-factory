// R6.5: dual independent S3-compatible WORM-process laboratory custody.
// Uses the existing HTTPS/SigV4 allowlisted transport. Distinct endpoints,
// buckets, users and verified COMPLIANCE versions are mandatory.
// This is not independent geographic/cloud-provider disaster protection.
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createR48S3Transport} from './r48-s3.mjs';
import {scanR64LocalWalArchive} from './r64-wal-archive-evidence.mjs';
const TENANT=/^[a-f0-9]{24}$/,WAL=/^[0-9A-F]{24}$/,
  HASH=/^[a-f0-9]{64}$/,ID=/^[a-z][a-z0-9-]{2,24}$/,
  VERSION=/^[A-Za-z0-9_.-]{1,256}$/;
const SEGMENT_BYTES=16*1024*1024;
function deny(ok,why){if(!ok)throw Error('R6.5 dual WORM WAL refused: '+why);}
const sha=b=>createHash('sha256').update(b).digest('hex');
function records(rows){
  deny(Array.isArray(rows)&&rows.length>=1&&rows.length<=24,
    'bounded WAL manifest required');
  const seen=new Set();
  return rows.map(x=>{
    deny(x&&WAL.test(x.name||'')&&HASH.test(x.sha256||'')&&
      x.size===SEGMENT_BYTES&&!seen.has(x.name),
      'invalid segment name, digest, size or duplicate');
    seen.add(x.name);
    return {name:x.name,sha256:x.sha256,size:x.size};
  }).sort((a,b)=>a.name.localeCompare(b.name));
}
function match(a,b){
  return JSON.stringify(records(a))===JSON.stringify(records(b));
}
function validateReceipt(x,tenantId){
  deny(x&&x.tenantId===tenantId&&ID.test(x.storeId||'')&&
    WAL.test(x.name||'')&&HASH.test(x.sha256||'')&&
    x.size===SEGMENT_BYTES&&VERSION.test(x.versionId||'')&&
    x.retentionMode==='COMPLIANCE'&&
    Number.isFinite(Date.parse(x.retainedUntil||''))&&
    /^"[0-9a-fA-F-]{1,128}"$/.test(x.etag||''),
    'malformed or untrusted custody receipt');
  return x;
}
export function createR65DualWormCustody({
  tenantId,stores,allowSyntheticLoopback=false
}={}){
  deny(TENANT.test(tenantId||'')&&Array.isArray(stores)&&
    stores.length===2,'exact tenant and two isolated S3 stores required');
  const ids=new Set(),origins=new Set(),credentials=new Set();
  const clients=stores.map(s=>{
    deny(ID.test(s?.storeId||'')&&!ids.has(s.storeId)&&
      typeof s.endpoint==='string'&&
      typeof s.bucket==='string'&&typeof s.accessKey==='string'&&
      !credentials.has(s.accessKey),
      'distinct store ID and SigV4 key required');
    const u=new URL(s.endpoint);
    deny(!origins.has(u.origin)&&!origins.has(u.hostname+u.port),
      'separate S3 server endpoints are mandatory');
    ids.add(s.storeId);origins.add(u.origin);
    credentials.add(s.accessKey);
    return {storeId:s.storeId,transport:createR48S3Transport({
      ...s,projectPrefix:tenantId+'/',allowSyntheticLoopback
    })};
  });
  async function verifyObject(client,entry,receipt){
    const key='r65/wal/'+entry.sha256+'.seg';
    const [body,retention]=await Promise.all([
      client.transport.getWithMetadata(key),
      client.transport.inspectR49Worm(key,{minRemainingMinutes:5})
    ]);
    deny(body.body.length===SEGMENT_BYTES&&
      sha(body.body)===entry.sha256&&
      body.versionId===retention.versionId&&
      body.versionId===receipt?.versionId&&
      body.etag===receipt?.etag&&
      retention.retentionMode==='COMPLIANCE'&&
      retention.versioned===true&&
      retention.objectLockVerified===true&&
      retention.retentionUntil===receipt?.retainedUntil,
      'tampered, newer, truncated or unretained S3 WAL object');
    return body.body;
  }
  async function assertBoth(){
    const status=await Promise.all(clients.map(async x=>({
      storeId:x.storeId,
      ...await x.transport.assertBucketControls()
    })));
    deny(status.length===2&&status.every(x=>
      x.versioningEnabled&&x.objectLockEnabled),
      'two independent versioned WORM buckets required');
    return Object.freeze({bothObjectLockEnabled:true,
      independentProcessEndpoints:2,realCloudIsolationCertified:false,
      productionCutoverAllowed:false});
  }
  async function uploadArchive({directory,inventory}={}){
    deny(typeof directory==='string'&&directory.startsWith('/')&&
      directory.length<1024,'fixed isolated source directory required');
    const expected=records(inventory);
    const reread=await scanR64LocalWalArchive({
      directory,segmentBytes:SEGMENT_BYTES
    });
    deny(match(expected,reread),'source WAL changed before S3 upload');
    await assertBoth();
    const receipts=[];
    for(const item of expected){
      const path=join(directory,item.name);
      const stat=await lstat(path);
      deny(stat.isFile()&&!stat.isSymbolicLink()&&
        stat.size===SEGMENT_BYTES,'source WAL file replaced before upload');
      const data=await readFile(path);
      deny(data.length===SEGMENT_BYTES&&sha(data)===item.sha256,
        'source WAL bytes changed after inspection');
      try{
        for(const client of clients){
          const key='r65/wal/'+item.sha256+'.seg';
          await client.transport.put(key,data);
          const current=await client.transport.getWithMetadata(key);
          const worm=await client.transport.inspectR49Worm(key);
          deny(current.body.length===data.length&&
            current.body.equals(data)&&current.versionId&&
            current.versionId===worm.versionId&&worm.objectLockVerified,
            'uploaded S3 version does not match original WAL');
          receipts.push(Object.freeze({
            format:'osmanx-r65-wal-object-receipt-v1',
            tenantId,storeId:client.storeId,name:item.name,
            sha256:item.sha256,size:item.size,
            versionId:current.versionId,etag:current.etag,
            retentionMode:worm.retentionMode,
            retainedUntil:worm.retentionUntil
          }));
          current.body.fill(0);
        }
      }finally{data.fill(0);}
    }
    return Object.freeze(receipts);
  }
  async function downloadVerified({inventory,receipts}={}){
    const entries=records(inventory);
    deny(Array.isArray(receipts)&&receipts.length===entries.length*2,
      'both custody receipts per WAL segment required');
    await assertBoth();
    const got=[];
    for(const entry of entries){
      const versions=[];
      for(const client of clients){
        const matches=receipts.filter(x=>x.name===entry.name&&
          x.storeId===client.storeId);
        deny(matches.length===1,'missing or duplicate independent WORM receipt');
        const receipt=validateReceipt(matches[0],tenantId);
        deny(receipt.sha256===entry.sha256,'receipt digest does not match WAL inventory');
        const buf=await verifyObject(client,entry,receipt);
        versions.push(buf);
      }
      deny(versions[0].equals(versions[1]),
        'independent S3 providers returned different WAL bytes');
      versions[1].fill(0);
      got.push({name:entry.name,body:versions[0]});
    }
    return got;
  }
  async function restoreToFreshDirectory({
    directory,inventory,receipts
  }={}){
    deny(typeof directory==='string'&&directory.startsWith('/')&&
      directory.length<1024,'fixed fresh restore directory required');
    const data=await downloadVerified({inventory,receipts});
    await mkdir(directory,{mode:0o700,recursive:false});
    try{
      for(const file of data)
        await writeFile(join(directory,file.name),file.body,{
          flag:'wx',mode:0o600
        });
      const inspected=await scanR64LocalWalArchive({
        directory,segmentBytes:SEGMENT_BYTES
      });
      deny(match(inspected,inventory),'restored archive differs from signed source');
      return Object.freeze({
        format:'osmanx-r65-detached-archive-rebuild-v1',
        tenantId,restoredSegments:inspected.length,
        bothWormCopiesReread:true,
        localSourceArchiveNotRequired:true,
        productionCutoverAllowed:false
      });
    }finally{for(const file of data)file.body.fill(0);}
  }
  return Object.freeze({
    assertBoth,uploadArchive,downloadVerified,restoreToFreshDirectory,
    tenantId,storeIds:[...ids],storageProcessCount:2,
    geographicDiversityCertified:false,
    productionCutoverAllowed:false
  });
}
