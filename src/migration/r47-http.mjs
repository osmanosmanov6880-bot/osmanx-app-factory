// R4.7 Studio owner-only remote archive sync, independent restore and
// opt-in per-project scheduled backup. No user URLs, file paths or secrets.
import {join} from 'node:path';
import {bad,ok,protectOrigin} from '../common/http.mjs';
import {checkId,requireUser} from '../common/security.mjs';
import {validateR46Options} from './r46-http.mjs';
import {verifyTrustedMigration} from './pg-trust.mjs';
import {createR46SignedBackup,listR46SignedBackups,pruneR46SignedBackups} from './r46-recovery.mjs';
import {createR47Transport} from './r47-transport.mjs';
import {r47TenantToken,synchronizeR47Offsite,verifyR47OffsiteDrill,
  inspectR47OffsiteStatus} from './r47-offsite.mjs';
import {startR47Scheduler,readR47Schedule,runR47DueTick,assessR47BackupHealth} from './r47-scheduler.mjs';
export const R47_PATH=/^\/api\/studio\/pg-preview\/projects\/([a-f0-9-]{36})\/offsite\/(sync|restore-check|tick|status)$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX=/^[a-f0-9A-F]{64}$/,active=new Set();
function check(ok,msg){if(!ok)throw Error('R4.7 configuration refused: '+msg);}
export function validateR47Options(env=process.env){
  if(env.OX_R47_OFFSITE!=='YES')return null;
  check(env.OX_R40_EPHEMERAL==='YES'&&env.OX_R47_CONFIRM_SYNTHETIC==='YES',
    'only isolated synthetic fixtures are supported');
  const base=validateR46Options(env);
  check(base?.vault===true,'R4.6 encrypted local vault prerequisite required');
  check(typeof env.OX_R47_ENDPOINT==='string'&&env.OX_R47_ENDPOINT.length>0&&
    HEX.test(env.OX_R47_REMOTE_TOKEN||''),'remote fixed URL and independent 32-byte token required');
  const allowLoopbackHttp=env.OX_R47_LOOPBACK_TEST==='YES';
  // Validate the URL and token here; do not wait until the first request.
  createR47Transport({endpoint:env.OX_R47_ENDPOINT,token:env.OX_R47_REMOTE_TOKEN,
    tenantToken:'a'.repeat(24),allowLoopbackHttp});
  const intervalMinutes=Number(env.OX_R47_INTERVAL_MINUTES??60);
  const maxAgeMinutes=Number(env.OX_R47_MAX_AGE_MINUTES??180);
  check(Number.isSafeInteger(intervalMinutes)&&intervalMinutes>=1&&intervalMinutes<=1440&&
    Number.isSafeInteger(maxAgeMinutes)&&maxAgeMinutes>=intervalMinutes*2&&maxAgeMinutes<=10080,
    'invalid backup interval or staleness threshold');
  const ids=(env.OX_R47_SCHEDULE_PROJECT_IDS||'').split(',').filter(Boolean);
  check(ids.length<=20&&ids.every(id=>UUID.test(id))&&new Set(ids).size===ids.length,
    'schedule project allowlist must contain at most 20 unique UUIDs');
  return {...base,offsite:true,endpoint:env.OX_R47_ENDPOINT,
    remoteToken:env.OX_R47_REMOTE_TOKEN,allowLoopbackHttp,
    intervalMinutes,maxAgeMinutes,scheduleProjects:ids,productionCutoverAllowed:false};
}
function ownerProject(studioDb,projectId,owner){
  const project=studioDb.prepare('SELECT id, owner_id FROM projects WHERE id=? AND owner_id=? AND type=?')
    .get(projectId,owner,'crm');
  if(!project)bad(404,'CRM не найдена');
  return project;
}
async function context({dataDir,projectId,actorId,options}){
  const {manifest,manifestSha256}=await verifyTrustedMigration(options.bundleDir,options.trustedPublicKey);
  const entry=manifest.databases.find(d=>d.projectId===projectId);
  check(entry?.role==='crm','signed CRM source project missing');
  const config={projectId,actorId,
    sqlitePath:join(dataDir,'projects',projectId+'.sqlite'),
    vaultDirectory:join(dataDir,'.r46-encrypted-vault',projectId),
    bundleDir:options.bundleDir,trustedPublicKey:options.trustedPublicKey,
    catalogKey:options.catalogKey,keyRing:options.keyRing};
  const vault={directory:config.vaultDirectory,projectId,manifestSha256,
    catalogKey:options.catalogKey,keyRing:options.keyRing};
  const remote=createR47Transport({endpoint:options.endpoint,token:options.remoteToken,
    tenantToken:r47TenantToken(options.catalogKey,projectId),
    allowLoopbackHttp:options.allowLoopbackHttp});
  const schedule={directory:join(dataDir,'.r47-schedule',projectId),
    projectId,catalogKey:options.catalogKey};
  return {config,vault,remote,schedule,entry};
}
async function restore(ctx){
  return verifyR47OffsiteDrill({vault:ctx.vault,remote:ctx.remote,
    bundleDir:ctx.config.bundleDir,trustedPublicKey:ctx.config.trustedPublicKey,
    actorId:ctx.config.actorId});
}
async function sync(ctx){
  const published=await synchronizeR47Offsite({vault:ctx.vault,remote:ctx.remote});
  const restoreProof=await restore(ctx);
  if(!restoreProof.restoredIntegrityVerified||!published.remoteReadbackVerified)
    throw Error('R4.7 offsite refused: remote restore proof failed');
  return {published,restoreProof,remoteReadbackVerified:true,
    restoredIntegrityVerified:true,productionCutoverAllowed:false};
}
async function tick(ctx,options){
  return runR47DueTick(ctx.schedule,{intervalMinutes:options.intervalMinutes,execute:async()=>{
    // An unfinished previous upload is re-synced, not pruned or silently lost.
    let local=await listR46SignedBackups(ctx.config);
    let aligned=false;
    if(local.activeCount>0){
      try{aligned=(await inspectR47OffsiteStatus({vault:ctx.vault,remote:ctx.remote})).healthy;}
      catch{aligned=false;}
      if(!aligned)await sync(ctx);
    }
    if(local.activeCount===0||aligned){
      await createR46SignedBackup(ctx.config);
      local=await listR46SignedBackups(ctx.config);
    }
    let published=await sync(ctx);
    if(local.activeCount>options.retentionCount){
      await pruneR46SignedBackups(ctx.config,options.retentionCount);
      published=await sync(ctx);
    }
    return {...published,remoteReadbackVerified:true,
      restoredIntegrityVerified:true,productionCutoverAllowed:false};
  }});
}
async function serialized(projectId,run){
  if(active.has(projectId))bad(409,'Резервное копирование уже выполняется');
  active.add(projectId);try{return await run();}finally{active.delete(projectId);}
}
export async function handleR47Request(req,res,{studioDb,runtime,dataDir,options}={}){
  if(!options?.offsite||!runtime?.adapter)bad(404,'Удалённое резервное копирование отключено');
  const match=new URL(req.url,'http://localhost').pathname.match(R47_PATH);
  if(!match)bad(404,'Маршрут не найден');
  const projectId=checkId(match[1]),operation=match[2];
  if(operation==='status'&&req.method==='GET'){}
  else if(req.method==='POST'&&['sync','restore-check','tick'].includes(operation))
    protectOrigin(req);
  else bad(405,'Метод запрещён');
  const owner=requireUser(req,studioDb,'ox_studio');
  ownerProject(studioDb,projectId,owner.id);
  const ctx=await context({dataDir,projectId,actorId:owner.id,options});
  if(operation==='status'){
    const state=await readR47Schedule(ctx.schedule);
    const scheduleHealth=assessR47BackupHealth(state,{maxAgeMinutes:options.maxAgeMinutes});
    let remoteHealth;
    try{remoteHealth=await inspectR47OffsiteStatus({vault:ctx.vault,remote:ctx.remote});}
    catch{remoteHealth={remoteReachable:false,remoteMatchesLocal:false,healthy:false};}
    return ok(res,{projectId,scheduleHealth,remoteHealth,
      healthy:scheduleHealth.healthy&&remoteHealth.healthy,productionCutoverAllowed:false});
  }
  return serialized(projectId,async()=>{
    let result;
    try{
      if(operation==='sync')result=await sync(ctx);
      else if(operation==='restore-check')result=await restore(ctx);
      else result=await tick(ctx,options);
    }catch(e){
      if(/^(R4\.[567] |R4\.7 )/.test(String(e.message||'')))
        bad(409,'Проверка удалённой копии не прошла');
      throw e;
    }
    return ok(res,{projectId,result,productionCutoverAllowed:false});
  });
}
export function startR47AutomaticBackups({studioDb,runtime,dataDir,options}={}){
  if(!options?.offsite||!runtime?.adapter||!options.scheduleProjects?.length)return null;
  return startR47Scheduler({projects:options.scheduleProjects,periodMs:60000,
    run:async projectId=>{
      const project=studioDb.prepare('SELECT id,owner_id FROM projects WHERE id=? AND type=?')
        .get(projectId,'crm');
      if(!project)return;
      const ctx=await context({dataDir,projectId,actorId:project.owner_id,options});
      return serialized(projectId,()=>tick(ctx,options));
    },
    onError:()=>{console.error('R4.7 isolated scheduled backup failed; inspect owner status API');}
  });
}
