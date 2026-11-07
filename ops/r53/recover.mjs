#!/usr/bin/env node
// R5.3 independent SYNTHETIC recovery CLI, no access to source SQLite.
// Rebuilds trusted R4.9 signed WORM base from S3 FIRST, then uses a different
// monotonic witness and AES key to restore post-snapshot committed changes.
// Writes two new private files; never changes the primary or runs payments.
import {readFile,lstat} from 'node:fs/promises';
import {createR48S3Transport} from '../../src/migration/r48-s3.mjs';
import {createR48WitnessClient} from '../../src/migration/r48-witness.mjs';
import {r47TenantToken} from '../../src/migration/r47-offsite.mjs';
import {r53WitnessTenant} from '../../src/migration/r53-incremental.mjs';
import {restoreR49Offline} from '../../src/migration/r49-operational-dr.mjs';
import {restoreR53Incremental} from '../../src/migration/r53-replay.mjs';
function demand(name){
  const value=process.env[name];
  if(!value)throw Error(name+' is required');
  return value;
}
async function secret(name,{hex=false}={}){
  const path=demand(name);
  if(!path.startsWith('/'))throw Error(name+' requires a private absolute file');
  const st=await lstat(path);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>512||
    (process.platform!=='win32'&&(st.mode&0o077)!==0))
    throw Error(name+' must be ordinary private 0600 file');
  const value=(await readFile(path,'utf8')).trim();
  if(hex){
    if(!/^[a-f0-9]{64}$/.test(value))throw Error(name+' 32-byte hex invalid');
    return Buffer.from(value,'hex');
  }
  if(!/^[A-Za-z0-9._~-]{32,256}$/.test(value))throw Error(name+' bearer invalid');
  return value;
}
try{
  if(process.env.OX_R40_EPHEMERAL!=='YES'||process.env.OX_R53_SYNTHETIC_ONLY!=='YES')
    throw Error('R5.3 operator CLI only supports isolated synthetic CRM data');
  const projectId=demand('OX_R53_PROJECT_ID');
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(projectId))
    throw Error('invalid signed CRM project UUID');
  const catalogKey=await secret('OX_R53_CATALOG_KEY_FILE',{hex:true});
  const deltaKey=await secret('OX_R53_DELTA_KEY_FILE',{hex:true});
  const backupWitnessKey=await secret('OX_R53_BACKUP_WITNESS_KEY_FILE',{hex:true});
  const incrementalWitnessKey=await secret('OX_R53_DELTA_WITNESS_KEY_FILE',{hex:true});
  if([deltaKey,backupWitnessKey,incrementalWitnessKey].some(x=>x.equals(catalogKey))||
    deltaKey.equals(backupWitnessKey)||deltaKey.equals(incrementalWitnessKey)||
    backupWitnessKey.equals(incrementalWitnessKey))
    throw Error('all four cryptographic trust domains require separate keys');
  const keyId=demand('OX_R53_BACKUP_KEY_ID');
  if(!/^[a-z][a-z0-9_-]{2,31}$/.test(keyId))throw Error('invalid active backup encryption key ID');
  const keyRing={activeId:keyId,
    keys:{[keyId]:await secret('OX_R53_BACKUP_KEY_FILE',{hex:true})}};
  if(process.env.OX_R53_OLD_BACKUP_KEY_ID){
    const old=process.env.OX_R53_OLD_BACKUP_KEY_ID;
    if(!/^[a-z][a-z0-9_-]{2,31}$/.test(old)||old===keyId)
      throw Error('invalid historical key ID');
    keyRing.keys[old]=await secret('OX_R53_OLD_BACKUP_KEY_FILE',{hex:true});
  }
  const vault={
    directory:'/dev/null',
    projectId,manifestSha256:demand('OX_R53_SIGNED_MANIFEST_SHA256'),
    catalogKey,keyRing
  };
  const token=r47TenantToken(catalogKey,projectId);
  const allowSyntheticLoopback=process.env.OX_R53_LOOPBACK_TEST==='YES';
  const remote=createR48S3Transport({
    endpoint:demand('OX_R53_S3_ENDPOINT'),bucket:demand('OX_R53_S3_BUCKET'),
    region:demand('OX_R53_S3_REGION'),
    accessKey:demand('OX_R53_S3_ACCESS_KEY'),
    secretKey:demand('OX_R53_S3_SECRET_KEY'),
    projectPrefix:token+'/',allowSyntheticLoopback
  });
  const backupWitness=createR48WitnessClient({
    endpoint:demand('OX_R53_BACKUP_WITNESS_ENDPOINT'),
    token:await secret('OX_R53_BACKUP_WITNESS_TOKEN_FILE'),
    secret:backupWitnessKey,tenant:token,allowSyntheticLoopback
  });
  const deltaWitness=createR48WitnessClient({
    endpoint:demand('OX_R53_DELTA_WITNESS_ENDPOINT'),
    token:await secret('OX_R53_DELTA_WITNESS_TOKEN_FILE'),
    secret:incrementalWitnessKey,
    tenant:r53WitnessTenant(catalogKey,projectId),allowSyntheticLoopback
  });
  const baseline=await restoreR49Offline({
    vault,remote,witness:backupWitness,
    bundleDir:demand('OX_R53_SIGNED_BUNDLE_DIR'),
    trustedPublicKey:demand('OX_R53_TRUSTED_PUBLIC_KEY_FILE'),
    recoveryDirectory:demand('OX_R53_BASE_RECOVERY_DIR')
  });
  const restored=await restoreR53Incremental({
    baseRestoreReceipt:baseline,recoveryDirectory:demand('OX_R53_DELTA_RECOVERY_DIR'),
    vault,remote,witness:deltaWitness,deltaKey,
    baselineArchiveId:baseline.archiveId
  });
  process.stdout.write(JSON.stringify({
    format:'osmanx-r53-detached-recovery-v1',syntheticOnly:true,
    signedBaseReverified:baseline.catalogWitnessVerified&&baseline.objectLockVerified,
    incremental:restored,
    sourcePrimaryModified:false,productionCutoverAllowed:false
  },null,2)+'\n');
  for(const secret of [catalogKey,deltaKey,backupWitnessKey,incrementalWitnessKey,
    ...Object.values(keyRing.keys)])secret.fill(0);
}catch(e){
  // No env dump, bearer values, payment data or ciphertext in errors.
  process.stderr.write('R5.3 independent recovery rejected: '+
    String(e.message).slice(0,180)+'\n');
  process.exitCode=1;
}
