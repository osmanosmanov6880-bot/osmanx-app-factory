// R4.6: isolated owner-only retained-backup API. Disabled by default.
// No caller-supplied file paths, key material, SQL, or recovery destination.
import {join} from 'node:path';
import {bad,ok,protectOrigin} from '../common/http.mjs';
import {checkId,requireUser} from '../common/security.mjs';
import {validateR45Options} from './r45-http.mjs';
import {createR46SignedBackup,verifyR46SignedBackup,listR46SignedBackups,
  rotateR46SignedBackup,pruneR46SignedBackups} from './r46-recovery.mjs';

export const R46_PATH=/^\/api\/studio\/pg-preview\/projects\/([0-9a-f-]{36})\/backup-vault\/(create|list|prune|verify\/[0-9a-f]{32}|rotate\/[0-9a-f]{32})$/;
const inProgress=new Set(),KEY=/^[a-z][a-z0-9_-]{2,31}$/,HEX=/^[0-9a-fA-F]{64}$/;
function requireSetting(test,msg){if(!test)throw Error('R4.6 configuration refused: '+msg);}
export function validateR46Options(env=process.env){
  if(env.OX_R46_VAULT!=='YES')return null;
  requireSetting(env.OX_R46_CONFIRM_SYNTHETIC==='YES'&&env.OX_R40_EPHEMERAL==='YES',
    'only isolated synthetic fixtures are allowed');
  const base=validateR45Options(env);
  requireSetting(base?.backupDrill===true,'R4.5 verified synthetic restore prerequisite required');
  const keyId=env.OX_R46_ACTIVE_KEY_ID,hex=env.OX_R46_ACTIVE_KEY_HEX;
  const catalog=env.OX_R46_CATALOG_KEY_HEX;
  requireSetting(KEY.test(keyId||'')&&HEX.test(hex||'')&&HEX.test(catalog||''),
    'external active encryption key and separate HMAC catalog key required');
  const keys={[keyId]:Buffer.from(hex,'hex')};
  if(env.OX_R46_PREVIOUS_KEY_ID||env.OX_R46_PREVIOUS_KEY_HEX){
    requireSetting(KEY.test(env.OX_R46_PREVIOUS_KEY_ID||'')&&
      HEX.test(env.OX_R46_PREVIOUS_KEY_HEX||'')&&env.OX_R46_PREVIOUS_KEY_ID!==keyId,
      'invalid previous key reference');
    keys[env.OX_R46_PREVIOUS_KEY_ID]=Buffer.from(env.OX_R46_PREVIOUS_KEY_HEX,'hex');
  }
  const catalogKey=Buffer.from(catalog,'hex');
  requireSetting(Object.values(keys).every(k=>!k.equals(catalogKey)),
    'catalog authentication key must be independent');
  const keep=Number(env.OX_R46_RETENTION_COUNT??3);
  requireSetting(Number.isSafeInteger(keep)&&keep>=2&&keep<=20,'retention must keep 2-20 archives');
  return {...base,vault:true,catalogKey,keyRing:{activeId:keyId,keys},retentionCount:keep,
    productionCutoverAllowed:false};
}
export async function handleR46Request(req,res,{studioDb,runtime,dataDir,options}={}){
  if(!options?.vault||!runtime?.adapter)bad(404,'Зашифрованное хранилище отключено');
  const path=new URL(req.url,'http://localhost').pathname,match=path.match(R46_PATH);
  if(!match)bad(404,'Маршрут резервных копий не найден');
  const projectId=checkId(match[1]),operation=match[2],verb=operation.split('/')[0];
  if(verb==='list'&&req.method==='GET'){}
  else if(req.method==='POST'&&['create','verify','rotate','prune'].includes(verb))
    protectOrigin(req);
  else bad(405,'Недопустимый метод');
  // Auth is always checked before creating directories or opening SQLite.
  const owner=requireUser(req,studioDb,'ox_studio');
  const project=studioDb.prepare('SELECT id FROM projects WHERE id=? AND owner_id=? AND type=?')
    .get(projectId,owner.id,'crm');
  if(!project)bad(404,'CRM не найдена');
  const config={projectId,actorId:owner.id,sqlitePath:join(dataDir,'projects',projectId+'.sqlite'),
    vaultDirectory:join(dataDir,'.r46-encrypted-vault',projectId),
    bundleDir:options.bundleDir,trustedPublicKey:options.trustedPublicKey,
    catalogKey:options.catalogKey,keyRing:options.keyRing};
  if(verb==='list'){
    const index=await listR46SignedBackups(config);
    return ok(res,{projectId,index,productionCutoverAllowed:false});
  }
  if(inProgress.has(projectId))bad(409,'Операция с копиями уже выполняется');
  inProgress.add(projectId);
  try{
    let result;
    try{
      if(verb==='create')result=await createR46SignedBackup(config);
      else if(verb==='verify')result=await verifyR46SignedBackup(config,operation.slice(7));
      else if(verb==='rotate')result=await rotateR46SignedBackup(config,operation.slice(7));
      else result=await pruneR46SignedBackups(config,options.retentionCount);
    }catch(error){
      if(/^(R4\.6 vault refused|R4\.6 signed backup refused):/.test(String(error?.message)))
        bad(409,'Проверка зашифрованных резервных копий не прошла');
      throw error;
    }
    return ok(res,{projectId,result,source:'r46-isolated-signed-vault',
      productionCutoverAllowed:false});
  }finally{inProgress.delete(projectId);}
}
