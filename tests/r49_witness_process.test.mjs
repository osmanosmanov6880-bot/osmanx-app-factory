import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer as createTcp} from 'node:net';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {createR48WitnessClient} from '../src/migration/r48-witness.mjs';

const entry=fileURLToPath(new URL('../ops/r49/witness-server.mjs',import.meta.url));
async function port(){
  const s=createTcp();await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
  const n=s.address().port;await new Promise(resolve=>s.close(resolve));return n;
}
async function launch(config){
  const child=spawn(process.execPath,[entry],{env:{...process.env,
    OX_R49_WITNESS_TOKEN_FILE:config.tokenFile,
    OX_R49_WITNESS_HMAC_KEY_FILE:config.keyFile,
    OX_R49_WITNESS_STATE_DIR:config.stateDir,
    OX_R49_WITNESS_PORT:String(config.port)},stdio:'ignore'});
  const origin='http://127.0.0.1:'+config.port+'/';
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)break;
    try{const response=await fetch(origin+'healthz',{signal:AbortSignal.timeout(500)});
      if(response.status===200)return {child,origin};}catch{}
    await sleep(60);
  }
  child.kill('SIGKILL');
  await new Promise(resolve=>child.once('close',resolve));
  throw Error('witness service did not pass health check');
}
async function stop(child){
  if(child.exitCode!==null)return;
  child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('close',resolve)),sleep(3000)]);
  if(child.exitCode===null){child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));}
}
test('R4.9 independent witness process survives restart, preserving monotonic anchor',async()=>{
  const root=await mkdtemp(join(tmpdir(),'ox-r49-witness-process-'));
  const token=randomBytes(32).toString('hex'),secret=randomBytes(32);
  const config={tokenFile:join(root,'token.txt'),keyFile:join(root,'secret.txt'),
    stateDir:join(root,'state'),port:await port()};
  await mkdir(config.stateDir,{mode:0o700});
  await writeFile(config.tokenFile,token,{mode:0o600});
  await writeFile(config.keyFile,secret.toString('hex'),{mode:0o600});
  let child;
  try{
    const first=await launch(config);child=first.child;
    const client=createR48WitnessClient({endpoint:first.origin,
      token,secret,tenant:'a'.repeat(24),allowSyntheticLoopback:true});
    const head={catalogSha256:'b'.repeat(64),manifestSha256:'c'.repeat(64),entries:1};
    await client.commit(head);
    assert.equal((await client.verify(head)).anchorVerified,true);
    await stop(child);child=null;
    const second=await launch(config);child=second.child;
    assert.equal((await client.current()).catalogSha256,head.catalogSha256);
    await assert.rejects(client.verify({...head,catalogSha256:'d'.repeat(64)}),
      /different from independent witness/);
  }finally{if(child)await stop(child);await rm(root,{recursive:true,force:true});}
});
