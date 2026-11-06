// R4.2 owner-only, explicitly enabled reconciliation endpoints.
// Never switches database runtime and does not accept arbitrary source paths.
import {join} from 'node:path';
import {bad,json,ok,protectOrigin} from '../common/http.mjs';
import {checkId,requireUser} from '../common/security.mjs';
import {reconcileSignedTenant,assessCutoverReadiness} from './r42-reconcile.mjs';
import {appendR42Journal,verifyR42Journal} from './r42-journal.mjs';

export const R42_PATH=/^\/api\/studio\/pg-preview\/projects\/([0-9a-f-]{36})\/reconcile\/(check|history)$/;
export function validateR42Options(env=process.env){
  if(env.OX_R42_PG_RECONCILIATION!=='YES')return null;
  if(env.OX_R40_PG_PREVIEW!=='YES')throw Error('R4.2 requires the isolated R4.0 Preview');
  if(!/^[0-9a-fA-F]{64}$/.test(env.OX_R42_JOURNAL_HMAC_KEY||''))
    throw Error('R4.2 requires an external 32-byte hex journal key');
  if(!env.OX_R40_PG_BUNDLE||!env.OX_R40_PG_TRUST_KEY)
    throw Error('R4.2 requires a signed, externally trusted migration bundle');
  return Object.freeze({enabled:true,secret:Buffer.from(env.OX_R42_JOURNAL_HMAC_KEY,'hex'),
    bundleDir:env.OX_R40_PG_BUNDLE,trustedPublicKey:env.OX_R40_PG_TRUST_KEY});
}
export async function handleR42Request(req,res,{studioDb,runtime,dataDir,options}={}){
  if(!runtime?.adapter||!options?.enabled)bad(404,'PostgreSQL reconciliation is disabled');
  const route=new URL(req.url,'http://localhost').pathname.match(R42_PATH);
  if(!route)bad(404,'Маршрут сверки не найден');
  const projectId=checkId(route[1]),action=route[2];
  if(action==='check'&&req.method==='POST')protectOrigin(req);
  else if(action==='history'&&req.method==='GET'){}
  else bad(405,'Метод не поддерживается');
  // Authenticate and authorize before connecting to Postgres or reading a tenant file.
  const owner=requireUser(req,studioDb,'ox_studio');
  const project=studioDb.prepare('SELECT id,owner_id,type FROM projects WHERE id=? AND owner_id=?')
    .get(projectId,owner.id);
  if(!project||project.type!=='crm')bad(404,'CRM не найдена');
  const directory=join(dataDir,'.r42-reconciliation',projectId);
  if(action==='history'){
    const status=await verifyR42Journal({directory,secret:options.secret});
    return ok(res,{source:'r42-verified-journal',projectId,...status,productionCutoverAllowed:false});
  }
  const result=await reconcileSignedTenant({sqlitePath:join(dataDir,'projects',projectId+'.sqlite'),
    adapter:runtime.adapter,bundleDir:options.bundleDir,trustedPublicKey:options.trustedPublicKey,
    actorId:owner.id,projectId,secret:options.secret});
  const readiness=assessCutoverReadiness(result);
  const journal=await appendR42Journal({directory,secret:options.secret,receipt:result});
  return json(res,{ok:true,source:'r42-reconciliation',projectId,report:result,readiness,journal},200);
}
