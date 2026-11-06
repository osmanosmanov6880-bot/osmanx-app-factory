// R4.2 transactional audit with R4.3 keyed after-image binding.
// Audit entries commit or roll back in the SAME PostgreSQL transaction as mutations.
import {randomUUID,createHmac} from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64=/^[0-9a-fA-F]{64}$/;
const COLUMNS=Object.freeze({
  clients:['id','full_name','phone','email','source','notes','archived_at','created_at','updated_at'],
  tasks:['id','title','description','status','priority','due_at','client_id','assigned_to','created_by','created_at','updated_at'],
  visits:['id','client_id','occurred_at','note','created_by','created_at']
});
function requireValue(ok,message){if(!ok)throw Error('R4.3 audited after-image denied: '+message);}
export function r43AfterImageHmac(secret,entity,row){
  requireValue(Buffer.isBuffer(secret)&&secret.length>=32,'private HMAC key required');
  requireValue(Object.hasOwn(COLUMNS,entity),'unsupported entity type');
  requireValue(row&&typeof row==='object'&&!Array.isArray(row)&&typeof row.id==='string'&&UUID.test(row.id),
    'invalid row envelope');
  const cells=COLUMNS[entity].map(column=>{
    let value=row[column];
    if(value===undefined&&entity==='clients'&&column==='archived_at')value=null;
    requireValue(value!==undefined,'after-image column missing: '+column);
    if(value===null)return null;
    if(value instanceof Uint8Array)return Buffer.from(value).toString('hex');
    requireValue(typeof value==='string','after-image TEXT column is not a string');
    return value;
  });
  return createHmac('sha256',secret).update('OSMANX-R43-AFTER-IMAGE-v1\0')
    .update(entity+'\0').update(JSON.stringify(cells)).digest('hex');
}
export function r43AuditVersion(entity,row){
  requireValue(Object.hasOwn(COLUMNS,entity),'unsupported versioned entity');
  const value=entity==='visits'?row?.created_at:row?.updated_at;
  requireValue(typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    &&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString()===value,
    'after-image version must be canonical ISO timestamp');
  return value;
}
export async function writePgPreviewAudit(scope,{
  actorUserId=null,action,entity,entityId,afterImage
}={}){
  if(!scope||typeof scope.query!=='function'||!['create','update'].includes(action)
    ||!Object.hasOwn(COLUMNS,entity)||typeof entityId!=='string'||!UUID.test(entityId)
    ||(actorUserId!==null&&(typeof actorUserId!=='string'||!UUID.test(actorUserId))))
    throw Error('R4.2 invalid PostgreSQL audit envelope');
  const metadata={surface:'postgresql-preview',actorKind:actorUserId?'employee':'studio-owner'};
  if(afterImage!==undefined){
    requireValue(afterImage?.id===entityId,'audit target and after-image identity mismatch');
    const hex=process.env.OX_R42_JOURNAL_HMAC_KEY;
    requireValue(typeof hex==='string'&&HEX64.test(hex),'missing private after-image key');
    metadata.auditVersion='r43-after-image-v1';
    metadata.afterImageHmac=r43AfterImageHmac(Buffer.from(hex,'hex'),entity,afterImage);
    metadata.afterImageVersion=r43AuditVersion(entity,afterImage);
  }
  await scope.query('INSERT INTO audit_log(id,user_id,action,entity,entity_id,metadata_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(),actorUserId,'pg-preview.'+action,entity,entityId,JSON.stringify(metadata),new Date().toISOString()]);
}
