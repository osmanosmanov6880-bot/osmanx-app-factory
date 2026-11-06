// R4.3 owner-gated, synthetic-only shadow replay. Never targets live SQLite.
import {join} from 'node:path';
import {bad,ok,protectOrigin} from '../common/http.mjs';
import {checkId,requireUser} from '../common/security.mjs';
import {validateR42Options} from './r42-pg-http.mjs';
import {runR43ShadowReplay} from './r43-shadow-replay.mjs';
import {appendR43Checkpoint,verifyR43Checkpoints} from './r43-replay-journal.mjs';

export const R43_PATH=/^\/api\/studio\/pg-preview\/projects\/([0-9a-f-]{36})\/shadow-replay\/(check|history)$/;
const inProgress=new Set();
export function validateR43Options(env=process.env){
  if(env.OX_R43_SHADOW_REPLAY!=='YES')return null;
  if(env.OX_R43_CONFIRM_SYNTHETIC!=='YES')throw Error('R4.3 requires explicit synthetic fixture acknowledgement');
  const r42=validateR42Options(env);
  if(!r42)throw Error('R4.3 requires signed R4.2 reconciliation preview');
  return Object.freeze({...r42,shadowReplay:true,productionCutoverAllowed:false});
}
export async function handleR43Request(req,res,{studioDb,runtime,dataDir,options}={}){
  if(!runtime?.adapter||!options?.shadowReplay)bad(404,'R4.3 shadow replay disabled');
  const route=new URL(req.url,'http://localhost').pathname.match(R43_PATH);
  if(!route)bad(404,'Маршрут не найден');
  const projectId=checkId(route[1]),action=route[2];
  if(action==='check'&&req.method==='POST')protectOrigin(req);
  else if(action==='history'&&req.method==='GET'){}
  else bad(405,'Метод не поддерживается');
  // All identity checks occur before signed PostgreSQL or filesystem access.
  const owner=requireUser(req,studioDb,'ox_studio');
  const project=studioDb.prepare('SELECT id FROM projects WHERE id=? AND owner_id=? AND type=?')
    .get(projectId,owner.id,'crm');
  if(!project)bad(404,'CRM не найдена');
  const historyDir=join(dataDir,'.r43-checkpoints',projectId);
  if(action==='history'){
    const history=await verifyR43Checkpoints({directory:historyDir,secret:options.secret});
    return ok(res,{projectId,...history,source:'r43-synthetic-checkpoints',productionCutoverAllowed:false});
  }
  if(inProgress.has(projectId))bad(409,'Сверка проекта уже выполняется');
  inProgress.add(projectId);
  try{
    let receipt;
    try{
      receipt=await runR43ShadowReplay({sqlitePath:join(dataDir,'projects',projectId+'.sqlite'),
        adapter:runtime.adapter,bundleDir:options.bundleDir,trustedPublicKey:options.trustedPublicKey,
        actorId:owner.id,projectId,secret:options.secret});
    }catch(error){
      if(String(error.message||'').startsWith('R4.3 shadow replay denied:'))
        bad(409,'Несанкционированное расхождение PostgreSQL, перенос остановлен');
      throw error;
    }
    const checkpoint=await appendR43Checkpoint({directory:historyDir,secret:options.secret,receipt});
    return ok(res,{projectId,receipt,checkpoint,
      verdict:'shadow-replay-verified-only',productionCutoverAllowed:false});
  }finally{inProgress.delete(projectId);}
}
