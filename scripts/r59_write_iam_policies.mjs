// R5.9: deterministic local IAM policy files for disposable MinIO only.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createR57S3IamPolicies} from '../src/migration/r57-s3-scope.mjs';

if(process.env.OX_R59_LAB_ACK!=='YES'||
  process.env.OX_R40_EPHEMERAL!=='YES')throw Error('disposable lab flags required');
const tenantId=process.env.OX_R59_IAM_TENANT;
const bucket=process.env.OX_R59_IAM_BUCKET;
if(!/^[a-f0-9]{24}$/.test(tenantId||''))throw Error('opaque tenant required');
const out=resolve('artifacts/r59-iam');
await mkdir(out,{recursive:true,mode:0o700});
const policies=createR57S3IamPolicies({bucket,tenantId});
await Promise.all([
  writeFile(out+'/publisher.json',JSON.stringify(policies.publisher,null,2)+'\n',{mode:0o600}),
  writeFile(out+'/coordinator.json',JSON.stringify(policies.coordinator,null,2)+'\n',{mode:0o600})
]);
if(policies.privilegesApplied!==false)throw Error('policy generation is not IAM application');
process.stdout.write(JSON.stringify({syntheticOnly:true,
  tenantId,bucket,policyFiles:['publisher.json','coordinator.json']})+'\n');
