// R5.7 S3 capability boundary for ONE pinned tenant. In-process wrappers
// are defense-in-depth; actual isolation requires the generated IAM policies
// and separate credentials on different hosts.
const TENANT=/^[a-f0-9]{24}$/;
const BUCKET=/^(?=.{3,63}$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/;
const SEG=/^r53\/segments\/[a-f0-9]{64}\.oxd$/;
const HEAD='r53/head.json';
function deny(ok,reason){if(!ok)throw Error('R5.7 S3 scope refused: '+reason);}
export function createR57ScopedS3Capabilities({transport,tenantId}={}){
  deny(TENANT.test(tenantId||'')&&
    transport?.tenantPrefix===tenantId+'/'&&
    typeof transport.put==='function'&&
    typeof transport.get==='function'&&
    typeof transport.getWithMetadata==='function'&&
    typeof transport.inspectR49Worm==='function'&&
    typeof transport.assertBucketControls==='function',
    'verified tenant-prefixed SigV4 transport required');
  const verifiedKey=key=>{
    deny(key===HEAD||SEG.test(key||''),'only incremental head/segments allowed');
  };
  const publisher=Object.freeze({
    async put(key,bytes,opts={}){
      deny(SEG.test(key||'')&&Object.keys(opts).length===0,
        'publisher cannot PUT the mutable S3 checkpoint');
      return transport.put(key,bytes);
    },
    async get(key){verifiedKey(key);return transport.get(key);},
    async getWithMetadata(key){
      verifiedKey(key);return transport.getWithMetadata(key);
    },
    async inspectR49Worm(key,opts){
      verifiedKey(key);return transport.inspectR49Worm(key,opts);
    },
    async assertBucketControls(){return transport.assertBucketControls();},
    tenantPrefix:tenantId+'/',role:'segment-publisher-only'
  });
  const coordinator=Object.freeze({
    async put(key,bytes,opts){
      deny(key===HEAD&&opts&&
        ((typeof opts.ifMatch==='string'&&!opts.ifNoneMatch)||
         (opts.ifNoneMatch===true&&!opts.ifMatch)),
        'coordinator accepts conditional HEAD writes only');
      return transport.put(key,bytes,opts);
    },
    async getWithMetadata(key){
      deny(key===HEAD,'coordinator can read only HEAD');
      return transport.getWithMetadata(key);
    },
    async inspectR49Worm(key,opts){
      deny(key===HEAD,'coordinator can attest only HEAD');
      return transport.inspectR49Worm(key,opts);
    },
    async assertBucketControls(){return transport.assertBucketControls();},
    tenantPrefix:tenantId+'/',role:'pointer-coordinator-only'
  });
  return Object.freeze({publisher,coordinator});
}
export function createR57S3IamPolicies({bucket,tenantId}={}){
  deny(BUCKET.test(bucket||'')&&!bucket.includes('..')&&
    TENANT.test(tenantId||''),'literal bucket and exact opaque tenant ID required');
  const base='arn:aws:s3:::'+bucket;
  const bucketControls={Effect:'Allow',
    Action:['s3:GetBucketVersioning','s3:GetBucketObjectLockConfiguration'],
    Resource:base};
  const publisher={
    Version:'2012-10-17',Statement:[
      bucketControls,
      {Effect:'Allow',Action:['s3:PutObject','s3:GetObject','s3:GetObjectRetention'],
        Resource:base+'/'+tenantId+'/r53/segments/*'},
      {Effect:'Allow',Action:['s3:GetObject','s3:GetObjectRetention'],
        Resource:base+'/'+tenantId+'/'+HEAD}
    ]
  };
  const coordinator={
    Version:'2012-10-17',Statement:[
      bucketControls,
      {Effect:'Allow',Action:['s3:PutObject','s3:GetObject','s3:GetObjectRetention'],
        Resource:base+'/'+tenantId+'/'+HEAD}
    ]
  };
  return {publisher,coordinator,requiresDistinctCredentials:true,
    privilegesApplied:false,productionCutoverAllowed:false};
}
