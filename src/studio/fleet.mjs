/** R3.4: signed, manually imported, tenant-isolated client health snapshots. */
import {createPublicKey, createHash, verify} from 'node:crypto';
import {bad} from '../common/http.mjs';
import {withTransaction} from '../common/db.mjs';

const CHECKS=['inventory','publisher','secrets','backups','upgrade','docker','https'];
const REQUESTED=['docker','https'];
const VALID=new Set(['pass','warning','fail']);
const fields=(obj,list)=>obj && typeof obj==='object' && !Array.isArray(obj) &&
 Object.keys(obj).length===list.length && Object.keys(obj).every(x=>list.includes(x));
const fp=key=>createHash('sha256').update((key?.type==='public'?key:createPublicKey(key)).export({format:'der',type:'spki'})).digest('hex');
const iso=x=>{if(typeof x!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x))return false;const date=new Date(x);return Number.isFinite(date.getTime())&&date.toISOString()===x;};

export function parseFleetPublicKey(publicKeyPem){
 if(typeof publicKeyPem!=='string'||publicKeyPem.length>2500||publicKeyPem.length<100)bad(400,'Invalid fleet public key');
 try {
  const key=createPublicKey(publicKeyPem);
  if(key.asymmetricKeyType!=='ed25519')bad(400,'Only Ed25519 public keys are accepted');
  const canonical=key.export({format:'pem',type:'spki'}).toString();
  if(!publicKeyPem.trim().startsWith('-----BEGIN PUBLIC KEY-----'))bad(400,'Expected public key PEM');
  return {publicKeyPem:canonical,fingerprint:fp(key)};
 } catch(e){if(e.status)throw e;bad(400,'Invalid Ed25519 public key')}
}
export function validateFleetEnvelope(packet, publicKeyPem, expectedProjectId, currentMs=Date.now()){
 if(!fields(packet,['payload','signature','algorithm','keyFingerprint'])||packet.algorithm!=='Ed25519')bad(422,'Invalid signed fleet report');
 const p=packet.payload;
 const v1=p?.version===1;const v2=p?.version===2;const v3=p?.version===3;
 const required=['format','version','projectId','service','releaseSequence','observedAt','nonce','offlineOnly','checks'];
 if(!fields(p,v3?[...required,'requestedChecks','requestedTelemetry','telemetry']:v2?[...required,'requestedChecks']:required)||(!v1&&!v2&&!v3)||
   p.format!=='osmanx-fleet-status'||p.projectId!==expectedProjectId||
   !['crm','site'].includes(p.service)||!Number.isSafeInteger(p.releaseSequence)||p.releaseSequence<0||
   !iso(p.observedAt)||!(/^[0-9a-f]{32}$/.test(p.nonce)))bad(422,'Invalid fleet report identity');
 if(!fields(p.checks,CHECKS)||CHECKS.some(id=>!VALID.has(p.checks[id])))bad(422,'Invalid fleet diagnostic checks');
 if(v1 && (p.offlineOnly!==true||p.checks.docker!=='warning'||p.checks.https!=='warning'))bad(422,'Invalid offline fleet report');
 if(v2||v3){
  const r=p.requestedChecks;
  if(!fields(r,REQUESTED)||typeof r.docker!=='boolean'||typeof r.https!=='boolean'||
    p.offlineOnly!==( !r.docker && !r.https)||
    (!r.docker&&p.checks.docker!=='warning')||(!r.https&&p.checks.https!=='warning')||
    (v2&&!r.docker&&!r.https))bad(422,'Invalid explicitly requested checks');
 }
 if(v3){
  const t=p.telemetry;
  if(p.requestedTelemetry!==true||!fields(t,['status','windowHours','capturedAt','requests','clientErrors','serverErrors','maintenanceUnavailable'])||
    !['observed','stale','unavailable'].includes(t.status)||t.windowHours!==24||
    ['requests','clientErrors','serverErrors','maintenanceUnavailable'].some(k=>!Number.isSafeInteger(t[k])||t[k]<0||t[k]>1000000000)||
    t.clientErrors+t.serverErrors>t.requests||t.maintenanceUnavailable>t.serverErrors||
    (t.status==='unavailable' ? (t.capturedAt!==null||t.requests!==0||t.clientErrors!==0||t.serverErrors!==0||t.maintenanceUnavailable!==0) : !iso(t.capturedAt))||
    (t.capturedAt!==null&&Date.parse(t.capturedAt)>Date.parse(p.observedAt)+5*60*1000))
    bad(422,'Invalid privacy-safe telemetry summary');
 }
 const ms=Date.parse(p.observedAt);
 if(ms>currentMs+5*60*1000||ms<currentMs-48*60*60*1000)bad(422,'Fleet report is too old or dated in the future');
 if(typeof packet.signature!=='string'||!/^(?:[A-Za-z0-9+/]{4}){21}[A-Za-z0-9+/]{2}==$/.test(packet.signature))bad(422,'Invalid signature encoding');
 const key=createPublicKey(publicKeyPem);
 if(packet.keyFingerprint!==fp(key)||!verify(null,Buffer.from(JSON.stringify(p)),key,Buffer.from(packet.signature,'base64')))
   bad(422,'Fleet signature does not match pinned installation key');
 return p;
}
export function pinFleetIdentity(db,ownerId,projectId,publicKeyPem,rotate=false){
 if(!db.prepare('SELECT id FROM projects WHERE id=? AND owner_id=?').get(projectId,ownerId))bad(404,'Project not found');
 const key=parseFleetPublicKey(publicKeyPem);
 const exists=db.prepare('SELECT fingerprint FROM project_fleet_keys WHERE project_id=? AND owner_id=?').get(projectId,ownerId);
 if(exists&&!rotate)bad(409,'Fleet key already pinned; explicit rotation required');
 if(!exists&&rotate)bad(409,'No existing fleet key to rotate');
 if(exists&&exists.fingerprint===key.fingerprint)bad(409,'New fleet key must differ from existing key');
 const ts=new Date().toISOString();
 withTransaction(db,()=>{
  db.prepare('INSERT INTO project_fleet_keys(project_id,owner_id,public_key_pem,fingerprint,created_at) VALUES(?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET public_key_pem=excluded.public_key_pem,fingerprint=excluded.fingerprint,created_at=excluded.created_at')
   .run(projectId,ownerId,key.publicKeyPem,key.fingerprint,ts);
  if(exists)db.prepare('DELETE FROM project_fleet_reports WHERE project_id=?').run(projectId);
 });
 return {fingerprint:key.fingerprint,rotated:!!exists};
}
export function importFleetSnapshot(db,ownerId,projectId,packet,nowMs=Date.now()){
 const key=db.prepare('SELECT public_key_pem,fingerprint FROM project_fleet_keys WHERE project_id=? AND owner_id=?').get(projectId,ownerId);
 if(!key)bad(409,'Fleet installation key not pinned');
 const payload=validateFleetEnvelope(packet,key.public_key_pem,projectId,nowMs);
 const project=db.prepare('SELECT type FROM projects WHERE id=? AND owner_id=?').get(projectId,ownerId);
 if(!project||payload.service!==project.type)bad(422,'Fleet project type mismatch');
 const latest=db.prepare('SELECT observed_at FROM project_fleet_reports WHERE project_id=? ORDER BY observed_at DESC LIMIT 1').get(projectId);
 if(latest && payload.observedAt<=latest.observed_at)bad(409,'Older or replayed fleet snapshot rejected');
 withTransaction(db,()=>{
  db.prepare('INSERT INTO project_fleet_reports(project_id,observed_at,received_at,release_sequence,service,checks_json,nonce,fingerprint) VALUES(?,?,?,?,?,?,?,?)')
   .run(projectId,payload.observedAt,new Date(nowMs).toISOString(),payload.releaseSequence,payload.service,JSON.stringify(payload.version===3?{checks:payload.checks,requestedChecks:payload.requestedChecks,telemetry:payload.telemetry}:payload.version===2?{checks:payload.checks,requestedChecks:payload.requestedChecks}:payload.checks),payload.nonce,key.fingerprint);
  db.prepare(`DELETE FROM project_fleet_reports WHERE project_id=? AND observed_at NOT IN
   (SELECT observed_at FROM project_fleet_reports WHERE project_id=? ORDER BY observed_at DESC LIMIT 30)`).run(projectId,projectId);
 });
 return {imported:true,...fleetStatus(db,ownerId,projectId,nowMs)};
}
export function fleetStatus(db,ownerId,projectId,nowMs=Date.now()){
 if(!db.prepare('SELECT id FROM projects WHERE id=? AND owner_id=?').get(projectId,ownerId))bad(404,'Project not found');
 const key=db.prepare('SELECT fingerprint FROM project_fleet_keys WHERE project_id=? AND owner_id=?').get(projectId,ownerId);
 const rows=db.prepare('SELECT observed_at,received_at,release_sequence,service,checks_json FROM project_fleet_reports WHERE project_id=? ORDER BY observed_at DESC LIMIT 10').all(projectId);
 const history=rows.map(row=>{
  const saved=JSON.parse(row.checks_json);const requestedChecks=saved.requestedChecks||{docker:false,https:false};
  return {observedAt:row.observed_at,receivedAt:row.received_at,releaseSequence:row.release_sequence,
   service:row.service,checks:saved.checks||saved,requestedChecks,telemetry:saved.telemetry||null};
 });
 const latest=history[0]||null;
 const age=latest?nowMs-Date.parse(latest.observedAt):null;
 const observedRollback=latest && history.some(r=>r.releaseSequence>latest.releaseSequence);
 const health=!latest?'unknown':age>60*60*1000?'stale':observedRollback?'rollback':Object.values(latest.checks).includes('fail')?'critical':
  Object.values(latest.checks).includes('warning')||latest.telemetry?.serverErrors>0?'warning':'ok';
 const fresh=age!==null && age>=-5*60*1000 && age<=60*60*1000;
 const evidence={httpsVerified:!!fresh&&!!latest?.requestedChecks.https&&latest.checks.https==='pass',
  dockerConfigChecked:!!fresh&&!!latest?.requestedChecks.docker&&latest.checks.docker==='pass',
  observedRollback:!!observedRollback,liveMonitoring:false,
  telemetryProvided:!!fresh&&latest?.telemetry?.status==='observed'};
 return {trusted:!!key,fingerprint:key?.fingerprint||null,health,evidence,telemetry:latest?.telemetry||null,ageMinutes:age===null?null:Math.max(0,Math.floor(age/60000)),latest,history,
  note:'Manual signed snapshots only. Docker pass means Compose configuration checked, not a running-container guarantee; public HTTPS must be requested explicitly.'};
}

