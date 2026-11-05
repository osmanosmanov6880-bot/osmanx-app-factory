import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {collectIncidentEvidence} from '../templates/deploy/incident-evidence.mjs';
import {saveFleetSnapshot} from '../templates/deploy/fleet-agent.mjs';
const id=randomUUID(),token='SECRET_NEVER_SHOW_UP_IN_REPORT';
const doctor=async()=>({format:'osmanx-deployment-acceptance',version:1,projectId:id,releaseSequence:2,
  checks:[{id:'inventory',status:'pass',detail:token},{id:'backups',status:'warning',detail:token},
    {id:'docker',status:'warning',detail:token}],domain:'private.example.org'});
const upgrades=async()=>({active:{phase:'manual-review-required',lastError:token,backupId:token},history:[]});
const rollouts=async()=>[{observedStable:true,samplesCompleted:3,containerId:token,error:token}];
test('R3.7: offline incident evidence excludes private paths, raw errors and secrets',async()=>{
 const report=await collectIncidentEvidence({root:tmpdir(),doctor,upgrades,rollouts,edge:async()=>{throw Error('network forbidden')}});
 assert.equal(report.releaseAssessment,'blocked');assert.equal(report.offlineOnly,true);
 assert.equal(report.activeUpgradePhase,'manual-review-required');assert.equal(report.rollout.samplesCompleted,3);
 assert.equal(JSON.stringify(report).includes(token),false);
 assert.equal(JSON.stringify(report).includes('private.example'),false);
 assert.equal(report.productionCertified,false);
});
test('R3.7: live edge evidence needs matching project and release, but never copies raw IPs or responses',async()=>{
 const edge=async()=>({format:'osmanx-public-edge-audit',projectId:id,releaseSequence:2,targets:2,verified:1,ready:false,
   endpoints:[{family:4,ok:true,ip:token},{family:6,ok:false,errorCode:'TLS_CERTIFICATE_ERROR',details:token}]});
 const r=await collectIncidentEvidence({root:tmpdir(),doctor,upgrades:async()=>({active:null}),rollouts:async()=>[],edge,live:true});
 assert.equal(r.edge.ready,false);assert.equal(r.edge.verified,1);assert.equal(JSON.stringify(r).includes(token),false);
 await assert.rejects(collectIncidentEvidence({root:tmpdir(),doctor,upgrades:async()=>({active:null}),rollouts:async()=>[],edge:async()=>({...await edge(),releaseSequence:4}),live:true}),/does not match/);
});
test('R3.7: private evidence file is exclusive and cannot be stored inside the client installation',async()=>{
 const base=await mkdtemp(join(tmpdir(),'osmanx-r37-evidence-'));const root=join(base,'client');await mkdir(root);
 try{
  const packet=await collectIncidentEvidence({root,doctor,upgrades,rollouts});
  const file=join(base,'incident.json');await saveFleetSnapshot(file,packet,{root});
  const data=JSON.parse(await readFile(file,'utf8'));assert.equal(data.projectId,id);
  await assert.rejects(saveFleetSnapshot(file,packet,{root}),/EEXIST/);
  await assert.rejects(saveFleetSnapshot(join(root,'incident.json'),packet,{root}),/outside/);
 }finally{await rm(base,{recursive:true,force:true})}
});

test('R3.7: damaged local manifests and unreadable journals still produce a redacted BLOCKED incident record',async()=>{
 const brokenDoctor=async()=>({format:'osmanx-deployment-acceptance',version:1,projectId:null,releaseSequence:null,
   checks:[{id:'inventory',status:'fail',detail:token}]});
 const r=await collectIncidentEvidence({root:tmpdir(),doctor:brokenDoctor,
  upgrades:async()=>{throw Error(token)},rollouts:async()=>{throw Error(token)}});
 assert.equal(r.releaseAssessment,'blocked');assert.equal(r.evidenceIntegrity,'incomplete');
 assert.equal(r.projectId,null);assert.equal(JSON.stringify(r).includes(token),false);
 await assert.rejects(collectIncidentEvidence({root:tmpdir(),doctor:brokenDoctor,
  upgrades:async()=>({active:null}),rollouts:async()=>[],live:true}),/identity is invalid/);
});
