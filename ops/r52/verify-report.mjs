#!/usr/bin/env node
// Read-only operator verifier for synthetic R5.2 signed disaster test receipt.
// A witnessed post-backup transaction loss returns a NONZERO exit code.
import {readFile,lstat} from 'node:fs/promises';
import {verifyR52RehearsalReceipt} from '../../src/migration/r52-receipt.mjs';
async function keyFile(){
  const path=process.env.OX_R52_RECEIPT_KEY_FILE;
  if(typeof path!=='string'||!path.startsWith('/'))
    throw Error('OX_R52_RECEIPT_KEY_FILE must be a private absolute path');
  const st=await lstat(path);
  if(!st.isFile()||st.isSymbolicLink()||st.size>256||
    (process.platform!=='win32'&&(st.mode&0o077)!==0))
    throw Error('R5.2 receipt key file must be private 0600');
  const secret=(await readFile(path,'utf8')).trim();
  if(!/^[a-f0-9]{64}$/.test(secret))throw Error('invalid R5.2 receipt key');
  return Buffer.from(secret,'hex');
}
try{
  if(process.env.OX_R52_SYNTHETIC_ONLY!=='YES'||
    process.env.OX_R40_EPHEMERAL!=='YES')
    throw Error('only isolated synthetic test receipts supported');
  const key=await keyFile();
  const result=await verifyR52RehearsalReceipt({
    directory:process.env.OX_R52_RECEIPT_DIRECTORY,
    tenantToken:process.env.OX_R52_TENANT_TOKEN,key
  },process.env.OX_R52_RECEIPT_ID);
  key.fill(0);
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(result.syntheticLossBudgetMet!==true)process.exitCode=5;
}catch(e){
  process.stderr.write('R5.2 private DR receipt rejected: '+String(e.message).slice(0,160)+'\n');
  process.exitCode=5;
}