/** Owner-only portfolio view: no network calls and no customer rows. */
export function fleetOverview(db,ownerId,nowMs=Date.now()){
 const limit=100;
 const projects=db.prepare('SELECT id,name,type FROM projects WHERE owner_id=? ORDER BY created_at DESC,id LIMIT ?').all(ownerId,limit+1);
 const rows=projects.slice(0,limit).map(project=>{
  const status=fleetStatus(db,ownerId,project.id,nowMs);
  return {projectId:project.id,name:project.name,type:project.type,health:status.health,
   trusted:status.trusted,releaseSequence:status.latest?.releaseSequence??null,
   observedAt:status.latest?.observedAt??null,ageMinutes:status.ageMinutes,
   httpsVerified:status.evidence.httpsVerified,observedRollback:status.evidence.observedRollback,
   telemetryStatus:status.telemetry?.status||'not-requested',serverErrors:status.telemetry?.status==='observed'?status.telemetry.serverErrors:null};
 });
 return {total:rows.length,truncated:projects.length>limit,
  counts:{trusted:rows.filter(x=>x.trusted).length,reported:rows.filter(x=>x.observedAt).length,
   needsAttention:rows.filter(x=>['critical','stale','rollback','warning'].includes(x.health)).length,
   httpsVerified:rows.filter(x=>x.httpsVerified).length,
   telemetryObserved:rows.filter(x=>x.telemetryStatus==='observed').length,
   reportedServerErrors:rows.reduce((n,x)=>n+(x.serverErrors||0),0)},rows,
  note:'Manually imported signed reports, not live monitoring'};
}
