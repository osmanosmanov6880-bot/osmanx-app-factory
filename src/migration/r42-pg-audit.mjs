// R4.2 audit receipt written in the SAME PostgreSQL preview transaction as each mutation.
// The studio owner exists in ox_studio, not the CRM schema; owner is recorded as a
// null user_id with an explicit actor_kind, never a fabricated foreign key.
import {randomUUID} from 'node:crypto';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function writePgPreviewAudit(scope,{actorUserId=null,action,entity,entityId}={}){
  if(!scope||typeof scope.query!=='function'||!['create','update'].includes(action)
    ||!['clients','tasks','visits'].includes(entity)
    ||typeof entityId!=='string'||!UUID.test(entityId)
    ||(actorUserId!==null&&(typeof actorUserId!=='string'||!UUID.test(actorUserId))))
    throw Error('R4.2 invalid PostgreSQL audit envelope');
  const metadata=JSON.stringify({surface:'postgresql-preview',
    actorKind:actorUserId?'employee':'studio-owner'});
  await scope.query('INSERT INTO audit_log(id,user_id,action,entity,entity_id,metadata_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(),actorUserId,'pg-preview.'+action,entity,entityId,metadata,new Date().toISOString()]);
}
