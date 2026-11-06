#!/usr/bin/env node
// Verify external detached signatures ONLY. Does not sign on behalf of users.
import {readFile,lstat} from 'node:fs/promises';
import {verifyR50IndependentReviews} from '../../src/migration/r50-approvals.mjs';
async function file(name){
  const path=process.env[name];
  if(!path||!path.startsWith('/'))throw Error(name+' requires an absolute local file');
  const stat=await lstat(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)
    throw Error(name+' is not a bounded normal file');
  return readFile(path,'utf8');
}
try{
  const challenge=JSON.parse(await file('OX_R50_CHALLENGE_FILE'));
  const approvals=JSON.parse(await file('OX_R50_APPROVALS_FILE'));
  const trustedPublicKeys={
    security:await file('OX_R50_SECURITY_PUBLIC_KEY_FILE'),
    operations:await file('OX_R50_OPERATIONS_PUBLIC_KEY_FILE'),
    dataOwner:await file('OX_R50_DATA_OWNER_PUBLIC_KEY_FILE')
  };
  const result=verifyR50IndependentReviews({challenge,approvals,trustedPublicKeys});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(e){
  process.stderr.write('R5.0 detached reviews: '+String(e.message).slice(0,200)+'\n');
  process.exitCode=4;
}
