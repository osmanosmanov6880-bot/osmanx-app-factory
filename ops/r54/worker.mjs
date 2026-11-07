#!/usr/bin/env node
// R5.4 cooperative synthetic continuous CDC publisher.
// Exits safely on unavailable witness/WORM: never silently resets cursor.
// An external service supervisor must restart it with backoff after failures.
// This executable CANNOT be enabled against production source code.
import {DatabaseSync} from 'node:sqlite';
import {realpath,lstat,readFile} from 'node:fs/promises';
import {sep,resolve} from 'node:path';
import {createR48S3Transport} from '../../src/migration/r48-s3.mjs';
import {createR48WitnessClient} from '../../src/migration/r48-witness.mjs';
import {r47TenantToken} from '../../src/migration/r47-offsite.mjs';
import {r53WitnessTenant} from '../../src/migration/r53-incremental.mjs';
import {readR53Committed} from '../../src/migration/r53-commit-journal.mjs';
import {runR54SyncWindow,runR54PollingWorker} from '../../src/migration/r54-continuous-worker.mjs';
import {appendR54CheckpointEvidence} from '../../src/migration/r54-checkpoint-evidence.mjs';
function demand(name){const value=process.env[name];if(!value)throw Error(name+' required');return value;}
async function secret(name,{hex=false}={}){
  const path=demand(name);
  if(!path.startsWith('/'))throw Error(name+' must be an absolute private file');
  const st=await lstat(path);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>512||
    (process.platform!=='win32'&&(st.mode&0o077)!==0))
    throw Error(name+' must be ordinary 0600 file');
  const text=(await readFile(path,'utf8')).trim();
  if(hex){
    if(!/^[a-f0-9]{64}$/.test(text))throw Error(name+' 32-byte hex required');
    return Buffer.from(text,'hex');
  }
  if(!/^[A-Za-z0-9._~-]{32,256}$/.test(text))throw Error(name+' bearer invalid');
  return text;
}
function bounded(name,defaultValue,min,max){
  const v=Number(process.env[name]||defaultValue);
  if(!Number.isSafeInteger(v)||v<min||v>max)throw Error(name+' out of bounds');
  return v;
}
async function isolatedSource(){
  const root=await realpath(demand('OX_R54_EPHEMERAL_ROOT'));
  const file=await realpath(demand('OX_R54_SOURCE_SQLITE'));
  if(!file.startsWith(root+sep)||!file.endsWith('.sqlite'))
    throw Error('synthetic source must be inside explicit ephemeral root');
  for(const path of [root,file]){
    const st=await lstat(path);
    if(st.isSymbolicLink()||
      (process.platform!=='win32'&&(st.mode&0o077)!==0))
      throw Error('ephemeral root and SQLite source must be private and symlink-free');
    if(path===root&&!st.isDirectory())throw Error('ephemeral root must be a directory');
    if(path===file&&(!st.isFile()||st.nlink!==1))
      throw Error('synthetic SQLite source must be ordinary file');
  }
  return file;
}
const controller=new AbortController();
process.once('SIGTERM',()=>controller.abort());
process.once('SIGINT',()=>controller.abort());
let db;
try{
  if(process.env.OX_R40_EPHEMERAL!=='YES'||process.env.OX_R54_SYNTHETIC_ONLY!=='YES')
    throw Error('R5.4 only runs on an isolated synthetic CRM with explicit opt-in');
  const projectId=demand('OX_R54_PROJECT_ID');
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(projectId))
    throw Error('invalid synthetic project UUID');
  const keys={
    catalog:await secret('OX_R54_CATALOG_KEY_FILE',{hex:true}),
    delta:await secret('OX_R54_DELTA_KEY_FILE',{hex:true}),
    witness:await secret('OX_R54_WITNESS_KEY_FILE',{hex:true}),
    evidence:await secret('OX_R54_EVIDENCE_KEY_FILE',{hex:true})
  };
  const values=Object.values(keys);
  for(let i=0;i<values.length;i++)for(let j=i+1;j<values.length;j++)
    if(values[i].equals(values[j]))throw Error('independent CDC secret domains must have distinct keys');
  const sourcePath=await isolatedSource();
  db=new DatabaseSync(sourcePath,{enableForeignKeyConstraints:true});
  readR53Committed(db,{syntheticOnly:true,limit:1}); // fail on missing triggers or schema
  const vault={projectId,catalogKey:keys.catalog,
    manifestSha256:demand('OX_R54_SIGNED_MANIFEST_SHA256')};
  const tenantToken=r47TenantToken(keys.catalog,projectId);
  const remote=createR48S3Transport({
    endpoint:demand('OX_R54_S3_ENDPOINT'),
    bucket:demand('OX_R54_S3_BUCKET'),
    region:demand('OX_R54_S3_REGION'),
    accessKey:demand('OX_R54_S3_ACCESS_KEY'),
    secretKey:demand('OX_R54_S3_SECRET_KEY'),
    projectPrefix:tenantToken+'/',
    allowSyntheticLoopback:process.env.OX_R54_LOOPBACK_TEST==='YES'
  });
  const witness=createR48WitnessClient({
    endpoint:demand('OX_R54_WITNESS_ENDPOINT'),
    token:await secret('OX_R54_WITNESS_TOKEN_FILE'),
    secret:keys.witness,
    tenant:r53WitnessTenant(keys.catalog,projectId),
    allowSyntheticLoopback:process.env.OX_R54_LOOPBACK_TEST==='YES'
  });
  const cycleOptions={
    sourceDb:db,vault,remote,witness,deltaKey:keys.delta,
    baselineArchiveId:demand('OX_R54_BASELINE_ARCHIVE_ID'),
    leaseDirectory:demand('OX_R54_LEASE_DIRECTORY'),
    syntheticOnly:true,maxBatches:bounded('OX_R54_BATCHES',6,1,32),
    maxOutstandingEvents:bounded('OX_R54_MAX_BACKLOG',0,0,30000),
    maxWriteHintAgeMs:bounded('OX_R54_MAX_HINT_AGE_MS',60000,1000,86400000),
    maxRetries:bounded('OX_R54_RETRIES',2,0,5),
    retryBaseMs:bounded('OX_R54_RETRY_BASE_MS',75,1,5000),
    signal:controller.signal
  };
  const journal={directory:demand('OX_R54_EVIDENCE_DIRECTORY'),
    tenantToken,key:keys.evidence};
  const result=await runR54PollingWorker({
    signal:controller.signal,
    maxCycles:bounded('OX_R54_CYCLES',1,1,10000),
    intervalMs:bounded('OX_R54_POLL_MS',1000,25,60000),
    cycle:()=>runR54SyncWindow(cycleOptions),
    onCycle:async outcome=>{
      await appendR54CheckpointEvidence(journal,outcome);
      process.stdout.write(JSON.stringify({
        format:outcome.format,syntheticOnly:true,
        witnessedSequence:outcome.witnessedSequence,
        committedSequence:outcome.observedCommittedSequence,
        outstandingEvents:outcome.outstandingCommittedEvents,
        oldestWriteHintAgeMs:outcome.oldestPendingWriteHintAgeMs,
        writeHintIsCommitTime:false,alertRequired:outcome.alertRequired,
        productionCutoverAllowed:false
      })+'\n');
      if(outcome.alertRequired)process.exitCode=3;
      else if(process.exitCode===3)process.exitCode=0;
    }
  });
  process.stdout.write(JSON.stringify(result)+'\n');
  for(const value of values)value.fill(0);
}catch(e){
  // Use only a bounded message; never print environment or S3 credentials.
  process.stderr.write('R5.4 isolated continuous CDC refused: '+
    String(e.message).slice(0,180)+'\n');
  process.exitCode=4;
}finally{db?.close();}
