// R6.4: verified disposable standby REBUILD after promoted PG primary.
// Never restart an old primary in place; rebuild from a NEW basebackup.
// All authority to modify production nodes remains explicitly false.
import {assessR63PgTimelineRejoin}
  from './r63-timeline-rejoin.mjs';
const TENANT=/^[a-f0-9]{24}$/,NODE=/^[a-z][a-z0-9-]{2,48}$/,
  SYS=/^[0-9]{10,32}$/,LSN=/^[0-9A-F]+\/[0-9A-F]+$/;
function deny(ok,reason){if(!ok)throw Error('R6.4 rebootstrap refused: '+reason);}
export function inspectR64ReplicaRebootstrap({
  tenantId,oldPrimarySnapshot,selectedPrimarySnapshot,
  requiredSystemId,oldPrimaryRunning,
  rebuiltReplica,sourceProbeHash,replicaProbeHash,
  now=()=>Date.now()
}={}){
  deny(TENANT.test(tenantId||'')&&
    typeof oldPrimaryRunning==='boolean'&&
    rebuiltReplica&&NODE.test(rebuiltReplica.nodeId||'')&&
    typeof rebuiltReplica.inRecovery==='boolean'&&
    SYS.test(String(rebuiltReplica.systemId||''))&&
    Number.isSafeInteger(rebuiltReplica.timeline)&&
    rebuiltReplica.timeline>=1&&
    LSN.test(rebuiltReplica.replayLsn||'')&&
    /^[a-f0-9]{64}$/.test(sourceProbeHash||'')&&
    /^[a-f0-9]{64}$/.test(replicaProbeHash||''),
    'pinned old primary state and separate replayed replica evidence required');
  const fork=assessR63PgTimelineRejoin({
    oldPrimary:oldPrimarySnapshot,
    selectedPrimary:selectedPrimarySnapshot,
    requiredSystemId,now
  });
  deny(rebuiltReplica.nodeId!==oldPrimarySnapshot.nodeId&&
    rebuiltReplica.nodeId!==selectedPrimarySnapshot.nodeId,
    'a new disposable replica identity is mandatory');
  const oldOff=oldPrimaryRunning===false;
  const rightBranch=fork.classification==='old-primary-timeline-stale'&&
    fork.newTimelineVerified===true&&
    rebuiltReplica.timeline===selectedPrimarySnapshot.timelineId&&
    rebuiltReplica.systemId===requiredSystemId&&
    rebuiltReplica.inRecovery===true;
  const matches=sourceProbeHash===replicaProbeHash;
  const classification=!oldOff?'old-primary-still-active':
    !rightBranch?'wrong-replica-lineage':
    !matches?'new-replica-replay-mismatch':
    'isolated-rebootstrap-demonstrated';
  return Object.freeze({
    format:'osmanx-r64-rebootstrap-review-v1',tenantId,
    sourceSystemId:requiredSystemId,
    selectedPrimaryTimeline:selectedPrimarySnapshot.timelineId,
    replayedStandbyTimeline:rebuiltReplica.timeline,
    formerPrimaryReportedStopped:oldOff,
    selectedPrimaryHadSuccessorTimeline:fork.newTimelineVerified,
    rebuiltNodeInRecovery:rebuiltReplica.inRecovery,
    committedProbeReplayed:matches,
    classification,
    oldPrimaryIsolationExternallyCertified:false,
    independentPowerFenceVerified:false,
    labRebootstrapEvidenceComplete:classification==='isolated-rebootstrap-demonstrated',
    mayRestartOldPrimary:false,mayClearOldQuarantine:false,
    mayRunPgRewind:false,automaticFailbackAllowed:false,
    mayPromoteReplica:false,productionCutoverAllowed:false
  });
}
