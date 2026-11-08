// R5.9: PostgreSQL row-locked HMAC audit chain. Keys must be kept off the DB.
// No cleanup, DELETE, silent reset, automatic unquarantine or production claim.
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
const TENANT=/^[a-f0-9]{24}$/,HEX=/^[a-f0-9]{64}$/,
  KIND=/^[a-z][a-z0-9._-]{2,47}$/,
  ACTOR=/^[a-z0-9._-]{6,64}$/,ZERO='0'.repeat(64);
const FORMAT='osmanx-r59-audit-chain-v1';
function deny(ok,why){if(!ok)throw Error('R5.9 audit ledger refused: '+why);}
function mac(key,fields){
  return createHmac('sha256',key).update('OSMANX-R59-AUDIT-v1\0')
    .update(JSON.stringify(fields)).digest('hex');
}
function equal(a,b){
  return typeof a==='string'&&typeof b==='string'&&HEX.test(a)&&HEX.test(b)&&
    timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
function eventFields(row){
  return {format:FORMAT,tenant:row.tenant,seq:Number(row.seq),
    prevMac:row.prev_mac,kind:row.kind,actor:row.actor,
    evidenceSha256:row.evidence_sha,nonce:row.event_nonce,
    atMs:Number(row.at_ms)};
}
export function verifyR59AuditRows({
  rows,tip,tenantId,signingKey,maxRows=10000
}={}){
  deny(TENANT.test(tenantId||'')&&Buffer.isBuffer(signingKey)&&
    signingKey.length===32&&Array.isArray(rows)&&
    Number.isSafeInteger(maxRows)&&maxRows>=1&&maxRows<=100000&&
    rows.length<=maxRows,'invalid audit review configuration');
  let last=ZERO,count=0;
  for(const row of rows){
    const fields=eventFields(row);
    deny(fields.tenant===tenantId&&
      Number.isSafeInteger(fields.seq)&&fields.seq===count+1&&
      equal(fields.prevMac,last)&&
      KIND.test(fields.kind||'')&&ACTOR.test(fields.actor||'')&&
      HEX.test(fields.evidenceSha256||'')&&
      /^[a-f0-9]{32}$/.test(fields.nonce||'')&&
      Number.isSafeInteger(fields.atMs)&&fields.atMs>0&&
      equal(row.mac,mac(signingKey,fields)),
      'broken, reordered or forged audit chain at position '+(count+1));
    last=row.mac;count++;
  }
  deny(tip&&Number(tip.seq)===count&&equal(tip.mac,last),
    'audit tip is missing or disagrees with chained records');
  return {verified:true,tenantId,count,tipMac:last,
    appendOnlySqlEvidenceChecked:false,offsiteAnchorVerified:false,
    productionCutoverAllowed:false};
}
export function createR59PgAuditLedger({pool,tenantId,signingKey}={}){
  deny(pool?.connect&&TENANT.test(tenantId||'')&&
    Buffer.isBuffer(signingKey)&&signingKey.length===32,
    'pinned tenant, restricted pool and external 32-byte signing key required');
  async function append({kind,actor,evidenceSha256}={}){
    deny(KIND.test(kind||'')&&ACTOR.test(actor||'')&&
      HEX.test(evidenceSha256||''),
      'strict event kind, operator ID and evidence digest required');
    const client=await pool.connect();
    let begun=false,broken=null;
    const onError=e=>{broken=e;};client.on?.('error',onError);
    try{
      await client.query('BEGIN');begun=true;
      await client.query(
        'INSERT INTO ox_r59_audit_tip(tenant) VALUES($1) ON CONFLICT DO NOTHING',
        [tenantId]);
      const item=await client.query(
        'SELECT * FROM ox_r59_audit_tip WHERE tenant=$1 FOR UPDATE',[tenantId]);
      deny(item.rows.length===1,'audit tip row absent');
      const tip=item.rows[0],seq=Number(tip.seq)+1;
      deny(Number.isSafeInteger(seq)&&seq<=1000000,'ledger capacity reached');
      const at=(await client.query(
        'SELECT floor(extract(epoch from clock_timestamp())*1000)::bigint AS now_ms'))
        .rows[0].now_ms;
      const fields={format:FORMAT,tenant:tenantId,seq,prevMac:tip.mac,
        kind,actor,evidenceSha256,nonce:randomBytes(16).toString('hex'),
        atMs:Number(at)};
      const signature=mac(signingKey,fields);
      await client.query(
        'INSERT INTO ox_r59_audit_chain(tenant,seq,prev_mac,mac,kind,actor,evidence_sha,event_nonce,at_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [tenantId,seq,tip.mac,signature,kind,actor,
          evidenceSha256,fields.nonce,fields.atMs]);
      await client.query(
        'UPDATE ox_r59_audit_tip SET seq=$2,mac=$3,modified_at=clock_timestamp() WHERE tenant=$1',
        [tenantId,seq,signature]);
      await client.query('COMMIT');begun=false;
      return Object.freeze({format:FORMAT,seq,mac:signature,
        syntheticOnly:true,productionCutoverAllowed:false});
    }catch(e){
      if(begun)await client.query('ROLLBACK').catch(()=>{});
      if(/connection terminated|ECONNRESET|57P01/i.test(String(e)))broken=e;
      throw e;
    }finally{
      try{client.release(broken||undefined);}
      finally{client.off?.('error',onError);}
    }
  }
  async function verify({maxRows=10000}={}){
    deny(Number.isSafeInteger(maxRows)&&maxRows>0&&maxRows<=100000,
      'bounded verifier limit required');
    const client=await pool.connect();
    try{
      // Consistent snapshot prevents concurrent append from changing tip
      // after row collection.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try{
        const [items,head]=await Promise.all([
          client.query(
            'SELECT tenant,seq,prev_mac,mac,kind,actor,evidence_sha,event_nonce,at_ms FROM ox_r59_audit_chain WHERE tenant=$1 ORDER BY seq LIMIT $2',
            [tenantId,maxRows+1]),
          // pg cannot multiplex queries on one connection. pg client
          // serializes them; both still share one repeatable-read snapshot.
          client.query('SELECT seq,mac FROM ox_r59_audit_tip WHERE tenant=$1',
            [tenantId])
        ]);
        const result=verifyR59AuditRows({
          rows:items.rows,
          tip:head.rows[0]||{seq:0,mac:ZERO},
          tenantId,signingKey,maxRows
        });
        await client.query('COMMIT');
        return result;
      }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
    }finally{client.release();}
  }
  return Object.freeze({append,verify,tenantId,syntheticOnly:true,
    productionCutoverAllowed:false});
}
