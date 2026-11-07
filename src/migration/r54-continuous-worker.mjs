// R5.4: bounded CDC synchronization cycles; safe to invoke repeatedly from an
// isolated worker. Each batch is acknowledged only after S3 WORM and independent
// witness verification. Lag is reported as a count plus SQLite WRITE-TIME HINT,
// never as a measured production commit-to-recovery RPO.
import {readR53Committed} from './r53-commit-journal.mjs';
import {inspectR53WitnessedCheckpoint,publishR53Incremental,
  readR53AuthenticatedStream} from './r53-incremental.mjs';
import {r47TenantToken} from './r47-offsite.mjs';
import {withR54ExclusivePublisher} from './r54-publisher-lease.mjs';
const MAX_SEQ=30000;
function deny(ok,msg){if(!ok)throw Error('R5.4 continuous CDC refused: '+msg);}
function transient(e){
  const message=String(e?.code||'')+' '+String(e?.message||'');
  return /ECONNRESET|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|EHOSTUNREACH|EPIPE|socket hang up|timed out|GET status 50[0234]|PUT status 50[0234]|witness conflict 50[0234]/i.test(message);
}
function pause(ms,signal){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(Error('R5.4 CDC delivery aborted'));return;}
    const timer=setTimeout(done,ms);
    function done(){signal?.removeEventListener('abort',abort);resolve();}
    function abort(){
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      reject(Error('R5.4 CDC delivery aborted'));
    }
    signal?.addEventListener('abort',abort,{once:true});
  });
}
function localJournal(sourceDb,sequence){
  return readR53Committed(sourceDb,{
    afterSequence:sequence,limit:1,syntheticOnly:true
  });
}
function ageOfOldestHint(value,now){
  if(!value)return null;
  const at=Date.parse(value);
  deny(Number.isFinite(at)&&at<=now+60000,
    'SQLite write-time hint invalid or from the future');
  // Cannot treat the SQLite statement timestamp as commit acknowledgement.
  return Math.max(0,now-at);
}
export async function runR54SyncWindow({
  sourceDb,vault,remote,witness,deltaKey,baselineArchiveId,
  leaseDirectory,syntheticOnly=false,maxBatches=6,
  maxOutstandingEvents=0,maxWriteHintAgeMs=60000,
  maxRetries=2,retryBaseMs=75,now=()=>Date.now(),
  verifyFullHistory=false,signal
}={}){
  deny(syntheticOnly===true,'requires synthetic-only source and opt-in');
  deny(sourceDb&&typeof sourceDb.prepare==='function'&&
    vault?.projectId&&Buffer.isBuffer(vault.catalogKey)&&
    typeof now==='function','validated source and signed project required');
  deny(Number.isSafeInteger(maxBatches)&&maxBatches>=1&&maxBatches<=32&&
    Number.isSafeInteger(maxOutstandingEvents)&&maxOutstandingEvents>=0&&
    maxOutstandingEvents<=MAX_SEQ&&
    Number.isSafeInteger(maxWriteHintAgeMs)&&maxWriteHintAgeMs>=1000&&
    maxWriteHintAgeMs<=86400000&&
    Number.isSafeInteger(maxRetries)&&maxRetries>=0&&maxRetries<=5&&
    Number.isSafeInteger(retryBaseMs)&&retryBaseMs>=1&&retryBaseMs<=5000,
    'bounded retry, backlog and age budgets required');
  const tenantToken=r47TenantToken(vault.catalogKey,vault.projectId);
  return withR54ExclusivePublisher({
    directory:leaseDirectory,tenantToken,syntheticOnly:true
  },async()=>{
    const args={vault,remote,witness,deltaKey,baselineArchiveId};
    let checkpoint=await inspectR53WitnessedCheckpoint(args);
    const first=localJournal(sourceDb,checkpoint.coveredSequence);
    const firstObserved=first.latestCommittedSequence;
    let totalPublished=0,retryCount=0,completedBatches=0;
    for(let step=0;step<maxBatches;step++){
      if(signal?.aborted)throw Error('R5.4 CDC delivery aborted');
      const current=localJournal(sourceDb,checkpoint.coveredSequence);
      if(current.unappliedCount===0)break;
      let published;
      for(let attempt=0;;attempt++){
        try{
          published=await publishR53Incremental({sourceDb,...args});
          break;
        }catch(e){
          // Signature mismatch, orphan remote head, missing Object Lock,
          // corruption or a failed witness commit are NOT transient.
          if(!transient(e)||attempt>=maxRetries)throw e;
          retryCount++;
          await pause(Math.min(10000,retryBaseMs*2**attempt),signal);
        }
      }
      deny(published?.witnessVerified===true&&
        published.encryptedReadbackVerified===true&&
        published.everyUploadedVersionWormProtected===true&&
        Number.isSafeInteger(published.publishedEvents)&&published.publishedEvents>0,
        'remote/WORM acknowledgement missing after a nonempty journal batch');
      const verified=await inspectR53WitnessedCheckpoint(args);
      deny(verified.remoteWitnessVerified===true&&
        verified.coveredSequence===published.totalCommittedEvents&&
        verified.coveredSequence>checkpoint.coveredSequence,
        'published cursor differs from independent witness');
      totalPublished+=published.publishedEvents;
      completedBatches++;
      checkpoint=verified;
    }
    const after=localJournal(sourceDb,checkpoint.coveredSequence);
    deny(after.latestCommittedSequence>=firstObserved&&
      checkpoint.coveredSequence>=0&&checkpoint.coveredSequence<=after.latestCommittedSequence,
      'source journal regressed or witness cursor beyond primary');
    const measuredAt=now();
    deny(Number.isSafeInteger(measuredAt)&&measuredAt>0,'invalid observation clock');
    const oldestWriteHintAgeMs=ageOfOldestHint(after.oldestPendingWriteHint,measuredAt);
    const backlog=after.unappliedCount;
    const withinSequenceBudget=backlog<=maxOutstandingEvents;
    const withinWriteHintBudget=oldestWriteHintAgeMs===null||
      oldestWriteHintAgeMs<=maxWriteHintAgeMs;
    let fullHistoryAuthenticated=false;
    if(verifyFullHistory&&checkpoint.coveredSequence>0){
      const verified=await readR53AuthenticatedStream(args);
      deny(verified.authenticated===true&&
        verified.independentWitnessVerified===true&&
        verified.throughSequence===checkpoint.coveredSequence,
        'recovered incremental segments differ from current witness');
      fullHistoryAuthenticated=true;
    }
    return Object.freeze({
      format:'osmanx-r54-delivery-window-v1',
      syntheticOnly:true,
      initialSourceCommittedSequence:firstObserved,
      observedCommittedSequence:after.latestCommittedSequence,
      witnessedSequence:checkpoint.coveredSequence,
      publishedEvents:totalPublished,
      publishedBatches:completedBatches,
      retryCount,
      outstandingCommittedEvents:backlog,
      caughtUp:backlog===0,
      withinSequenceBudget,withinWriteHintBudget,
      oldestPendingWriteHintAgeMs,
      sqliteWriteTimeIsCommitAcknowledgement:false,
      realTransactionRpoSecondsMeasured:false,
      maximumRpoSecondsCertified:null,
      alertRequired:!withinSequenceBudget||!withinWriteHintBudget,
      independentWitnessVerified:checkpoint.remoteWitnessVerified,
      fullHistoryAuthenticated,
      distributedLockVerified:false,
      sourcePrimaryMutatedByPublisher:false,
      paymentExecutionPermitted:false,productionCutoverAllowed:false
    });
  });
}

