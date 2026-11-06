#!/usr/bin/env node
// Isolated test-host operator CLI. Read-only by default; an explicit opt-in
// may publish an R5.0 HMAC evidence digest to the external monotonic anchor.
// NEVER authorizes PostgreSQL cutover or reading real customer data.
import {readFile,lstat} from 'node:fs/promises';
import {createR48S3Transport} from '../../src/migration/r48-s3.mjs';
import {createR48WitnessClient} from '../../src/migration/r48-witness.mjs';
import {r47TenantToken} from '../../src/migration/r47-offsite.mjs';
import {createR51EvidenceAnchorClient,anchorR51Evidence}
  from '../../src/migration/r51-anchor.mjs';
import {createR51AlertChallengeClient} from '../../src/migration/r51-alert-ack.mjs';
import {runR51OperationalReadiness} from '../../src/migration/r51-readiness.mjs';

function required(name){const value=process.env[name];if(!value)throw Error(name+' required');return value;}
async function secret(name,{hex=false}={}){
  const file=required(name);
  if(!file.startsWith('/'))throw Error(name+' must be a private absolute file path');
  const stat=await lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096||
    (process.platform!=='win32'&&(stat.mode&0o077)!==0))
    throw Error(name+' must reference a regular 0600 file');
  const value=(await readFile(file,'utf8')).trim();
  if(hex){
    if(!/^[a-f0-9]{64}$/.test(value))throw Error(name+' invalid 32-byte key');
    return Buffer.from(value,'hex');
  }
  if(!/^[A-Za-z0-9._~-]{32,256}$/.test(value))throw Error(name+' invalid bearer');
  return value;
}
try{
  if(process.env.OX_R40_EPHEMERAL!=='YES'||process.env.OX_R51_SYNTHETIC_ONLY!=='YES')
    throw Error('R5.1 CLI requires explicit synthetic-only flags');
  const projectId=required('OX_R51_PROJECT_ID');
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(projectId))
    throw Error('signed CRM project ID invalid');
  const catalogKey=await secret('OX_R51_CATALOG_KEY_FILE',{hex:true});
  const token=r47TenantToken(catalogKey,projectId);
  const witnessKey=await secret('OX_R51_WITNESS_KEY_FILE',{hex:true});
  const evidenceKey=await secret('OX_R51_EVIDENCE_KEY_FILE',{hex:true});
  const anchorKey=await secret('OX_R51_ANCHOR_KEY_FILE',{hex:true});
  const alertKey=await secret('OX_R51_ALERT_KEY_FILE',{hex:true});
  const loopback=process.env.OX_R51_LOOPBACK_TEST==='YES';
  const remote=createR48S3Transport({
    endpoint:required('OX_R51_STORAGE_ENDPOINT'),
    bucket:required('OX_R51_S3_BUCKET'),region:required('OX_R51_S3_REGION'),
    accessKey:required('OX_R51_S3_ACCESS_KEY'),
    secretKey:required('OX_R51_S3_SECRET_KEY'),
    projectPrefix:token+'/',allowSyntheticLoopback:loopback
  });
  const witness=createR48WitnessClient({
    endpoint:required('OX_R51_WITNESS_ENDPOINT'),
    token:await secret('OX_R51_WITNESS_TOKEN_FILE'),secret:witnessKey,
    tenant:token,allowSyntheticLoopback:loopback
  });
  const anchor=createR51EvidenceAnchorClient({
    endpoint:required('OX_R51_ANCHOR_ENDPOINT'),
    token:await secret('OX_R51_ANCHOR_TOKEN_FILE'),
    secret:anchorKey,tenantToken:token,allowSyntheticLoopback:loopback
  });
  const alert=createR51AlertChallengeClient({
    endpoint:required('OX_R51_ALERT_ENDPOINT'),
    token:await secret('OX_R51_ALERT_TOKEN_FILE'),secret:alertKey,
    tenantToken:token,allowSyntheticLoopback:loopback
  });
  const vault={projectId,catalogKey,
    manifestSha256:required('OX_R51_SIGNED_MANIFEST_SHA256')};
  const evidence={directory:required('OX_R51_EVIDENCE_DIRECTORY'),
    key:evidenceKey,tenantToken:token};
  const args={vault,evidence,remote,witness,anchor,alert,
    witnessKey,anchorKey,alertKey,
    storageEndpoint:required('OX_R51_STORAGE_ENDPOINT'),
    witnessEndpoint:required('OX_R51_WITNESS_ENDPOINT'),
    anchorEndpoint:required('OX_R51_ANCHOR_ENDPOINT'),
    alertEndpoint:required('OX_R51_ALERT_ENDPOINT'),
    allowSyntheticLoopback:loopback,
    maxEvidenceAgeMs:Number(process.env.OX_R51_MAX_EVIDENCE_AGE_MS||3600000)};
  if(process.env.OX_R51_ANCHOR_COMMIT==='YES'){
    const proof=await anchorR51Evidence(args);
    process.stdout.write(JSON.stringify({stage:'anchor-publication',...proof})+'\n');
  }
  const proof=await runR51OperationalReadiness(args);
  process.stdout.write(JSON.stringify(proof,null,2)+'\n');
  if(!proof.engineeringEvidenceVerified||!proof.signedMachineAlertAcknowledged)
    process.exitCode=7;
  for(const key of [catalogKey,witnessKey,evidenceKey,anchorKey,alertKey])key.fill(0);
}catch(e){
  // Do not log bearer values, S3 authorization headers or HMAC keys.
  process.stderr.write('R5.1 verification rejected: '+String(e.message).slice(0,180)+'\n');
  process.exitCode=7;
}
