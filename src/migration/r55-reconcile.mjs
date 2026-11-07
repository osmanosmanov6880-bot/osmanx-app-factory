// R5.5 safe synthetic recovery of "S3 PUT succeeded but witness ACK lost".
// Never bless a remote unsigned/unwitnessed HEAD merely because it exists.
// For each event, compare authenticated WORM ciphertext to the local
// transactional SQLite journal; prove exactly the previously witnessed prefix
// hash, then atomically advance the independent monotonic witness.
import {isDeepStrictEqual} from 'node:util';
import {readR53Committed} from './r53-commit-journal.mjs';
import {inspectR53PendingCandidate,inspectR53WitnessedCheckpoint,
  publishR53Incremental} from './r53-incremental.mjs';

function deny(ok,msg){if(!ok)throw Error('R5.5 witness reconciliation refused: '+msg);}
export async function reconcileR55WitnessGap({
  sourceDb,vault,remote,witness,deltaKey,baselineArchiveId,
  fence,syntheticOnly=false
}={}){
  deny(syntheticOnly===true&&sourceDb?.prepare&&
    witness?.current&&witness?.commit&&witness?.verify&&
    fence?.assertCurrent,
    'synthetic SQLite journal, live distributed fence and independent witness required');
  await fence.assertCurrent();
  const args={vault,remote,witness,deltaKey,baselineArchiveId};
  const original=await witness.current();
  const candidate=await inspectR53PendingCandidate(args);
  if(!candidate){
    deny(!original,'monotonic witness exists but remote head was deleted');
    return {format:'osmanx-r55-reconciliation-v1',syntheticOnly:true,
      recoveredOrphan:false,alreadyWitnessed:false,
      recoveredEvents:0,lastWitnessedSequence:0,
      noUnwitnessedPointer:true,productionCutoverAllowed:false};
  }
  deny(candidate.s3VersionedComplianceVerified===true&&
    candidate.recoverableOnlyAfterPrimaryAndWitnessComparison===true&&
    candidate.events.length===candidate.lastSequence&&
    candidate.events.length<=30000,
    'candidate is not complete encrypted/WORM history');
  if(original){
    deny(original.manifestSha256===candidate.manifestSha256&&
      original.entries<=candidate.lastSequence,
      'existing independent witness is newer or bound to another manifest');
    if(original.entries===candidate.lastSequence){
      deny(original.catalogSha256===candidate.headSha256,
        'existing witnessed head differs from remote signed content');
      await witness.verify({catalogSha256:candidate.headSha256,
        manifestSha256:candidate.manifestSha256,entries:candidate.lastSequence});
      return {format:'osmanx-r55-reconciliation-v1',syntheticOnly:true,
        recoveredOrphan:false,alreadyWitnessed:true,recoveredEvents:0,
        lastWitnessedSequence:original.entries,productionCutoverAllowed:false};
    }
    deny(candidate.anchors.some(item=>
      item.throughSequence===original.entries&&
      item.catalogSha256===original.catalogSha256),
      'candidate stream does not extend the independently witnessed predecessor');
  }
  // Compare every captured row/operation, not merely the number of events.
  // The journal verifies exact trigger SQL, all rows, and no sequence gaps.
  let cursor=0,matched=0;
  while(cursor<candidate.lastSequence){
    const page=readR53Committed(sourceDb,{
      afterSequence:cursor,limit:250,syntheticOnly:true});
    const next=Math.min(candidate.lastSequence,cursor+250);
    deny(page.events.length>=next-cursor&&page.latestCommittedSequence>=candidate.lastSequence,
      'source journal does not contain all remote candidate commits');
    for(let idx=cursor;idx<next;idx++){
      const local=page.events[idx-cursor],offsite=candidate.events[idx];
      deny(local?.seq===idx+1&&isDeepStrictEqual(local,offsite),
        'encrypted candidate event does not match locally committed CRM row');
      matched++;
    }
    cursor=next;
  }
  await fence.assertCurrent();
  // Re-check the latest provider object immediately before advancing witness.
  // A signed pointer changed by another fenced publisher must never be blessed.
  const fresh=await inspectR53PendingCandidate(args);
  deny(fresh?.headSha256===candidate.headSha256&&
    fresh.lastSequence===candidate.lastSequence,
    'unwitnessed S3 HEAD changed while proof was being assembled');
  await fence.assertCurrent();
  // If a prior request succeeded but its HTTP response was lost, R4.8
  // witness.commit is idempotent for this exact (sequence,digest) pair.
  await witness.commit({catalogSha256:candidate.headSha256,
    manifestSha256:candidate.manifestSha256,entries:candidate.lastSequence});
  await witness.verify({catalogSha256:candidate.headSha256,
    manifestSha256:candidate.manifestSha256,entries:candidate.lastSequence});
  return {format:'osmanx-r55-reconciliation-v1',syntheticOnly:true,
    recoveredOrphan:true,alreadyWitnessed:false,
    recoveredEvents:matched,lastWitnessedSequence:candidate.lastSequence,
    historicalWitnessPrefixVerified:Boolean(original),
    authenticatedS3AndLocalEventsCompared:true,
    productionCutoverAllowed:false};
}

export async function runR55FencedPublisher({
  authority,holder,ttlMs=20000,
  sourceDb,vault,remote,witness,deltaKey,baselineArchiveId,
  syntheticOnly=false
}={}){
  deny(syntheticOnly===true&&authority?.acquire&&
    authority?.renew&&authority?.assertCurrent&&authority?.release,
    'independent authenticated fencing authority and explicit synthetic mode required');
  let lease=await authority.acquire(holder,{ttlMs}),error=null;
  const fence={assertCurrent:async()=>{
    // Renew before every irreversible pointer operation. A lost lease causes
    // denial; it cannot be silently inherited by another process.
    lease=await authority.renew(lease,{ttlMs});
    return authority.assertCurrent(lease);
  }};
  try{
    const args={sourceDb,vault,remote,witness,deltaKey,baselineArchiveId};
    const reconciliation=await reconcileR55WitnessGap({
      ...args,fence,syntheticOnly:true});
    await fence.assertCurrent();
    const published=await publishR53Incremental({
      ...args,publishFence:fence
    });
    await fence.assertCurrent();
    const checkpoint=await inspectR53WitnessedCheckpoint(args);
    deny(checkpoint.coveredSequence===published.totalCommittedEvents&&
      checkpoint.remoteWitnessVerified===(published.totalCommittedEvents>0),
      'conditional S3 pointer differs from independent committed witness');
    return {format:'osmanx-r55-fenced-publish-v1',
      syntheticOnly:true,fencingEpoch:lease.epoch,
      remoteFencingVerified:true,
      conditionalS3HeadRequired:true,
      reconciliation,publishedEvents:published.publishedEvents,
      checkpointSequence:checkpoint.coveredSequence,
      independentWitnessVerified:checkpoint.remoteWitnessVerified,
      distributedAtomicObjectWriteVerified:false,
      productionCutoverAllowed:false};
  }catch(e){error=e;throw e;}
  finally{
    try{await authority.release(lease);}
    catch(releaseError){if(!error)throw releaseError;}
  }
}
