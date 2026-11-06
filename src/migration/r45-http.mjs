// R4.5: owner-only, strictly opt-in synthetic encrypted backup/restore rehearsal.
import {join} from 'node:path';
import {bad,ok,protectOrigin} from '../common/http.mjs';
import {checkId,requireUser} from '../common/security.mjs';
import {validateR43Options} from './r43-pg-http.mjs';
import {runR45BackupDrill} from './r45-restore-drill.mjs';
import {appendR45Evidence,verifyR45Evidence} from './r45-evidence.mjs';
export const R45_PATH=/^\/api\/studio\/pg-preview\/projects\/([0-9a-f-]{36})\/backup-drill\/(check|history)$/;
const inProgress=new Set();
export function validateR45Options(env=process.env){
  if(env.OX_R45_BACKUP_DRILL!=='YES')return null;
  if(env.OX_R45_CONFIRM_SYNTHETIC!=='YES'||env.OX_R40_EPHEMERAL!=='YES')
    throw Error('R4.5 only allowed with explicit isolated synthetic test acknowledgement');
  if(env.OX_R44_CRITICAL_PARITY!=='YES'||env.OX_R44_CONFIRM_SYNTHETIC!=='YES')
    throw Error('R4.5 requires signed financial/workflow parity gate');
  const r43=validateR43Options(env);
  if(!r43?.shadowReplay||!r43.criticalParityGate)
    throw Error('R4.5 requires isolated R4.3 and R4.4 gates');
  return Object.freeze({...r43,backupDrill:true,productionCutoverAllowed:false});
}
export async function handleR45Request(req,res,{studioDb,runtime,dataDir,options}={}){
  if(!options?.backupDrill||!runtime?.adapter)bad(404,'R4.5 synthetic backup drill disabled');
  const match=new URL(req.url,'http://localhost').pathname.match(R45_PATH);
  if(!match)bad(404,'Маршрут проверки резервной копии не найден');
  const projectId=checkId(match[1]),action=match[2];
  if(action==='check'&&req.method==='POST')protectOrigin(req);
  else if(action==='history'&&req.method==='GET'){}
  else bad(405,'Метод не поддерживается');
  // Authorization BEFORE reading the SQLite file or signed archive.
  const owner=requireUser(req,studioDb,'ox_studio');
  const project=studioDb.prepare('SELECT id FROM projects WHERE id=? AND owner_id=? AND type=?')
    .get(projectId,owner.id,'crm');
  if(!project)bad(404,'CRM не найдена');
  const directory=join(dataDir,'.r45-backup-evidence',projectId);
  if(action==='history'){
    return ok(res,{projectId,...await verifyR45Evidence({directory,secret:options.secret}),
      source:'r45-synthetic-backup-evidence',productionCutoverAllowed:false});
  }
  if(inProgress.has(projectId))bad(409,'Проверка резервной копии уже выполняется');
  inProgress.add(projectId);
  try{
    const receipt=await runR45BackupDrill({
      sqlitePath:join(dataDir,'projects',projectId+'.sqlite'),projectId,actorId:owner.id,
      bundleDir:options.bundleDir,trustedPublicKey:options.trustedPublicKey,secret:options.secret});
    const evidence=await appendR45Evidence({directory,secret:options.secret,receipt});
    return ok(res,{projectId,receipt,evidence,productionCutoverAllowed:false,
      verdict:'synthetic-restore-only'});
  }finally{inProgress.delete(projectId);}
}
