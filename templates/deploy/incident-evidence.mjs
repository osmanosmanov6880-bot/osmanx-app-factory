/** R3.7 privacy-safe incident handoff. The report contains only ALLOWLISTED
 * statuses, counts and release identity; never raw errors, paths, logs, URLs,
 * authorization values, host IDs, database rows, or environment secrets.
 * Offline by default; --live explicitly audits every public DNS A/AAAA target.
 * A local JSON checksum does NOT authenticate the author of this report. */
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectDeployment} from './doctor.mjs';
import {getUpgradeStatus} from './upgrade.mjs';
import {getRolloutReports} from './rollout-observe.mjs';
import {auditInstalledEdge} from './edge-audit.mjs';
import {saveFleetSnapshot} from './fleet-agent.mjs';

const allowedChecks=new Set(['inventory','publisher','secrets','backups','upgrade','docker','https']);
const allowedStatus=new Set(['pass','warning','fail']);
const allowedPhases=new Set(['preparing','stopped','database-backed-up','files-updated',
 'service-started','observing','activating','gateway-open','manual-review-required',
 'recovery-required','completed','completed-after-manual-review','rolled-back','recovered']);
function validDoctor(report){
 if(report?.format!=='osmanx-deployment-acceptance'||report.version!==1||
    !(report.projectId===null || /^[a-f0-9-]{36}$/i.test(report.projectId||''))||
    !(report.releaseSequence===null || Number.isSafeInteger(report.releaseSequence)&&report.releaseSequence>=0)||
    !Array.isArray(report.checks))throw Error('Unknown local deployment report');
 return report;
}
export async function collectIncidentEvidence({root,live=false,
  doctor=inspectDeployment,upgrades=getUpgradeStatus,rollouts=getRolloutReports,
  edge=auditInstalledEdge,now=new Date()}={}){
 if(!root||typeof live!=='boolean'||Number.isNaN(now?.getTime?.()))throw Error('Invalid incident evidence parameters');
 root=resolve(root);
 // Always perform doctor OFFLINE: no automatic Docker or network access.
 const report=validDoctor(await doctor({root,docker:false,live:false}));
 const checks={};
 for(const row of report.checks){
   if(allowedChecks.has(row?.id) && allowedStatus.has(row?.status)) checks[row.id]=row.status;
 }
 let upgrade,history,upgradeEvidenceValid=true,rolloutEvidenceValid=true;
 try{upgrade=await upgrades({root})}catch{upgradeEvidenceValid=false;upgrade={active:{phase:'unknown'}}}
 try{history=await rollouts({root,limit:1})}catch{rolloutEvidenceValid=false;history=[]}
 const active=upgrade?.active;
 const activePhase=allowedPhases.has(active?.phase)?active.phase:active?'unknown':null;
 const latest=Array.isArray(history)?history[0]:null;
 // Never copy raw journal, container IDs, shell commands, error text, or report details.
 const rollout=latest?{observedStable:latest.observedStable===true,
   samplesCompleted:Number.isSafeInteger(latest.samplesCompleted)?latest.samplesCompleted:null}:null;
 let edgeReport=null;
 if(live){
   if(!report.projectId || !Number.isSafeInteger(report.releaseSequence))
     throw Error('Cannot probe live edge when local release identity is invalid');
   const result=await edge(root,{live:true});
   if(result?.format!=='osmanx-public-edge-audit'||result.projectId!==report.projectId||
     result.releaseSequence!==report.releaseSequence)
     throw Error('Edge evidence does not match the installed project and release');
   edgeReport={targets:result.targets,verified:result.verified,ready:result.ready===true,
     checks:result.endpoints.map(x=>({family:x.family,ok:x.ok===true,errorCode:x.errorCode||null}))};
 }
 const blocked=Object.values(checks).includes('fail')||!!active||
   !upgradeEvidenceValid||!rolloutEvidenceValid||!report.projectId||
   !Number.isSafeInteger(report.releaseSequence)||!!(live&&edgeReport&&!edgeReport.ready);
 const result={format:'osmanx-incident-evidence',version:1,observedAt:now.toISOString(),
   projectId:report.projectId,releaseSequence:report.releaseSequence,
   checks,activeUpgradePhase:activePhase,rollout,
   evidenceIntegrity:upgradeEvidenceValid&&rolloutEvidenceValid?'ok':'incomplete',
   edge:edgeReport,liveProbesRequested:live,offlineOnly:!live,
   releaseAssessment:blocked?'blocked':'incomplete',
   // Passing offline checks never means a deployment is operational or secure.
   productionCertified:false,containsPersonalData:false,authorAuthenticityVerified:false};
 return result;
}
const main=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(main){
 process.umask(0o077);
 const args=process.argv.slice(2),value=key=>args.find(x=>x.startsWith('--'+key+'='))?.slice(key.length+3);
 const root=resolve(value('installed')||dirname(dirname(fileURLToPath(import.meta.url))));
 const out=value('out');
 if(!out){console.error('Usage: node deploy/incident-evidence.mjs --out=/private/report.json [--live] [--installed=/client/path]');process.exitCode=2}
 else collectIncidentEvidence({root,live:args.includes('--live')}).then(async r=>{
   await saveFleetSnapshot(out,r,{root});console.log(JSON.stringify({written:true,projectId:r.projectId,
     releaseSequence:r.releaseSequence,offlineOnly:r.offlineOnly,releaseAssessment:r.releaseAssessment}));
 }).catch(e=>{console.error('OSMANX INCIDENT: '+e.message);process.exitCode=1});
}