// Cooperative process loop: callers own the process and must supply a signal.
// Each loop obtains a fresh local lease, verifies the remote witness again and
// resumes from its acknowledged cursor after a process restart.
export async function runR54PollingWorker({
  cycle,signal,intervalMs=1000,maxCycles=10,onCycle
}={}){
  deny(typeof cycle==='function'&&signal&&typeof signal.aborted==='boolean'&&
    Number.isSafeInteger(intervalMs)&&intervalMs>=25&&intervalMs<=60000&&
    Number.isSafeInteger(maxCycles)&&maxCycles>=1&&maxCycles<=10000,
    'bounded worker lifecycle and stop signal required');
  let completed=0,last=null;
  for(;completed<maxCycles&&!signal.aborted;){
    last=await cycle();
    deny(last?.format==='osmanx-r54-delivery-window-v1'&&
      last.productionCutoverAllowed===false,
      'worker received unverified CDC cycle outcome');
    completed++;
    if(onCycle)await onCycle(last);
    if(completed<maxCycles&&!signal.aborted){
      try{await pause(intervalMs,signal);}
      catch(e){if(signal.aborted)break;throw e;}
    }
  }
  return {format:'osmanx-r54-cooperative-worker-v1',
    completedCycles:completed,stoppedOnSignal:signal.aborted,
    lastWitnessedSequence:last?.witnessedSequence||0,
    lastKnownBacklog:last?.outstandingCommittedEvents??null,
    productionCutoverAllowed:false};
}
