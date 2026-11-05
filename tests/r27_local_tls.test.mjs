import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer as createTlsServer, request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPublicHttps } from '../templates/deploy/verify-live.mjs';
const openssl=spawnSync('openssl',['version'],{encoding:'utf8'});

test('R2.7: real local TLS handshake checks SAN, certificate trust, redirects, and health body (not public HTTPS)',
 {timeout:20000,skip:openssl.status!==0?'OpenSSL not installed: local TLS fixture skipped':false},async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'osmanx-r27-tls-'));
 const cert=join(tmp,'test.crt'),key=join(tmp,'test.key');
 const domain='r27.osmanx.test';
 const create=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,
    '-days','1','-subj','/CN='+domain,'-addext','subjectAltName=DNS:'+domain],{encoding:'utf8',timeout:12000});
 assert.equal(create.status,0,create.stderr);
 const pem=await readFile(cert),privateKey=await readFile(key);
 let behavior='healthy',requestHeaders=null;
 const server=createTlsServer({key:privateKey,cert:pem},(req,res)=>{
   requestHeaders=req.headers;
   if(behavior==='redirect'){res.writeHead(302,{location:'/elsewhere','content-type':'text/html'});res.end();return}
   if(behavior==='bad-json'){res.writeHead(200,{'content-type':'application/json'});res.end('bad JSON');return}
   if(behavior==='unhealthy'){res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":false}');return}
   res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');
 });
 try{
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
   const port=server.address().port;
   const wrapper=(ca,servername=domain)=>(options,onResponse)=>httpsRequest({...options,port,ca,
        servername,lookup:(_name,opts,cb)=>opts?.all?cb(null,[{address:'127.0.0.1',family:4}]):cb(null,'127.0.0.1',4)},onResponse);
   const resolver=async()=>['8.8.8.8']; // Simulates DNS only; actual fixture is loopback.
   const success=await verifyPublicHttps(domain,{resolveA:resolver,request:wrapper(pem)});
   assert.equal(success.ok,true);assert.equal(success.sslCertificateValidated,true);
   assert.equal(requestHeaders.host,domain+':'+port); // node:https sets Host based on actual TLS port.
   assert.equal(requestHeaders.authorization,undefined);
   assert.equal(requestHeaders.cookie,undefined);
   await assert.rejects(verifyPublicHttps(domain,{resolveA:resolver,request:wrapper(undefined)}),/self.signed|certificate/i);
   await assert.rejects(verifyPublicHttps(domain,{resolveA:resolver,request:wrapper(pem,'wrong.osmanx.test')}),/hostname|altname|certificate/i);
   behavior='redirect';await assert.rejects(verifyPublicHttps(domain,{resolveA:resolver,request:wrapper(pem)}),/returned 302/);
   behavior='bad-json';await assert.rejects(verifyPublicHttps(domain,{resolveA:resolver,request:wrapper(pem)}),/invalid JSON/);
   behavior='unhealthy';await assert.rejects(verifyPublicHttps(domain,{resolveA:resolver,request:wrapper(pem)}),/ok=true/);
 }finally{await new Promise(r=>server.close(r));await rm(tmp,{recursive:true,force:true})}
});
