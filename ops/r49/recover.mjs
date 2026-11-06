// Operator-only recovery on a DIFFERENT host. Writes an isolated new file.
// Will not open/overwrite the production SQLite or change its settings.
import {createR48S3Transport} from '../../src/migration/r48-s3.mjs';
import {createR48WitnessClient} from '../../src/migration/r48-witness.mjs';
import {r47TenantToken} from '../../src/migration/r47-offsite.mjs';
import {restoreR49Offline} from '../../src/migration/r49-operational-dr.mjs';
function demand(name){const v=process.env[name];if(!v)throw Error(name+' is required');return v;}
function hex(name){const v=demand(name);if(!/^[a-fA-F0-9]{64}$/.test(v))throw Error(name+' must be 32-byte hex');return Buffer.from(v,'hex');}
if(process.env.OX_R49_OFFLINE_DR_SYNTHETIC!=='YES'||process.env.OX_R40_EPHEMERAL!=='YES')
  throw Error('R4.9 only runs on isolated synthetic fixtures until operational approval');
const projectId=demand('OX_R49_PROJECT_ID');
if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(projectId))
  throw Error('invalid signed CRM project ID');
const catalogKey=hex('OX_R49_CATALOG_HMAC_KEY_HEX');
const keyId=demand('OX_R49_BACKUP_KEY_ID'),keyRing={activeId:keyId,keys:{[keyId]:hex('OX_R49_BACKUP_KEY_HEX')}};
if(process.env.OX_R49_OLD_BACKUP_KEY_ID){
  keyRing.keys[process.env.OX_R49_OLD_BACKUP_KEY_ID]=hex('OX_R49_OLD_BACKUP_KEY_HEX');
}
const token=r47TenantToken(catalogKey,projectId);
const syntheticLoopback=process.env.OX_R49_LOOPBACK_TEST==='YES';
const vault={
  directory:'/dev/null', // intentionally no source-disk dependency
  projectId,manifestSha256:demand('OX_R49_SIGNED_MANIFEST_SHA256'),
  catalogKey,keyRing
};
const remote=createR48S3Transport({
  endpoint:demand('OX_R49_S3_ENDPOINT'),bucket:demand('OX_R49_S3_BUCKET'),
  region:demand('OX_R49_S3_REGION'),accessKey:demand('OX_R49_S3_ACCESS_KEY'),
  secretKey:demand('OX_R49_S3_SECRET_KEY'),projectPrefix:token+'/',
  allowSyntheticLoopback:syntheticLoopback
});
const witness=createR48WitnessClient({
  endpoint:demand('OX_R49_WITNESS_ENDPOINT'),token:demand('OX_R49_WITNESS_TOKEN'),
  secret:hex('OX_R49_WITNESS_KEY_HEX'),tenant:token,
  allowSyntheticLoopback:syntheticLoopback
});
try{
  const result=await restoreR49Offline({
    vault,remote,witness,bundleDir:demand('OX_R49_SIGNED_BUNDLE_DIR'),
    trustedPublicKey:demand('OX_R49_TRUSTED_PUBLIC_KEY_FILE'),
    recoveryDirectory:demand('OX_R49_RECOVERY_DIR')
  });
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(e){
  process.stderr.write('R4.9 isolated recovery failed: '+String(e.message).slice(0,200)+'\n');
  process.exitCode=1;
}
