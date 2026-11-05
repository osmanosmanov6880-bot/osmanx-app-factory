// Optional PostgreSQL tenant-scoped transaction boundary for future async APIs.
// NOT plugged into the existing synchronous SQLite factory or standalone servers.
// Database roles and schema are read from a separately signed migration manifest.
import { verifyTrustedMigration } from './pg-trust.mjs';
import { quoteIdent } from './pg-kit.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function requireValue(ok,msg){if(!ok)throw new Error(msg);}
const ALLOWED_SQL=/^\s*(SELECT|WITH|INSERT|UPDATE|DELETE)\b/i;
const FORBIDDEN_SQL=/\b(SET\s+ROLE|RESET\s+ROLE|SET\s+SESSION|SET\s+LOCAL|COMMIT|ROLLBACK|BEGIN|DISCARD|COPY\s+PROGRAM)\b/i;

export class TenantPgAdapter {
  constructor({pool,manifest,authorize,statementTimeoutMs=5000}){
    requireValue(pool && typeof pool.connect==='function','PostgreSQL connection pool required');
    requireValue(typeof authorize==='function','Server-side tenant authorization callback is mandatory');
    requireValue(Number.isSafeInteger(statementTimeoutMs) && statementTimeoutMs>=1000 && statementTimeoutMs<=30000,'Statement timeout out of bounds');
    requireValue(manifest?.access?.roles && Array.isArray(manifest.databases),'Invalid signed PostgreSQL manifest');
    this.pool=pool;this.authorize=authorize;this.statementTimeoutMs=statementTimeoutMs;
    this.projects=new Map();
    const roles=new Map(manifest.access.roles.map(r=>[r.schema,r]));
    for(const db of manifest.databases){
      if(db.projectId===null)continue; // separate, privileged studio adapter would require independent review
      requireValue(typeof db.projectId==='string' && UUID.test(db.projectId),'Invalid project identity');
      requireValue(db.schema==='ox_p_'+db.projectId.replaceAll('-',''),'Project schema mismatch');
      const plan=roles.get(db.schema);
      requireValue(plan && plan.reader==='ox_ro_'+db.projectId.replaceAll('-','')
        && plan.writer==='ox_rw_'+db.projectId.replaceAll('-',''),'Tenant role mismatch');
      quoteIdent(plan.reader);quoteIdent(plan.writer);quoteIdent(db.schema);
      requireValue(!this.projects.has(db.projectId),'Duplicate project ID');
      this.projects.set(db.projectId,{schema:db.schema,reader:plan.reader,writer:plan.writer});
    }
    requireValue(this.projects.size>0,'No project tenants in manifest');
  }

  async transaction({actorId,projectId,mode='read'},callback){
    requireValue(typeof actorId==='string' && actorId.length>=1 && actorId.length<=256,'Actor identity required');
    requireValue(typeof projectId==='string' && UUID.test(projectId),'Project UUID required');
    requireValue(['read','write'].includes(mode),'Unsupported transaction mode');
    requireValue(typeof callback==='function','Transactional callback required');
    const project=this.projects.get(projectId);
    requireValue(project,'Unknown project (fail-closed)');
    // Auth MUST happen before pool.connect. A guessed project UUID grants no access.
    const allowed=await this.authorize({actorId,projectId,mode});
    requireValue(allowed===true,'Tenant authorization denied');
    const client=await this.pool.connect();
    requireValue(client && typeof client.query==='function' && typeof client.release==='function','Invalid PostgreSQL connection');
    let active=false,broken=false;
    try{
      await client.query(mode==='read'?'BEGIN READ ONLY':'BEGIN');
      active=true;
      await client.query(`SET LOCAL statement_timeout = '${this.statementTimeoutMs}ms'`);
      await client.query("SET LOCAL lock_timeout = '2000ms'");
      // The connection role must only be a member of the explicitly granted NOLOGIN roles.
      await client.query(`SET LOCAL ROLE ${quoteIdent(mode==='read'?project.reader:project.writer)}`);
      await client.query(`SET LOCAL search_path = ${quoteIdent(project.schema)}, pg_catalog`);
      let usable=true;
      const scope=Object.freeze({
        query:async(text,params=[])=>{
          requireValue(usable && active,'Tenant transaction is already closed');
          requireValue(typeof text==='string' && text.length<=100000 && ALLOWED_SQL.test(text),
            'Only parameterized tenant DML/SELECT is allowed');
          requireValue(!text.includes(';') && !FORBIDDEN_SQL.test(text),'Transaction control or multiple SQL statements denied');
          requireValue(Array.isArray(params) && params.length<=1000,'Invalid PostgreSQL parameters');
          return client.query(text,params);
        }
      });
      try{
        const result=await callback(scope);
        usable=false;
        await client.query('COMMIT');
        active=false;
        return result;
      }finally{usable=false;}
    }catch(error){
      if(active){try{await client.query('ROLLBACK');}catch{broken=true;}}
      throw error;
    }finally{client.release(broken);}
  }
}

export async function openSignedTenantPgAdapter({pool,bundleDir,trustedPublicKey,authorize,statementTimeoutMs}){
  const {manifest}=await verifyTrustedMigration(bundleDir,trustedPublicKey);
  return new TenantPgAdapter({pool,manifest,authorize,statementTimeoutMs});
}
