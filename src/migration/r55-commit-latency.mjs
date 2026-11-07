// R5.5 synthetic same-process monotonic observations.
// Measures wall elapsed between a *local SQLite COMMIT having returned*
// and a remote independent witness verification. It is NOT production RPO;
// a primary machine crash before publishing would still lose the backlog.
import {performance} from 'node:perf_hooks';
import {readR53Committed} from './r53-commit-journal.mjs';
function deny(ok,msg){if(!ok)throw Error('R5.5 commit-to-witness measurement refused: '+msg);}
const VERSION='osmanx-r55-commit-ack-lag-v1';
function validateClock(nowWall,nowMono){
  const wall=nowWall(),mono=nowMono();
  deny(Number.isSafeInteger(wall)&&wall>0&&
    Number.isFinite(mono)&&mono>=0,
    'invalid same-process monotonic observation clock');
  return {wall,mono};
}
export function commitR55SyntheticTransaction({
  sourceDb,transaction,syntheticOnly=false,
  nowWall=()=>Date.now(),nowMonotonic=()=>performance.now()
}={}){
  deny(syntheticOnly===true&&sourceDb?.prepare&&
    typeof transaction==='function'&&typeof nowWall==='function'&&
    typeof nowMonotonic==='function',
    'isolated SQLite source and synchronous transaction callback required');
  const initial=readR53Committed(sourceDb,{limit:1,syntheticOnly:true});
  const start=validateClock(nowWall,nowMonotonic);
  deny(sourceDb.isTransaction===false,'source already in transaction');
  sourceDb.exec('BEGIN IMMEDIATE');
  try{
    const result=transaction(sourceDb);
    deny(!result||typeof result.then!=='function',
      'cannot leave local SQLite transaction pending across an await');
    sourceDb.exec('COMMIT');
  }catch(e){if(sourceDb.isTransaction)sourceDb.exec('ROLLBACK');throw e;}
  const confirmed=validateClock(nowWall,nowMonotonic);
  const latest=readR53Committed(sourceDb,{limit:1,syntheticOnly:true});
  deny(latest.latestCommittedSequence>initial.latestCommittedSequence,
    'business operation did not produce committed captured changes');
  deny(confirmed.mono>=start.mono,
    'monotonic clock reversed between BEGIN and COMMIT acknowledgement');
  return Object.freeze({
    format:VERSION,syntheticOnly:true,
    firstCoveredSequence:initial.latestCommittedSequence+1,
    acknowledgedSequence:latest.latestCommittedSequence,
    commitAcknowledgedAtWallMs:confirmed.wall,
    commitAcknowledgedAtMonotonicMs:confirmed.mono,
    localTransactionDurationMs:Math.round(confirmed.mono-start.mono),
    sqliteFsyncDurabilityIndependentlyVerified:false,
    acknowledgmentIsDurableRemoteReplication:false,
    productionCutoverAllowed:false
  });
}
export function measureR55SyntheticWitnessDelay({
  marker,publication,nowMonotonic=()=>performance.now(),
  syntheticOnly=false
}={}){
  deny(syntheticOnly===true&&marker?.format===VERSION&&
    marker.syntheticOnly===true&&marker.productionCutoverAllowed===false&&
    publication?.format==='osmanx-r55-fenced-publish-v1'&&
    publication.syntheticOnly===true&&
    publication.remoteFencingVerified===true&&
    publication.independentWitnessVerified===true&&
    publication.conditionalS3HeadRequired===true&&
    publication.checkpointSequence>=marker.acknowledgedSequence&&
    publication.productionCutoverAllowed===false&&
    typeof nowMonotonic==='function',
    'a real independently witnessed, fenced checkpoint covering this COMMIT is required');
  const end=nowMonotonic();
  deny(Number.isFinite(end)&&end>=marker.commitAcknowledgedAtMonotonicMs&&
    end-marker.commitAcknowledgedAtMonotonicMs<=3600000,
    'same process monotonic interval unavailable or outside test bounds');
  const observed=Math.round((end-marker.commitAcknowledgedAtMonotonicMs)*1000)/1000;
  return Object.freeze({
    format:'osmanx-r55-synthetic-publish-delay-v1',
    syntheticOnly:true,
    acknowledgedSequence:marker.acknowledgedSequence,
    witnessedSequence:publication.checkpointSequence,
    observedCommitResponseToVerifiedWitnessMs:observed,
    clock:'single-process-monotonic',
    requestCompletionNotActualDatabaseDiskFsync:true,
    realTransactionRpoSecondsMeasured:false,
    zeroRpoCertified:false,
    primaryCrashWindowNotEliminated:true,
    productionCutoverAllowed:false
  });
}
export function summarizeR55SyntheticDelays(samples,{maxObservedMs=30000}={}){
  deny(Array.isArray(samples)&&samples.length>=1&&samples.length<=500&&
    Number.isSafeInteger(maxObservedMs)&&maxObservedMs>=1&&maxObservedMs<=3600000&&
    samples.every(x=>x?.format==='osmanx-r55-synthetic-publish-delay-v1'&&
      x.syntheticOnly===true&&x.productionCutoverAllowed===false&&
      Number.isFinite(x.observedCommitResponseToVerifiedWitnessMs)&&
      x.observedCommitResponseToVerifiedWitnessMs>=0),
    'complete same-process synthetic samples required');
  const durations=samples.map(x=>x.observedCommitResponseToVerifiedWitnessMs)
    .sort((a,b)=>a-b);
  const percentile=q=>durations[Math.ceil(durations.length*q)-1];
  return {
    format:'osmanx-r55-synthetic-latency-summary-v1',
    sampleCount:durations.length,
    minimumMs:durations[0],
    medianMs:percentile(0.5),
    p95Ms:percentile(0.95),
    maximumMs:durations.at(-1),
    observedBudgetMet:durations.at(-1)<=maxObservedMs,
    realTransactionRpoSecondsMeasured:false,
    reliabilityAcrossHostCrashNotVerified:true,
    zeroRpoCertified:false,
    productionCutoverAllowed:false
  };
}
