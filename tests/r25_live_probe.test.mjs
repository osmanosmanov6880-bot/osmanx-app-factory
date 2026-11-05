import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {isAllowedPublicV4,verifyPublicHttps} from '../templates/deploy/verify-live.mjs';

function fakeRequest({status=200,type='application/json; charset=utf-8',body='{"ok":true}',onOptions}={}){
 return (options,respond)=>{
  onOptions?.(options);
  const req=new EventEmitter();req.setTimeout=()=>{};
  req.destroy=e=>req.emit('error',e);
  req.end=()=>{
   const response=new EventEmitter();response.statusCode=status;response.headers={'content-type':type};
   respond(response);
   queueMicrotask(()=>{response.emit('data',Buffer.from(body));response.emit('end')});
  };
  return req;
 };
}

test('R2.5: pinned HTTPS health probe validates TLS, origin, status and JSON',{timeout:10000},async()=>{
 let captured;
 const result=await verifyPublicHttps('crm.acme.co',{resolveA:async()=>['8.8.8.8'],
  request:fakeRequest({onOptions:o=>captured=o})});
 assert.equal(result.httpsVerified,true);assert.equal(result.ip,'8.8.8.8');
 assert.equal(captured.hostname,'crm.acme.co');
 assert.equal(captured.servername,'crm.acme.co');
 assert.equal(captured.path,'/api/health');
 assert.equal(captured.rejectUnauthorized,true);
 assert.equal(captured.method,'GET');
 assert.equal(captured.headers['Accept-Encoding'],'identity');
 await new Promise((resolve,reject)=>captured.lookup('crm.acme.co',{},(err,ip,family)=>err?reject(err):(assert.equal(ip,'8.8.8.8'),assert.equal(family,4),resolve())));
});

test('R2.5: probe refuses private DNS, invalid domain, redirect, invalid JSON, wrong health',{timeout:10000},async()=>{
 for(const value of ['127.0.0.1','192.168.0.1','10.2.3.4','169.254.8.8','198.18.0.1','203.0.113.10'])assert.equal(isAllowedPublicV4(value),false);
 assert.equal(isAllowedPublicV4('8.8.8.8'),true);
 let requests=0;
 const request=(...args)=>{requests++;return fakeRequest()(...args)};
 await assert.rejects(verifyPublicHttps('crm.acme.co',{resolveA:async()=>['8.8.8.8','10.0.0.1'],request}),/private, reserved/);
 await assert.rejects(verifyPublicHttps('http://127.0.0.1',{resolveA:async()=>['8.8.8.8'],request}),/Invalid domain/);
 assert.equal(requests,0,'no HTTP request to a private or malformed host');
 for(const opts of [{status:301},{status:404},{type:'text/html'},{body:'{"ok":false}'},{body:'malformed'}]){
  await assert.rejects(verifyPublicHttps('crm.acme.co',{resolveA:async()=>['1.1.1.1'],request:fakeRequest(opts)}));
 }
});
