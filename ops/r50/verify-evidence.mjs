#!/usr/bin/env node
// Operator-only verification of private HMAC log. No key bytes in output.
import {readFile,lstat} from 'node:fs/promises';
import {readR50Evidence} from '../../src/migration/r50-evidence.mjs';
async function loadKey(){
  const file=process.env.OX_R50_EVIDENCE_KEY_FILE;
  if(!file||!file.startsWith('/'))throw Error('private absolute OX_R50_EVIDENCE_KEY_FILE required');
  const st=await lstat(file);
  if(!st.isFile()||st.isSymbolicLink()||
    (process.platform!=='win32'&&(st.mode&0o077)!==0))
    throw Error('evidence HMAC key must be an ordinary private 0600 file');
  const value=(await readFile(file,'utf8')).trim();
  if(!/^[a-f0-9]{64}$/.test(value))throw Error('evidence HMAC key format invalid');
  return Buffer.from(value,'hex');
}
try{
  const key=await loadKey();
  const result=await readR50Evidence({
    directory:process.env.OX_R50_EVIDENCE_DIRECTORY,
    tenantToken:process.env.OX_R50_TENANT_TOKEN,key
  });
  key.fill(0);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(result.recordCount<1||result.lastVerdict!=='PASS')process.exitCode=3;
}catch(e){
  process.stderr.write('R5.0 evidence verification: '+String(e.message).slice(0,200)+'\n');
  process.exitCode=3;
}
