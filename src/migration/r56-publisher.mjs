// R5.6 opt-in isolated coordinator-backed publishing.
// Same-process coordinator owns S3 mutable pointer writes and serializes lease.
// This remains a synthetic-only demonstration, not multi-process HA.
import {publishR53Incremental,inspectR53WitnessedCheckpoint} from './r53-incremental.mjs';
import {reconcileR55WitnessGap} from './r55-reconcile.mjs';

function deny(ok,reason){if(!ok)throw Error('R5.6 orchestrator refused: '+reason);}
export async function runR56CoordinatorPublisher({
  coordinator,holder,tenant,ttlMs=20000,sourceDb,vault,remote,
  witness,deltaKey,baselineArchiveId,syntheticOnly=false
}={}){
  deny(syntheticOnly===true&&coordinator?.syntheticOnly===true&&
    coordinator?.acquire&&coordinator?.renew&&coordinator?.publish&&
    coordinator?.recover&&coordinator?.release&&
    remote?.getWithMetadata&&witness?.verify,
    'isolated synthetic coordinator and authenticated offsite witness required');
  // Investigate incomplete prior PUT before allocating the next lease.
  await coordinator.recover(tenant);
  let lease=await coordinator.acquire({tenant,holder,ttlMs}),error;
  const fence={
    assertCurrent:async()=>{
      lease=await coordinator.renew(lease,ttlMs);
      return coordinator.assertCurrent(lease);
    },
    publishPointer:async(body,conditions)=>{
      await fence.assertCurrent();
      return coordinator.publish({lease,body,...conditions});
    }
  };
  try{
    const args={sourceDb,vault,remote,witness,deltaKey,baselineArchiveId};
    const reconciliation=await reconcileR55WitnessGap({
      ...args,fence,syntheticOnly:true});
    const published=await publishR53Incremental({...args,publishFence:fence});
    const verified=await inspectR53WitnessedCheckpoint(args);
    deny(verified.coveredSequence===published.totalCommittedEvents&&
      verified.remoteWitnessVerified===(published.totalCommittedEvents>0),
      'remote witnessed checkpoint inconsistent with SQLite');
    return {format:'ox-r56-coordinated-ckpt-v1',syntheticOnly:true,
      coordinatorOwnedPointerWrite:true,
      processCrashRecoveryRequired:true,
      fencingEpoch:lease.epoch,publishedEvents:published.publishedEvents,
      checkpointSequence:verified.coveredSequence,
      independentWitnessVerified:verified.remoteWitnessVerified,
      productionCutoverAllowed:false,reconciliation};
  }catch(e){error=e;throw e;}
  finally{
    try{await coordinator.release(lease);}
    catch(e){if(!error)throw e;}
  }
}
