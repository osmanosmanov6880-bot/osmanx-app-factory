// R6.1 immutable PostgreSQL incident dossier. Every review requires 2
// verified offline signers; all mutations are APPEND-ONLY event metadata.
import {createHmac,timingSafeEqual} from 'node:crypto';
import {verifyR61DualApprovals} from './r61-dual-approval.mjs';
const TENANT=/^[a-f0-9]{24}$/,ID=/^[a-f0-9]{32}$/,
  SHA=/^[a-f0-9]{64}$/,ACTOR=/^[a-z0-9][a-z0-9._-]{5,63}$/,
  VERSION=/^[a-zA-Z0-9_.-]{1,256}$/,ZERO='0'.repeat(64);
const ACTION=new Set(['investigate','export-evidence','close-readonly']),
  FORMAT='osmanx-r61-incident-event-v1';
function deny(ok,msg){if(!ok)throw Error('R6.1 incident store refused: '+msg);}
function hmac(key,body){
  return createHmac('sha256',key).update('OSMANX-R61-INCIDENT-v1\0')
    .update(JSON.stringify(body)).digest('hex');
}
function equal(a,b){
  return typeof a==='string'&&typeof b==='string'&&SHA.test(a)&&SHA.test(b)&&
    timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
function fields(row){
  return {format:FORMAT,tenantId:row.tenant,incidentId:row.incident_id,
    seq:Number(row.seq),action:row.action,actor:row.actor,
    approvalsSha256:row.approval_sha,
    prevMac:row.prev_mac,atMs:Number(row.at_ms)};
}
function parseCase(row){
  deny(row&&TENANT.test(row.tenant||'')&&ID.test(row.incident_id||'')&&
    SHA.test(row.evidence_sha||'')&&
    Number.isSafeInteger(Number(row.checkpoint_epoch))&&
    Number(row.checkpoint_epoch)>=1,
    'incomplete incident dossier');
  return {tenantId:row.tenant,incidentId:row.incident_id,
    evidenceSha256:row.evidence_sha,epoch:Number(row.checkpoint_epoch),
    s3Version:row.s3_version};
}
export function verifyR61IncidentChain({
  tenantId,incidentId,events,hmacKey
}={}){
  deny(TENANT.test(tenantId||'')&&ID.test(incidentId||'')&&
    Buffer.isBuffer(hmacKey)&&hmacKey.length===32&&
    Array.isArray(events)&&events.length<=100000,
    'invalid isolated incident verifier');
  let last=ZERO;
  for(let index=0;index<events.length;index++){
    const item=events[index],f=fields(item);
    deny(f.tenantId===tenantId&&f.incidentId===incidentId&&
      f.seq===index+1&&ACTION.has(f.action)&&
      ACTOR.test(f.actor||'')&&SHA.test(f.approvalsSha256||'')&&
      equal(f.prevMac,last)&&Number.isSafeInteger(f.atMs)&&
      f.atMs>0&&equal(item.event_mac,hmac(hmacKey,f)),
      'missing, out-of-order or forged incident event at index '+index);
    last=item.event_mac;
  }
  return Object.freeze({verified:true,count:events.length,tipMac:last,
    externalImmutableStorageVerified:false,
    mayClearPendingIntent:false,productionCutoverAllowed:false});
}
export function createR61PgIncidentStore({pool,tenantId,hmacKey}={}){
  deny(pool?.connect&&TENANT.test(tenantId||'')&&
    Buffer.isBuffer(hmacKey)&&hmacKey.length===32,
    'pinned tenant, isolated PostgreSQL pool and off-DB HMAC key required');
  async function transaction(work,{readOnly=false}={}){
    const client=await pool.connect();let opened=false,broken=null;
    const onError=e=>{broken=e;};client.on?.('error',onError);
    try{
      await client.query(readOnly?
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
      opened=true;
      const result=await work(client);
      await client.query('COMMIT');opened=false;
      return result;
    }catch(e){
      if(opened)await client.query('ROLLBACK').catch(()=>{});
      if(/connection terminated|ECONNRESET|57P01/i.test(
        String(e?.message||'')+' '+String(e?.code||'')))broken=e;
      throw e;
    }finally{
      try{client.release(broken||undefined);}
      finally{client.off?.('error',onError);}
    }
  }
  async function caseRow(client,incidentId,{lock=false}={}){
    const result=await client.query(
      'SELECT tenant,incident_id,evidence_sha,checkpoint_epoch,s3_version,actor FROM ox_r61_incident WHERE tenant=$1 AND incident_id=$2'+(lock?' FOR UPDATE':''),
      [tenantId,incidentId]);
    deny(result.rows.length===1,'incident missing');
    return parseCase(result.rows[0]);
  }
  async function open({
    incidentId,evidenceSha256,epoch,s3Version=null,actor
  }={}){
    deny(ID.test(incidentId||'')&&SHA.test(evidenceSha256||'')&&
      Number.isSafeInteger(epoch)&&epoch>=1&&epoch<=1000000&&
      (s3Version===null||VERSION.test(s3Version))&&
      ACTOR.test(actor||''),'invalid immutable incident identity');
    return transaction(async client=>{
      const result=await client.query(
        'INSERT INTO ox_r61_incident(tenant,incident_id,evidence_sha,checkpoint_epoch,s3_version,actor) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING incident_id',
        [tenantId,incidentId,evidenceSha256,epoch,s3Version,actor]);
      const record=await caseRow(client,incidentId,{lock:true});
      deny(record.evidenceSha256===evidenceSha256&&record.epoch===epoch&&
        record.s3Version===s3Version,
        'incident ID reused with different evidence');
      return Object.freeze({...record,created:result.rows.length===1,
        quarantined:true,mayClearPendingIntent:false,
        productionCutoverAllowed:false});
    });
  }
  async function recordReview({
    incidentId,action,actor,approvals,reviewers,now=()=>Date.now()
  }={}){
    deny(ID.test(incidentId||'')&&ACTION.has(action)&&ACTOR.test(actor||'')&&
      Array.isArray(approvals)&&typeof now==='function',
      'invalid read-only operator review');
    return transaction(async client=>{
      const incident=await caseRow(client,incidentId,{lock:true});
      const proof=verifyR61DualApprovals({
        ...incident,action,approvals,reviewers,now
      });
      const existing=await client.query(
        'SELECT seq,action,actor,event_mac FROM ox_r61_incident_event WHERE tenant=$1 AND incident_id=$2 AND approval_sha=$3',
        [tenantId,incidentId,proof.approvalsSha256]);
      if(existing.rows.length){
        const event=existing.rows[0];
        deny(event.action===action&&event.actor===actor,
          'approval already attached to a different review');
        return {reviewed:true,replayed:true,seq:Number(event.seq),
          approvalsSha256:proof.approvalsSha256,
          mayClearPendingIntent:false,productionCutoverAllowed:false};
      }
      const previous=await client.query(
        'SELECT seq,event_mac FROM ox_r61_incident_event WHERE tenant=$1 AND incident_id=$2 ORDER BY seq DESC LIMIT 1',
        [tenantId,incidentId]);
      const prior=previous.rows[0],seq=prior?Number(prior.seq)+1:1,
        prevMac=prior?.event_mac||ZERO;
      deny(Number.isSafeInteger(seq)&&seq>=1&&seq<=1000000,'case capacity exhausted');
      const timestamp=await client.query(
        'SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS ms');
      const f={format:FORMAT,tenantId,incidentId,seq,action,actor,
        approvalsSha256:proof.approvalsSha256,prevMac,
        atMs:Number(timestamp.rows[0].ms)};
      const eventMac=hmac(hmacKey,f);
      await client.query(
        'INSERT INTO ox_r61_incident_event(tenant,incident_id,seq,action,actor,approval_sha,prev_mac,event_mac,at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [tenantId,incidentId,seq,action,actor,
          proof.approvalsSha256,prevMac,eventMac,f.atMs]);
      return {reviewed:true,replayed:false,seq,
        eventMac,approvalsSha256:proof.approvalsSha256,
        mayClearPendingIntent:false,productionCutoverAllowed:false};
    });
  }
  async function inspect(incidentId){
    deny(ID.test(incidentId||''),'invalid incident ID');
    return transaction(async client=>{
      const incident=await caseRow(client,incidentId);
      const events=await client.query(
        'SELECT tenant,incident_id,seq,action,actor,approval_sha,prev_mac,event_mac,at_ms FROM ox_r61_incident_event WHERE tenant=$1 AND incident_id=$2 ORDER BY seq LIMIT 100001',
        [tenantId,incidentId]);
      const result=verifyR61IncidentChain({
        tenantId,incidentId,events:events.rows,hmacKey
      });
      return {...incident,quarantined:true,reviewEvents:result.count,
        chainTip:result.tipMac,chainVerified:result.verified,
        externalImmutableStorageVerified:false,
        mayClearPendingIntent:false,productionCutoverAllowed:false};
    },{readOnly:true});
  }
  return Object.freeze({tenantId,open,recordReview,inspect,
    syntheticOnly:true,mayClearPendingIntent:false,
    productionCutoverAllowed:false});
}
