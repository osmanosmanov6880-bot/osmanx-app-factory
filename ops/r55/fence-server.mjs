#!/usr/bin/env node
// R5.5 isolated local fencing authority. Place behind independently managed
// authenticated TLS ingress only after external review; this executable
// NEVER binds 0.0.0.0 and cannot be used as production cluster coordinator.
import {createServer} from 'node:http';
import {readFile,lstat} from 'node:fs/promises';
import {createR55FenceReceiver} from '../../src/migration/r55-fence.mjs';
async function privateValue(name,{hex=false}={}){
  const path=process.env[name];
  if(typeof path!=='string'||!path.startsWith('/'))
    throw Error(name+' requires private absolute file');
  const st=await lstat(path);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>512||
    (process.platform!=='win32'&&(st.mode&0o077)!==0))
    throw Error(name+' must be ordinary private 0600 file');
  const text=(await readFile(path,'utf8')).trim();
  if(hex){
    if(!/^[a-f0-9]{64}$/.test(text))throw Error(name+' must contain 32-byte hex');
    return Buffer.from(text,'hex');
  }
  if(!/^[A-Za-z0-9._~-]{32,256}$/.test(text))throw Error(name+' bearer invalid');
  return text;
}
let server;
try{
  if(process.env.OX_R40_EPHEMERAL!=='YES'||process.env.OX_R55_SYNTHETIC_ONLY!=='YES')
    throw Error('isolated synthetic-only independent fencing authority required');
  const port=Number(process.env.OX_R55_LISTEN_PORT);
  if(!Number.isSafeInteger(port)||port<1024||port>65535)
    throw Error('OX_R55_LISTEN_PORT must be a non-privileged fixed loopback port');
  const token=await privateValue('OX_R55_BEARER_FILE');
  const secret=await privateValue('OX_R55_HMAC_KEY_FILE',{hex:true});
  server=createServer(createR55FenceReceiver({
    root:process.env.OX_R55_PRIVATE_STATE_DIR,token,secret
  }));
  server.requestTimeout=12000;
  server.headersTimeout=10000;
  server.maxRequestsPerSocket=100;
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(port,'127.0.0.1',()=>{
      server.removeListener('error',reject);resolve();
    });
  });
  process.stderr.write('[R5.5] isolated fencing authority listening on loopback\n');
  const shutdown=()=>{
    server.closeAllConnections?.();
    server.close(()=>{secret.fill(0);process.exitCode=0;});
  };
  process.once('SIGTERM',shutdown);
  process.once('SIGINT',shutdown);
}catch(e){
  process.stderr.write('R5.5 synthetic fencing server refused: '+
    String(e.message).slice(0,150)+'\n');
  process.exitCode=4;
}
