// R5.8 disposable-bucket negative IAM probe. Requires two actually distinct
// S3 credentials configured at the provider, not just local wrapper policies.
// Always refuse if the supplied project prefix might contain live data.
import {createHash,randomBytes} from 'node:crypto';
const HEAD='r53/head.json',TENANT=/^[a-f0-9]{24}$/;
function deny(ok,reason){if(!ok)throw Error('R5.8 provider IAM verification refused: '+reason);}
function sha(b){return createHash('sha256').update(b).digest('hex');}
function deniedByProvider(error){
  const message=String(error?.message||'');
  // R4.8 wraps provider status. CAS conflicts 409/412 are NEVER treated as
  // proof of IAM denial; only a provider-level authorization rejection is.
  return /R4\.8 S3 denied: PUT status 403$/.test(message);
}
async function expectDenied(callback,label){
  let denied=false;
  try{await callback();}
  catch(e){if(deniedByProvider(e))denied=true;else throw e;}
  deny(denied,label+' not denied by S3 provider with status 403');
}
export async function attestR58ProviderRoleIsolation({
  tenantId,workerTransport,coordinatorTransport,syntheticOnly=false,
  disposableBucketConfirmed=false
}={}){
  deny(syntheticOnly===true&&disposableBucketConfirmed===true&&
    TENANT.test(tenantId||'')&&
    workerTransport?.tenantPrefix===tenantId+'/'&&
    coordinatorTransport?.tenantPrefix===tenantId+'/'&&
    workerTransport!==coordinatorTransport&&
    workerTransport.put&&workerTransport.getWithMetadata&&
    coordinatorTransport.put&&coordinatorTransport.getWithMetadata,
    'separate real S3 clients, unique disposable prefix and explicit test authorization required');
  const [a,b]=await Promise.all([
    workerTransport.assertBucketControls(),
    coordinatorTransport.assertBucketControls()
  ]);
  deny(a?.objectLockEnabled&&a?.versioningEnabled&&
    b?.objectLockEnabled&&b?.versioningEnabled,
    'versioning and object locking mandatory for both credentials');
  // Guarantee the isolated HEAD is fresh. Do not modify a live tenant.
  try{
    await coordinatorTransport.getWithMetadata(HEAD);
    throw Error('R5.8 provider IAM verification refused: existing HEAD: not disposable');
  }catch(e){
    if(!/R4\.8 S3 denied: GET status 404$/.test(String(e.message)))throw e;
  }
  const stamp=randomBytes(16);
  const deniedHead=Buffer.from('ox-r58-negative-'+stamp.toString('hex'));
  await expectDenied(()=>workerTransport.put(HEAD,deniedHead,{ifNoneMatch:true}),
    'worker conditional pointer PUT');
  const segmentKey='r53/segments/'+sha(stamp)+'.oxd';
  await expectDenied(()=>coordinatorTransport.put(segmentKey,stamp),
    'coordinator immutable segment PUT');
  await workerTransport.put(segmentKey,stamp);
  const segmentProof=await workerTransport.inspectR49Worm(segmentKey);
  deny(segmentProof?.objectLockVerified===true&&
    segmentProof.retentionMode==='COMPLIANCE',
    'worker immutable segment not WORM-protected');
  const head=Buffer.from('R58 synthetic-only signed checkpoint '+stamp.toString('hex'));
  await coordinatorTransport.put(HEAD,head,{ifNoneMatch:true});
  const posted=await coordinatorTransport.getWithMetadata(HEAD);
  deny(sha(posted.body)===sha(head)&&posted.versionId,
    'coordinator HEAD bytes or version mismatch');
  const proof=await coordinatorTransport.inspectR49Worm(HEAD);
  deny(proof.objectLockVerified===true&&
    proof.retentionMode==='COMPLIANCE'&&proof.versionId===posted.versionId,
    'coordinator pointer version not retained');
  return Object.freeze({
    format:'osmanx-r58-provider-iam-verification-v1',
    workerDeniedHeadPut403:true,coordinatorDeniedSegmentPut403:true,
    workerWormSegmentPut:true,coordinatorConditionalHeadPut:true,
    independentCredentialsProvenByNegativeProviderCalls:true,
    syntheticOnly:true,productionCutoverAllowed:false
  });
}
