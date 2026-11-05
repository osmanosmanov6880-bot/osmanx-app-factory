import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {auditPublicEdge} from '../templates/deploy/edge-audit.mjs';
import {verifyPublicHttps,isAllowedPublicV6} from '../templates/deploy/verify-live.mjs';
const expected={service:'osmanx-business-crm',projectId:randomUUID(),releaseSequence:3};
const domain='r37.osmanx.co';
const addresses={resolveA:async()=>['8.8.8.8','1.1.1.1'],resolveAAAA:async()=>['2606:4700:4700::1111']};
test('R3.7: edge audit checks all IPv4/IPv6 DNS targets while pinning TCP addresses',async()=>{
 const visited=[];const probe=async (name,opt)=>{visited.push(opt.pinnedIp);assert.deepEqual(opt.expected,expected);
  return {httpsVerified:true,identityVerified:true,sslCertificateValidated:true}};
 const result=await auditPublicEdge(domain,{expected,live:true,...addresses,probe});
 assert.equal(result.ready,true);assert.equal(result.targets,3);assert.equal(result.verified,3);
 assert.deepEqual(visited,['8.8.8.8','1.1.1.1','2606:4700:4700::1111']);
 assert.equal(result.endpoints[2].family,6);
});
test('R3.7: all targets must pass; one wrong project is not hidden by a healthy endpoint',async()=>{
 const result=await auditPublicEdge(domain,{expected,live:true,...addresses,probe:async(name,{pinnedIp})=>{
  if(pinnedIp==='1.1.1.1')throw Error('HTTPS endpoint does not match expected application, project and release');
  return {httpsVerified:true,identityVerified:true,sslCertificateValidated:true};
 }});
 assert.equal(result.ready,false);assert.equal(result.verified,2);
 assert.equal(result.endpoints[1].errorCode,'WRONG_DEPLOYMENT_IDENTITY');
 assert.ok(!JSON.stringify(result).includes('project and release'));
});
test('R3.7: offline DNS-only never invokes HTTPS or claims readiness',async()=>{
 const result=await auditPublicEdge(domain,{expected,live:false,...addresses,probe:async()=>{throw Error('must not run')}});
 assert.equal(result.ready,false);assert.equal(result.liveHttpsChecked,false);
 assert.equal(result.verified,0);assert.equal(result.endpoints.length,3);
});
test('R3.7: reject private DNS, malformed identity, too many targets and DNS lookup failures',async()=>{
 await assert.rejects(auditPublicEdge(domain,{expected,live:true,resolveA:async()=>['127.0.0.1'],resolveAAAA:async()=>[]}),/non-public/);
 await assert.rejects(auditPublicEdge(domain,{expected:{...expected,releaseSequence:-1},...addresses}),/Expected project/);
 await assert.rejects(auditPublicEdge(domain,{expected,resolveA:async()=>Array.from({length:9},(_,i)=>'8.8.8.'+(i+1)),resolveAAAA:async()=>[]}),/Unbounded/);
 await assert.rejects(auditPublicEdge(domain,{expected,resolveA:async()=>{throw Object.assign(Error('no'),{code:'ETIMEOUT'})},resolveAAAA:async()=>[]}),/DNS A lookup failed/);
 for(const x of ['::1','fc00::1','fe80::1','::ffff:8.8.8.8','2001:db8::1'])assert.equal(isAllowedPublicV6(x),false,x);
 assert.equal(isAllowedPublicV6('2606:4700:4700::1111'),true);
 await assert.rejects(verifyPublicHttps(domain,{pinnedIp:'::1',expected}),/not public/);
});
