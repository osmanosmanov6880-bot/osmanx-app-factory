import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {createR60S3VersionForensics}
  from '../src/migration/r60-s3-version-forensics.mjs';
const TENANT='a'.repeat(24),BUCKET='r60-synthetic-worm',
  HEAD=TENANT+'/r53/head.json';
const sha=b=>createHash('sha256').update(b).digest('hex');
const one=Buffer.from('signed-after-ambiguous-s3-put'),
  older=Buffer.from('previous-retained-version');
async function fixture({
  deleteMarker=false,truncated=false,wrongRetention=false,
  forgedKey=false,wrongVersionHeader=false,duplicate=false
}={}){
  const seen=[];
  let writes=0;
  const server=createServer((req,res)=>{
    seen.push({method:req.method,url:req.url,authorization:req.headers.authorization});
    if(req.method!=='GET'&&req.method!=='HEAD'){writes++;res.writeHead(405).end();return;}
    const u=new URL(req.url,'http://127.0.0.1');
    if(req.method==='GET'&&u.pathname==='/'+BUCKET){
      const version=(id,latest,stamp)=>'<Version><Key>'+
        (forgedKey?'other/'+HEAD:HEAD)+'</Key><VersionId>'+id+
        '</VersionId><IsLatest>'+latest+'</IsLatest><LastModified>'+
        stamp+'</LastModified></Version>';
      const record=version('version-2','true','2026-11-09T03:00:00.000Z')+
        version('version-1','false','2026-11-09T02:59:00.000Z')+
        (duplicate?version('version-2','false','2026-11-09T02:58:00.000Z'):'');
      const marker=deleteMarker?'<DeleteMarker><Key>'+HEAD+
        '</Key><VersionId>deleted-3</VersionId></DeleteMarker>':'';
      res.writeHead(200,{'content-type':'application/xml'});
      res.end('<ListVersionsResult><IsTruncated>'+
        String(truncated)+'</IsTruncated>'+record+marker+'</ListVersionsResult>');
      return;
    }
    if(u.pathname==='/'+BUCKET+'/'+HEAD&&
      u.searchParams.has('versionId')){
      const id=u.searchParams.get('versionId');
      const body=id==='version-2'?one:older;
      const h={
        'x-amz-version-id':wrongVersionHeader?'forged':id,
        'x-amz-object-lock-mode':wrongRetention?'GOVERNANCE':'COMPLIANCE',
        'x-amz-object-lock-retain-until-date':'2090-01-01T00:00:00.000Z'
      };
      res.writeHead(200,h);
      if(req.method==='GET')res.end(body);else res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const c=createR60S3VersionForensics({
    endpoint:'http://127.0.0.1:'+server.address().port+'/',
    bucket:BUCKET,region:'us-east-1',tenantId:TENANT,
    accessKey:'R60FORENSIC01',
    secretKey:'R60_ISOLATED_REVIEW_ONLY_TEST_SECRET_2026',
    allowSyntheticLoopback:true
  });
  return {c,seen,get writes(){return writes;},
    close:()=>new Promise(ok=>server.close(ok))};
}
test('R6.0 reports signed WORM object versions but never clears PostgreSQL quarantine',
  async()=>{
    const f=await fixture();try{
      const report=await f.c.investigate({
        pendingSha256:sha(one),previousVersionId:'version-1'
      });
      assert.equal(report.reviewedVersions.length,2);
      assert.deepEqual(report.matchingPendingVersions,['version-2']);
      assert.equal(report.canUnquarantine,false);
      assert.equal(report.requiresManualWitnessReview,true);
      assert.equal(report.productionCutoverAllowed,false);
      assert.equal(f.writes,0);
      assert(f.seen.every(x=>x.authorization?.startsWith('AWS4-HMAC-SHA256 ')));
      assert(f.seen.some(x=>x.url.includes('versions=')));
    }finally{await f.close();}
  });
test('R6.0 refuses empty/missing history and cannot approve ambiguous outcome',
  async()=>{
    const f=await fixture();try{
      const r=await f.c.investigate({
        pendingSha256:sha(Buffer.from('not-in-bucket'))
      });
      assert.deepEqual(r.matchingPendingVersions,[]);
      assert.equal(r.canUnquarantine,false);
      await assert.rejects(f.c.inspectVersion('../arbitrary'),/strict version ID/);
      await assert.rejects(f.c.investigate({pendingSha256:'not-sha'}),
        /exact signed pending digest/);
    }finally{await f.close();}
  });
test('R6.0 fails closed on truncated history, delete marker and foreign object key',
  async()=>{
    for(const options of [{truncated:true},{deleteMarker:true},{forgedKey:true},
      {duplicate:true}]){
      const f=await fixture(options);
      try{
        await assert.rejects(f.c.investigate({pendingSha256:sha(one)}));
        assert.equal(f.writes,0);
      }finally{await f.close();}
    }
  });
test('R6.0 refuses missing COMPLIANCE mode and inconsistent version HEAD/GET',
  async()=>{
    for(const options of [{wrongRetention:true},{wrongVersionHeader:true}]){
      const f=await fixture(options);
      try{
        await assert.rejects(f.c.investigate({pendingSha256:sha(one)}));
        assert.equal(f.writes,0);
      }finally{await f.close();}
    }
  });
