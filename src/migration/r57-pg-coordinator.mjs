// R5.7: PostgreSQL-serialized, durable checkpoint arbiter (synthetic only).
// Row locks apply across independent coordinator processes. The persisted
// intent PRECEDES the S3 PUT. No takeover while an outcome is ambiguous.
// This is NOT a cross-service ACID transaction or a production RPO guarantee.
import {createHash,randomBytes} from 'node:crypto';

const TENANT=/^[a-f0-9]{24}$/,HOLDER=/^[a-f0-9]{24}$/,
  OP=/^[a-f0-9]{32}$/,SHA=/^[a-f0-9]{64}$/,
  ETAG=/^"[a-fA-F0-9-]{1,128}"$/,HEAD='r53/head.json';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function deny(ok,reason){
  if(!ok)throw Error('R5.7 PostgreSQL checkpoint refused: '+reason);
}
function failureIsMissing(e){
  return String(e?.message)==='R4.8 S3 denied: GET status 404';
}
export function createR57PgCoordinator({
  pool,privilegedRemote,tenantId,fault=()=>{},syntheticOnly=false
}={}){
  deny(syntheticOnly===true&&TENANT.test(tenantId||'')&&
    pool&&typeof pool.connect==='function'&&
    privilegedRemote&&privilegedRemote.tenantPrefix===tenantId+'/'&& 
    privilegedRemote.role==='pointer-coordinator-only'&& 
    typeof privilegedRemote.put==='function'&&
    typeof privilegedRemote.getWithMetadata==='function'&&
    typeof privilegedRemote.inspectR49Worm==='function'&&
    typeof privilegedRemote.assertBucketControls==='function'&&
    typeof fault==='function',
    'synthetic mode, pinned tenant, privileged S3 adapter and PostgreSQL pool required');

  // Each fresh transaction uses the actual PostgreSQL server clock. Do not
  // trust independent worker clocks to decide whose fencing epoch is current.
  async function locked(task){
    const client=await pool.connect();
    let begun=false;
    try{
      await client.query('BEGIN');begun=true;
      await client.query(
        'INSERT INTO ox_r57_checkpoint_control(tenant) VALUES($1) ON CONFLICT(tenant) DO NOTHING',
        [tenantId]);
      const result=await client.query(
        `SELECT *, (extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms
           FROM ox_r57_checkpoint_control WHERE tenant=$1 FOR UPDATE`,[tenantId]);
      deny(result.rows.length===1,'missing locked PostgreSQL tenant row');
      const row=result.rows[0];
      const value=await task(client,row,Number(row.now_ms));
      await client.query('COMMIT');begun=false;
      return value;
    }catch(e){
      if(begun)await client.query('ROLLBACK').catch(()=>{});
      throw e;
    }finally{client.release();}
  }
  function identity(lease){
    deny(lease&&lease.tenant===tenantId&&HOLDER.test(lease.holder||'')&&
      OP.test(lease.leaseId||'')&&Number.isSafeInteger(lease.epoch)&&
      lease.epoch>=1,'invalid lease identity');
  }
  function current(row,lease,now){
    identity(lease);
    deny(Number(row.epoch)===lease.epoch&&row.holder===lease.holder&&
      row.lease_id===lease.leaseId&&
      row.expires_at instanceof Date&&row.expires_at.getTime()>now,
      'stale or expired lease');
  }
  function responseLease(row){
    return Object.freeze({tenant:tenantId,holder:row.holder,
      epoch:Number(row.epoch),leaseId:row.lease_id,
      expiresAt:row.expires_at.getTime(),
      syntheticOnly:true,productionCutoverAllowed:false});
  }
  async function getHead(){
    try{
      const obj=await privilegedRemote.getWithMetadata(HEAD);
      deny(Buffer.isBuffer(obj.body)&&ETAG.test(obj.etag||'')&&
        typeof obj.versionId==='string'&&obj.versionId.length>0,
        'S3 must return strong ETag and version ID');
      return obj;
    }catch(e){if(failureIsMissing(e))return null;throw e;}
  }
  async function lockedVersion(){
    const proof=await privilegedRemote.inspectR49Worm(HEAD);
    deny(proof?.objectLockVerified===true&&
      proof.retentionMode==='COMPLIANCE'&&
      typeof proof.versionId==='string'&&proof.versionId.length>0,
      'checkpoint version lacks COMPLIANCE object lock');
    return proof.versionId;
  }
  function record(row){
    return row.committed_op?{
      operation:row.committed_op,
      sha256:row.committed_sha,
      versionId:row.committed_version,
      epoch:Number(row.committed_epoch)
    }:null;
  }
  async function acquire({tenant,holder,ttlMs=10000}={}){
    deny(tenant===tenantId&&HOLDER.test(holder||'')&&
      Number.isSafeInteger(ttlMs)&&ttlMs>=1000&&ttlMs<=30000,
      'invalid acquire request');
    return locked(async(client,row,now)=>{
      deny(!row.pending_op,
        'unresolved S3 intent quarantines all new publishers');
      deny(!row.holder||row.expires_at.getTime()<=now,
        'another publisher holds the lease');
      deny(Number(row.epoch)<1000000,'monotonic epoch exhausted');
      const id=randomBytes(16).toString('hex');
      const changed=await client.query(
        `UPDATE ox_r57_checkpoint_control SET epoch=epoch+1,holder=$2,
         lease_id=$3,expires_at=clock_timestamp()+($4::integer*interval '1 millisecond'),
         modified_at=clock_timestamp() WHERE tenant=$1 RETURNING *`,
        [tenantId,holder,id,ttlMs]);
      return responseLease(changed.rows[0]);
    });
  }
  async function renew(lease,ttlMs=10000){
    identity(lease);
    deny(Number.isSafeInteger(ttlMs)&&ttlMs>=1000&&ttlMs<=30000,
      'invalid renewal TTL');
    return locked(async(client,row,now)=>{
      current(row,lease,now);
      const result=await client.query(
        `UPDATE ox_r57_checkpoint_control SET
          expires_at=clock_timestamp()+($2::integer*interval '1 millisecond'),
          modified_at=clock_timestamp() WHERE tenant=$1 RETURNING *`,
        [tenantId,ttlMs]);
      return responseLease(result.rows[0]);
    });
  }
  async function assertCurrent(lease){
    identity(lease);
    return locked(async(_client,row,now)=>{
      current(row,lease,now);
      deny(!row.pending_op,'unresolved checkpoint write');
      return {remoteFencingVerified:true,epoch:lease.epoch,
        syntheticOnly:true,productionCutoverAllowed:false};
    });
  }
  async function release(lease){
    identity(lease);
    return locked(async(client,row,now)=>{
      current(row,lease,now);
      deny(!row.pending_op,'cannot release with ambiguous S3 write');
      await client.query(
        `UPDATE ox_r57_checkpoint_control SET holder=NULL,lease_id=NULL,
         expires_at=NULL,modified_at=clock_timestamp() WHERE tenant=$1`,[tenantId]);
      return {released:true,epoch:lease.epoch};
    });
  }
  async function publish({
    lease,body,ifMatch=null,ifNoneMatch=false,
    operation=randomBytes(16).toString('hex')
  }={}){
    identity(lease);
    deny(Buffer.isBuffer(body)&&body.length>0&&body.length<=4096&&
      OP.test(operation)&&(
        (typeof ifMatch==='string'&&ETAG.test(ifMatch)&&!ifNoneMatch)||
        (ifMatch===null&&ifNoneMatch===true)
      ),'signed pointer bytes and strict CAS condition required');
    const sha256=hash(body);
    // Block all other hosts BEFORE a mutable S3 PUT begins. A later lost
    // process/connection cannot silently clear this intent.
    const begin=await locked(async(client,row,now)=>{
      current(row,lease,now);
      deny(!row.pending_op,'prior ambiguous S3 PUT requires reconciliation');
      if(row.committed_op===operation){
        deny(row.committed_sha===sha256,'reused operation with different payload');
        return {replay:record(row)};
      }
      const controls=await privilegedRemote.assertBucketControls();
      deny(controls?.objectLockEnabled===true&&
        controls?.versioningEnabled===true,'bucket controls missing');
      const before=await getHead();
      if(ifNoneMatch)deny(!before,'conditional create requires missing pointer');
      else deny(before?.etag===ifMatch,
        'S3 pointer ETag changed before transaction intent');
      await client.query(
        `UPDATE ox_r57_checkpoint_control SET
          pending_op=$2,pending_sha=$3,pending_if_match=$4,pending_create=$5,
          pending_epoch=$6,pending_before_version=$7,
          modified_at=clock_timestamp() WHERE tenant=$1`,
        [tenantId,operation,sha256,ifMatch,ifNoneMatch,
          lease.epoch,before?.versionId||null]);
      return {replay:null,beforeVersion:before?.versionId||null};
    });
    if(begin.replay)return {confirmed:true,replayed:true,...begin.replay,
      syntheticOnly:true,productionCutoverAllowed:false};
    fault('after-intent');
    // S3 can only be reached by the coordinator's privileged adapter.
    // Other coordinator instances see pending_op and cannot obtain a lease.
    // The underlying provider still must enforce conditional PUT via CAS.
    await privilegedRemote.put(HEAD,body,ifMatch?
      {ifMatch}:{ifNoneMatch:true});
    fault('after-put');
    const posted=await getHead();
    deny(posted&&hash(posted.body)===sha256&&
      posted.versionId!==begin.beforeVersion,'S3 readback or version differs');
    const version=await lockedVersion();
    deny(posted.versionId===version,'S3 GET and WORM HEAD disagree on version');
    const receipt=await locked(async(client,row)=>{
      deny(row.pending_op===operation&&row.pending_sha===sha256&&
        Number(row.pending_epoch)===lease.epoch&&
        Number(row.epoch)===lease.epoch&&
        row.pending_before_version===begin.beforeVersion,
        'pending journal no longer matches proposed checkpoint');
      await client.query(
        `UPDATE ox_r57_checkpoint_control SET
          committed_op=$2,committed_sha=$3,committed_version=$4,
          committed_epoch=$5,pending_op=NULL,pending_sha=NULL,
          pending_if_match=NULL,pending_create=NULL,pending_epoch=NULL,
          pending_before_version=NULL,modified_at=clock_timestamp()
          WHERE tenant=$1`,
        [tenantId,operation,sha256,version,lease.epoch]);
      return {operation,sha256,versionId:version,epoch:lease.epoch};
    });
    fault('after-confirmation');
    return {confirmed:true,replayed:false,...receipt,
      syntheticOnly:true,productionCutoverAllowed:false};
  }
  async function recover(tenant){
    deny(tenant===tenantId,'cross-tenant recovery refused');
    return locked(async(client,row)=>{
      if(!row.pending_op)return {
        ambiguous:false,committed:record(row),epoch:Number(row.epoch),
        syntheticOnly:true,productionCutoverAllowed:false};
      // A missing/mismatched HEAD is NOT proof of a failed PUT: the
      // request may still be in flight, or its previous version may exist.
      const posted=await getHead();
      deny(posted&&hash(posted.body)===row.pending_sha&&
        posted.versionId!==row.pending_before_version,
        'ambiguous S3 outcome: manual version-history investigation required');
      const version=await lockedVersion();
      deny(version===posted.versionId,
        'S3 object version changed during recovery');
      // A matching newly locked version proves the PUT reached S3.
      // Only this pending operation may be acknowledged.
      const saved={operation:row.pending_op,sha256:row.pending_sha,
        versionId:version,epoch:Number(row.pending_epoch)};
      await client.query(
        `UPDATE ox_r57_checkpoint_control SET
          committed_op=$2,committed_sha=$3,committed_version=$4,
          committed_epoch=$5,pending_op=NULL,pending_sha=NULL,
          pending_if_match=NULL,pending_create=NULL,pending_epoch=NULL,
          pending_before_version=NULL,modified_at=clock_timestamp()
          WHERE tenant=$1`,
        [tenantId,saved.operation,saved.sha256,version,saved.epoch]);
      return {ambiguous:false,reconciled:true,committed:saved,
        epoch:Number(row.epoch),syntheticOnly:true,productionCutoverAllowed:false};
    });
  }
  async function inspect(tenant){
    deny(tenant===tenantId,'cross-tenant inspection refused');
    return locked(async(_client,row)=>({
      epoch:Number(row.epoch),active:!!row.holder,
      pending:!!row.pending_op,pendingEpoch:row.pending_epoch===null?null:
        Number(row.pending_epoch),committed:record(row),syntheticOnly:true
    }));
  }
  return Object.freeze({acquire,renew,assertCurrent,release,publish,recover,inspect,
    syntheticOnly:true,productionCutoverAllowed:false,
    coordinatorType:'postgres-row-locked-fenced-intent-v1'});
}
