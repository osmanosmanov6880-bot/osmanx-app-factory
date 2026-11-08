#!/usr/bin/env node
// R5.8 stand-alone loopback-only synthetic coordinator gateway.
// No proxy headers, plaintext fallback, deploy switch or global bind.
import https from 'node:https';
import {readFile,lstat} from 'node:fs/promises';
import pg from 'pg';
import {createR48S3Transport} from '../../src/migration/r48-s3.mjs';
import {createR57ScopedS3Capabilities} from '../../src/migration/r57-s3-scope.mjs';
import {createR57PgCoordinator} from '../../src/migration/r57-pg-coordinator.mjs';
import {createR58PgNonceStore} from '../../src/migration/r58-nonce-store.mjs';
import {createR58MtlsHandler} from '../../src/migration/r58-mtls-coordinator.mjs';
import {createR59TrustWindow,activateR59PgTrustGeneration}
  from '../../src/migration/r59-cert-rotation.mjs';

async function secretFile(env,{hex=false,privateFile=true}={}){
  const path=process.env[env];
  if(!path||!path.startsWith('/'))throw Error(env+' must be absolute filename');
  const s=await lstat(path);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>8192||
    (privateFile&&process.platform!=='win32'&&(s.mode&0o077)!==0))
    throw Error(env+' must be an ordinary private file');
  const bytes=await readFile(path);
  if(hex){
    const value=bytes.toString('utf8').trim();
    bytes.fill(0);
    if(!/^[a-f0-9]{64}$/.test(value))throw Error(env+' must be a 32-byte hex secret');
    return Buffer.from(value,'hex');
  }
  return bytes;
}
let server,pool,sharedKey;
try{
  if(process.env.OX_R40_EPHEMERAL!=='YES'||
    process.env.OX_R58_SYNTHETIC_ONLY!=='YES')
    throw Error('synthetic ephemeral test flags required');
  const tenantId=process.env.OX_R58_TENANT;
  if(!/^[a-f0-9]{24}$/.test(tenantId||''))
    throw Error('pinned tenant ID required');
  const port=Number(process.env.OX_R58_PORT);
  if(!Number.isSafeInteger(port)||port<1024||port>65535)
    throw Error('fixed unprivileged port required');
  const [cert,key,ca,access,secret]=await Promise.all([
    secretFile('OX_R58_SERVER_CERT_FILE',{privateFile:false}),
    secretFile('OX_R58_SERVER_KEY_FILE'),
    secretFile('OX_R58_CLIENT_CA_FILE',{privateFile:false}),
    secretFile('OX_R58_S3_ACCESS_FILE'),
    secretFile('OX_R58_S3_SECRET_FILE')
  ]);
  sharedKey=await secretFile('OX_R58_HMAC_KEY_FILE',{hex:true});
  const transport=createR48S3Transport({
    endpoint:process.env.OX_R58_S3_ENDPOINT,
    bucket:process.env.OX_R58_S3_BUCKET,
    region:process.env.OX_R58_S3_REGION||'us-east-1',
    accessKey:access.toString('utf8').trim(),
    secretKey:secret.toString('utf8').trim(),
    projectPrefix:tenantId+'/',allowSyntheticLoopback:true
  });
  access.fill(0);secret.fill(0);
  const caps=createR57ScopedS3Capabilities({transport,tenantId});
  pool=new pg.Pool({
    host:process.env.PGHOST||'127.0.0.1',
    port:Number(process.env.PGPORT||5432),
    user:process.env.PGUSER,
    password:process.env.PGPASSWORD,
    database:process.env.PGDATABASE,
    max:6,connectionTimeoutMillis:5000,statement_timeout:20000
  });
  await pool.query('SELECT tenant FROM ox_r57_checkpoint_control LIMIT 0');
  await pool.query('SELECT nonce FROM ox_r58_request_nonce LIMIT 0');
  const coordinator=createR57PgCoordinator({
    pool,privilegedRemote:caps.coordinator,tenantId,syntheticOnly:true
  });
  const nonceStore=createR58PgNonceStore({pool,tenantId});
  let trustedClientPins=null;
  if(process.env.OX_R59_TRUST_MANIFEST_FILE){
    const [signedManifest,publicPem]=await Promise.all([
      secretFile('OX_R59_TRUST_MANIFEST_FILE',{privateFile:false}),
      secretFile('OX_R59_TRUST_PUBLIC_KEY_FILE',{privateFile:false})
    ]);
    const manifest=JSON.parse(signedManifest.toString('utf8'));
    const trust=createR59TrustWindow({
      manifest,publicKey:publicPem,tenantId,
      minGeneration:Number(process.env.OX_R59_MIN_PIN_GENERATION||1)
    });
    trust.trustedClientPins();
    trust.trustedServerPins();
    await activateR59PgTrustGeneration({pool,tenantId,trustWindow:trust});
    trustedClientPins=trust.trustedClientPins;
  }
  const handler=createR58MtlsHandler({
    tenantId,coordinator,nonceStore,sharedKey,
    clientFingerprintSha256:process.env.OX_R58_CLIENT_CERT_SHA256,
    trustedClientPins
  });
  server=https.createServer({
    cert,key,ca,requestCert:true,rejectUnauthorized:true,
    minVersion:'TLSv1.2',maxHeaderSize:8192
  },handler);
  server.requestTimeout=12000;
  server.headersTimeout=10000;
  server.maxRequestsPerSocket=100;
  server.on('clientError',(_error,socket)=>socket.destroy());
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(port,'127.0.0.1',()=>{
      server.removeListener('error',reject);resolve();
    });
  });
  process.stderr.write('[R5.8] mTLS synthetic authority active on loopback\n');
  const stop=async()=>{
    server.closeAllConnections?.();
    await new Promise(ok=>server.close(ok));
    await pool.end();
    sharedKey.fill(0);
  };
  for(const sig of ['SIGTERM','SIGINT']){
    process.once(sig,()=>{stop().catch(()=>{});});
  }
}catch(e){
  process.stderr.write('[R5.8] gateway startup refused: '+
    String(e.message).slice(0,140)+'\n');
  sharedKey?.fill(0);
  await pool?.end().catch(()=>{});
  process.exitCode=4;
}
