// R4.9: require actual S3 COMPLIANCE-protected object versions before
// committing the independent witness. Offline recovery never needs the
// original vault disk, but never overwrites a running database.
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {lstatSync} from 'node:fs';
import {open,mkdir,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {listR46Vault} from './r46-vault.mjs';
import {synchronizeR47Offsite,readR47SignedRemoteHead,recoverR47Offsite} from './r47-offsite.mjs';
import {verifyTrustedMigration} from './pg-trust.mjs';
import {verifyR45SignedSnapshot} from './r45-restore-drill.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function guard(ok,msg){if(!ok)throw Error('R4.9 independent DR refused: '+msg);}
function requirements({vault,remote,witness}={}){
  guard(vault&&UUID.test(vault.projectId)&&
    remote&&typeof remote.inspectR49Worm==='function'&&typeof remote.get==='function'&&
    witness&&typeof witness.commit==='function'&&typeof witness.verify==='function',
    'signed S3 WORM vault and external witness required');
}
async function wormAudit(remote,ids,catalogSha256,{minRemainingMinutes=5}={}){
  let checked=0;
  for(const id of ids){
    const result=await remote.inspectR49Worm('archives/'+id+'.oxb',{minRemainingMinutes});
    guard(result.objectLockVerified&&result.versioned&&result.retentionMode==='COMPLIANCE',
      'archive object lacks WORM proof');checked++;
  }
  for(const key of ['catalog/'+catalogSha256+'.jsonl','head.json']){
    const result=await remote.inspectR49Worm(key,{minRemainingMinutes});
    guard(result.objectLockVerified&&result.versioned,'control object lacks WORM proof');
    checked++;
  }
  return checked;
}
export async function publishR49IndependentlyLockedBackup(input,{minRemainingMinutes=5}={}){
  requirements(input);
  const {vault,remote,witness}=input;
  // All local artifacts are authenticated against the R4.6 signed catalog.
  const local=await listR46Vault(vault);
  guard(local.activeCount>0,'nothing signed to upload');
  await remote.assertBucketControls();
  const published=await synchronizeR47Offsite({vault,remote});
  const head=await readR47SignedRemoteHead({vault,remote});
  guard(head.catalogSha256===published.remoteCatalogSha256,
    'remote catalog changed during the S3 publication');
  const protectedObjects=await wormAudit(remote,local.archives.map(x=>x.id),
    head.catalogSha256,{minRemainingMinutes});
  // Only after S3 confirms immutable object VERSIONS do we advance the witness.
  await witness.commit(head);
  const confirmed=await witness.verify(head);
  guard(confirmed.anchorVerified,'independent witness failed');
  return {format:'osmanx-r49-worm-witness-v1',syntheticOnly:true,
    s3ComplianceObjectVersionsVerified:protectedObjects,
    independentWitnessVerified:true,encryptedReadbackVerified:true,
    catalogSha256:head.catalogSha256,remoteArchives:local.activeCount,
    productionCutoverAllowed:false};
}
export async function restoreR49Offline({
  vault,remote,witness,bundleDir,trustedPublicKey,recoveryDirectory,
  minRemainingMinutes=5
}={}){
  requirements({vault,remote,witness});
  guard(typeof bundleDir==='string'&&typeof trustedPublicKey==='string',
    'signed migration export and trusted key paths required');
  guard(typeof recoveryDirectory==='string'&&recoveryDirectory.startsWith('/'),
    'absolute private recovery path required');
  const destinationDir=resolve(recoveryDirectory);
  await mkdir(destinationDir,{recursive:true,mode:0o700});
  const stat=lstatSync(destinationDir);
  guard(stat.isDirectory()&&!stat.isSymbolicLink()&&
    (process.platform==='win32'||(stat.mode&0o077)===0),
    'recovery directory must be private 0700');
  const {manifest,manifestSha256}=await verifyTrustedMigration(bundleDir,trustedPublicKey);
  guard(manifestSha256===vault.manifestSha256,'migration manifest changed');
  const entry=manifest.databases.find(x=>x.projectId===vault.projectId);
  guard(entry?.role==='crm'&&entry.schema==='ox_p_'+vault.projectId.replaceAll('-',''),
    'signed project CRM inventory required');
  const started=performance.now();
  const head=await readR47SignedRemoteHead({vault,remote});
  await witness.verify(head); // fails closed on old valid remote pointer
  const recovered=await recoverR47Offsite({vault,remote});
  let created=false,path=null;
  try{
    const key='archives/'+recovered.archiveId+'.oxb';
    const protectedVersions=await wormAudit(remote,[recovered.archiveId],
      head.catalogSha256,{minRemainingMinutes});
    guard(protectedVersions===3,'missing immutable source proof');
    const filename='recovered-'+vault.projectId+'-'+randomBytes(12).toString('hex')+'.sqlite';
    path=join(destinationDir,filename);
    let file;try{
      file=await open(path,'wx',0o600);created=true;
      await file.writeFile(recovered.plaintext);await file.sync();
    }finally{await file?.close();}
    const db=new DatabaseSync(path,{readOnly:true});
    let validated;try{validated=verifyR45SignedSnapshot(db,entry,{secret:vault.catalogKey});}
    finally{db.close();}
    guard(validated.semantic.ok===true&&
      validated.semantic.paymentWritesPermitted===false,
      'recovered CRM failed payment integrity');
    return {format:'osmanx-r49-offline-dr-v1',syntheticOnly:true,
      outputFile:path,archiveId:recovered.archiveId,
      catalogWitnessVerified:true,objectLockVerified:true,
      signedTablesVerified:validated.signedTablesVerified,
      financialRecords:validated.semantic.financial.records,
      financialTotalsHmac:validated.semantic.financial.financialTotalsHmac,
      measuredRecoveryMs:Math.round(performance.now()-started),
      readOnlySource:true,productionCutoverAllowed:false};
  }catch(e){
    if(created&&path)await unlink(path).catch(()=>{});
    throw e;
  }finally{recovered.plaintext.fill(0);}
}
