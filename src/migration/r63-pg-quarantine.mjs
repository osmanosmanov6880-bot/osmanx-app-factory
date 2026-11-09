// R6.3: durable PostgreSQL old-primary rejoin quarantine.
// Append-only per-tenant node evidence; no CLEAR/REJOIN implementation.
import {createHmac,timingSafeEqual} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,CASE=/^[a-f0-9]{32}$/,
  NODE=/^[a-z][a-z0-9-]{2,48}$/,ACTOR=/^[a-z][a-z0-9._-]{5,63}$/,
  SHA=/^[a-f0-9]{64}$/,SYS=/^[0-9]{10,32}$/,ZERO='0'.repeat(64),
  ACTION=new Set(['inspect','rebootstrap-required']);
function deny(ok,why){if(!ok)throw Error('R6.3 quarantine refused: '+why);}
function hmac(key,row){
  return createHmac('sha256',key)
    .update('OSMANX-R63-REJOIN-CHAIN-V1\0')
    .update(JSON.stringify(row)).digest('hex');
}
function equal(a,b){
  return SHA.test(a||'')&&SHA.test(b||'')&&
    timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
function normalizedEvent(row){
  return {format:'osmanx-r63-review-v1',
    tenantId:row.tenant,clusterId:row.cluster_id,
    incidentId:row.incident_id,nodeId:row.node_id,
    seq:Number(row.seq),action:row.action,actor:row.actor,
    evidenceSha256:row.evidence_sha,prevMac:row.prev_mac,
    atMs:Number(row.at_ms)};
}
export function verifyR63QuarantineEvents({
  events,tenantId,clusterId,incidentId,nodeId,hmacKey
}={}){
  deny(Array.isArray(events)&&events.length<=100000&&
    TENANT.test(tenantId||'')&&TENANT.test(clusterId||'')&&
    CASE.test(incidentId||'')&&NODE.test(nodeId||'')&&
    Buffer.isBuffer(hmacKey)&&hmacKey.length===32,
    'bounded tenant-pinned journal and external key required');
  let tip=ZERO;
  for(let i=0;i<events.length;i++){
    const e=events[i],n=normalizedEvent(e);
    deny(n.tenantId===tenantId&&n.clusterId===clusterId&&
      n.incidentId===incidentId&&n.nodeId===nodeId&&
      n.seq===i+1&&ACTION.has(n.action)&&ACTOR.test(n.actor||'')&&
      SHA.test(n.evidenceSha256||'')&&Number.isSafeInteger(n.atMs)&&
      n.atMs>0&&equal(n.prevMac,tip)&&equal(e.event_mac,hmac(hmacKey,n)),
      'missing, reordered or forged rejoin review event');
    tip=e.event_mac;
  }
  return Object.freeze({verified:true,count:events.length,tipMac:tip,
    oldPrimaryRejoinAllowed:false,productionCutoverAllowed:false});
}
export function createR63PgQuarantine({
  pool,tenantId,clusterId,hmacKey
}={}){
  deny(pool?.connect&&TENANT.test(tenantId||'')&&
    TENANT.test(clusterId||'')&&Buffer.isBuffer(hmacKey)&&
    hmacKey.length===32,'isolated pool, fixed tenant/cluster and HMAC key required');
  async function tx(work,{readOnly=false}={}){
    const client=await pool.connect();let begun=false,broken=null;
    const onError=e=>{broken=e;};
    client.on?.('error',onError);
    try{
      await client.query(readOnly?
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
      begun=true;
      const out=await work(client);
      await client.query('COMMIT');begun=false;
      return out;
    }catch(error){
      if(begun)await client.query('ROLLBACK').catch(()=>{});
      if(/connection terminated|ECONNRESET|57P01/i.test(
        String(error?.message||'')+' '+String(error?.code||'')))
        broken=error;
      throw error;
    }finally{
      try{client.release(broken||undefined);}
      finally{client.off?.('error',onError);}
    }
  }
  async function find(client,incidentId,nodeId,{lock=false}={}){
    const res=await client.query(
      'SELECT tenant,cluster_id,incident_id,node_id,system_id,old_timeline,'+
      'selected_timeline,evidence_sha FROM ox_r63_node_quarantine '+
      'WHERE tenant=$1 AND cluster_id=$2 AND incident_id=$3 AND node_id=$4'+
      (lock?' FOR UPDATE':''),
      [tenantId,clusterId,incidentId,nodeId]);
    deny(res.rows?.length===1,'quarantine record not found');
    return res.rows[0];
  }
  async function quarantine({
    incidentId,nodeId,systemId,oldTimeline,newTimeline,evidenceSha256
  }={}){
    deny(CASE.test(incidentId||'')&&NODE.test(nodeId||'')&&
      SYS.test(String(systemId||''))&&
      Number.isSafeInteger(oldTimeline)&&oldTimeline>=1&&
      Number.isSafeInteger(newTimeline)&&newTimeline>=1&&
      newTimeline<=65535&&SHA.test(evidenceSha256||''),
      'valid old-primary fork evidence required');
    return tx(async client=>{
      const inserted=await client.query(
        'INSERT INTO ox_r63_node_quarantine'+
        '(tenant,cluster_id,incident_id,node_id,system_id,old_timeline,'+
        'selected_timeline,evidence_sha) VALUES($1,$2,$3,$4,$5,$6,$7,$8) '+
        'ON CONFLICT DO NOTHING RETURNING node_id',
        [tenantId,clusterId,incidentId,nodeId,String(systemId),
          oldTimeline,newTimeline,evidenceSha256]);
      const row=await find(client,incidentId,nodeId,{lock:true});
      deny(row.system_id===String(systemId)&&
        Number(row.old_timeline)===oldTimeline&&
        Number(row.selected_timeline)===newTimeline&&
        row.evidence_sha===evidenceSha256,
        'incident identity reused with different timeline evidence');
      return Object.freeze({format:'osmanx-r63-quarantine-v1',
        tenantId,clusterId,incidentId,nodeId,
        created:inserted.rows.length===1,
        quarantined:true,automaticRejoinAllowed:false,
        productionCutoverAllowed:false});
    });
  }
  async function review({incidentId,nodeId,action,actor,evidenceSha256}={}){
    deny(CASE.test(incidentId||'')&&NODE.test(nodeId||'')&&
      ACTION.has(action)&&ACTOR.test(actor||'')&&
      SHA.test(evidenceSha256||''),
      'read-only review must identify exact node evidence');
    return tx(async client=>{
      const row=await find(client,incidentId,nodeId,{lock:true});
      deny(row.evidence_sha===evidenceSha256,
        'review evidence differs from immutable quarantine record');
      const params=[tenantId,clusterId,incidentId,nodeId];
      const prior=await client.query(
        'SELECT seq,action,actor,evidence_sha,event_mac FROM ox_r63_quarantine_review '+
        'WHERE tenant=$1 AND cluster_id=$2 AND incident_id=$3 AND node_id=$4 '+
        'ORDER BY seq DESC LIMIT 1',params);
      const existing=await client.query(
        'SELECT seq,actor FROM ox_r63_quarantine_review '+
        'WHERE tenant=$1 AND cluster_id=$2 AND incident_id=$3 AND node_id=$4 '+
        'AND action=$5 AND evidence_sha=$6',
        [...params,action,evidenceSha256]);
      if(existing.rows.length){
        deny(existing.rows.length===1&&existing.rows[0].actor===actor,
          'review already recorded with another actor');
        return Object.freeze({replayed:true,seq:Number(existing.rows[0].seq),
          oldPrimaryRejoinAllowed:false,productionCutoverAllowed:false});
      }
      const last=prior.rows[0],seq=last?Number(last.seq)+1:1;
      deny(seq<=1000000&&Number.isSafeInteger(seq),'review capacity exhausted');
      const at=await client.query(
        'SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS ms');
      const stamp=Number(at.rows[0].ms);
      const record={format:'osmanx-r63-review-v1',tenantId,clusterId,
        incidentId,nodeId,seq,action,actor,evidenceSha256,
        prevMac:last?.event_mac||ZERO,atMs:stamp};
      const signature=hmac(hmacKey,record);
      await client.query(
        'INSERT INTO ox_r63_quarantine_review'+
        '(tenant,cluster_id,incident_id,node_id,seq,action,actor,'+
        'evidence_sha,prev_mac,event_mac,at_ms) VALUES'+
        '($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [...params,seq,action,actor,evidenceSha256,
          record.prevMac,signature,stamp]);
      return Object.freeze({replayed:false,seq,eventMac:signature,
        oldPrimaryRejoinAllowed:false,productionCutoverAllowed:false});
    });
  }
  async function inspect({incidentId,nodeId}={}){
    deny(CASE.test(incidentId||'')&&NODE.test(nodeId||''),
      'opaque incident and node IDs required');
    return tx(async client=>{
      const row=await find(client,incidentId,nodeId);
      const records=await client.query(
        'SELECT tenant,cluster_id,incident_id,node_id,seq,action,actor,'+
        'evidence_sha,prev_mac,event_mac,at_ms FROM ox_r63_quarantine_review '+
        'WHERE tenant=$1 AND cluster_id=$2 AND incident_id=$3 AND node_id=$4 '+
        'ORDER BY seq LIMIT 100001',
        [tenantId,clusterId,incidentId,nodeId]);
      const chain=verifyR63QuarantineEvents({
        events:records.rows,tenantId,clusterId,incidentId,nodeId,hmacKey
      });
      return Object.freeze({format:'osmanx-r63-quarantine-inspection-v1',
        tenantId,clusterId,incidentId,nodeId,
        systemId:row.system_id,oldTimeline:Number(row.old_timeline),
        selectedTimeline:Number(row.selected_timeline),
        sourceEvidenceSha256:row.evidence_sha,reviewEvents:chain.count,
        chainTip:chain.tipMac,chainVerified:chain.verified,
        quarantined:true,oldPrimaryRejoinAllowed:false,
        productionCutoverAllowed:false});
    },{readOnly:true});
  }
  return Object.freeze({tenantId,clusterId,quarantine,review,inspect,
    syntheticOnly:true,oldPrimaryRejoinAllowed:false,
    productionCutoverAllowed:false});
}
