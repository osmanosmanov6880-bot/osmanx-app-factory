import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createR48S3Transport} from '../src/migration/r48-s3.mjs';
const accessKey='R49SYNTHACCESS01',secretKey='r49-synthetic-test-secret-0123456789ABCDEF';
const key='archives/'+'b'.repeat(32)+'.oxb';
async function setup(){
  const state={versioned:true,lockEnabled:true,defaultCompliance:true,
    mode:'COMPLIANCE',retainMs:86400000,versionId:'version-123'};
  const server=createServer((req,res)=>{
    const q=req.url.split('?')[1]||'';
    if(q==='versioning='){
      res.writeHead(200);res.end('<VersioningConfiguration><Status>'+
        (state.versioned?'Enabled':'Suspended')+'</Status></VersioningConfiguration>');return;
    }
    if(q==='object-lock='){
      res.writeHead(200);
      res.end('<ObjectLockConfiguration><ObjectLockEnabled>'+
        (state.lockEnabled?'Enabled':'Disabled')+'</ObjectLockEnabled>'+
        (state.defaultCompliance?'<Rule><DefaultRetention><Mode>COMPLIANCE</Mode><Days>7</Days></DefaultRetention></Rule>':'')+
        '</ObjectLockConfiguration>');return;
    }
    if(req.method==='HEAD'){
      res.writeHead(200,{'x-amz-version-id':state.versionId,
        'x-amz-object-lock-mode':state.mode,
        'x-amz-object-lock-retain-until-date':new Date(Date.now()+state.retainMs).toISOString()});
      res.end();return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const remote=createR48S3Transport({endpoint:'http://127.0.0.1:'+server.address().port+'/',
    bucket:'r49-synthetic-worm',region:'us-east-1',
    accessKey,secretKey,projectPrefix:'a'.repeat(24)+'/',
    allowSyntheticLoopback:true});
  return {state,remote,close:()=>new Promise(resolve=>server.close(resolve))};
}
test('R4.9 requires actual object version and unexpired COMPLIANCE mode',async()=>{
  const f=await setup();try{
    const x=await f.remote.inspectR49Worm(key);
    assert.equal(x.versioned,true);
    assert.equal(x.versionId,'version-123');
    assert.equal(x.retentionMode,'COMPLIANCE');
    assert.equal(x.objectLockVerified,true);
  }finally{await f.close();}
});
test('R4.9 rejects weak or missing S3 default retention',async()=>{
  const f=await setup();try{
    f.state.defaultCompliance=false;
    await assert.rejects(f.remote.inspectR49Worm(key),/default COMPLIANCE retention/);
    f.state.defaultCompliance=true;f.state.versioned=false;
    await assert.rejects(f.remote.inspectR49Worm(key),/bucket versioning/);
  }finally{await f.close();}
});
test('R4.9 rejects governance, expired retention and unversioned objects',async()=>{
  const f=await setup();try{
    f.state.mode='GOVERNANCE';
    await assert.rejects(f.remote.inspectR49Worm(key),/lacks future COMPLIANCE/);
    f.state.mode='COMPLIANCE';f.state.retainMs=1000;
    await assert.rejects(f.remote.inspectR49Worm(key),/lacks future COMPLIANCE/);
    f.state.retainMs=86400000;f.state.versionId='null';
    await assert.rejects(f.remote.inspectR49Worm(key),/lacks a version ID/);
  }finally{await f.close();}
});
