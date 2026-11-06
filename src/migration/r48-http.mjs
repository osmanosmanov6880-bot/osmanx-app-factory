// R4.8 signed external witness + measured disaster restore + secure alert API.
// Strictly synthetic until independent cloud/ops testing. No user-provided URLs.
import {join} from 'node:path';
import {bad,ok,protectOrigin} from '../common/http.mjs';
import {checkId,requireUser} from '../common/security.mjs';
import {verifyTrustedMigration} from './pg-trust.mjs';
import {validateR47Options} from './r47-http.mjs';
import {r47TenantToken} from './r47-offsite.mjs';
import {createR47Transport} from './r47-transport.mjs';
import {createR48S3Transport} from './r48-s3.mjs';
import {createR48WitnessClient} from './r48-witness.mjs';
import {createR48AlertSender,createR48AlertOutbox} from './r48-alerts.mjs';
import {runR48WitnessedSync,runR48RecoveryDrill,inspectR48Protection} from './r48-protection.mjs';

export const R48_PATH=/^\/api\/studio\/pg-preview\/projects\/([a-f0-9-]{36})\/recovery\/(sync|drill|status|alerts)$/;
const HEX=/^[a-f0-9A-F]{64}$/;
const active=new Set();
function guard(ok,msg){if(!ok)throw Error('R4.8 configuration refused: '+msg);}
export function validateR48Options(env=process.env){
  if(env.OX_R48_PROTECTION!=='YES')return null;
  guard(env.OX_R48_CONFIRM_SYNTHETIC==='YES'&&env.OX_R40_EPHEMERAL==='YES',
    'R4.8 only supports isolated synthetic fixtures');
  const base=validateR47Options(env);
  guard(base?.offsite===true,'R4.7 signed remote transport is required');
  const keys=['OX_R48_WITNESS_KEY_HEX','OX_R48_ALERT_QUEUE_KEY_HEX','OX_R48_ALERT_WEBHOOK_KEY_HEX'];
  guard(keys.every(k=>HEX.test(env[k]||'')),'three external independent 32-byte keys required');
  const [witnessKey,queueKey,webhookKey]=keys.map(k=>Buffer.from(env[k],'hex'));
  guard(!witnessKey.equals(queueKey)&&!witnessKey.equals(webhookKey)&&
    !queueKey.equals(webhookKey)&&!witnessKey.equals(base.catalogKey),
    'witness, outbox, webhook and vault keys must differ');
  guard(/^[A-Za-z0-9._~-]{32,256}$/.test(env.OX_R48_WITNESS_TOKEN||'')&&
    typeof env.OX_R48_WITNESS_ENDPOINT==='string'&&
    typeof env.OX_R48_ALERT_ENDPOINT==='string',
    'external witness credentials and alert destination required');
  const allowSyntheticLoopback=env.OX_R48_LOOPBACK_TEST==='YES';
  const dummy='a'.repeat(24);
  createR48WitnessClient({endpoint:env.OX_R48_WITNESS_ENDPOINT,
    token:env.OX_R48_WITNESS_TOKEN,secret:witnessKey,tenant:dummy,
    allowSyntheticLoopback});
  createR48AlertSender({endpoint:env.OX_R48_ALERT_ENDPOINT,secret:webhookKey,
    allowSyntheticLoopback});
  const useS3=env.OX_R48_USE_S3==='YES';
  let s3=null;
  if(useS3){
    s3={endpoint:env.OX_R48_S3_ENDPOINT,bucket:env.OX_R48_S3_BUCKET,
      region:env.OX_R48_S3_REGION,accessKey:env.OX_R48_S3_ACCESS_KEY,
      secretKey:env.OX_R48_S3_SECRET_KEY,
      sessionToken:env.OX_R48_S3_SESSION_TOKEN};
    createR48S3Transport({...s3,projectPrefix:dummy+'/',
      allowSyntheticLoopback});
  }
  const storeOrigin=new URL(useS3?s3.endpoint:base.endpoint).origin;
  guard(new URL(env.OX_R48_WITNESS_ENDPOINT).origin!==storeOrigin,
    'independent witness cannot share the remote object storage origin');
  const maxRtoMs=Number(env.OX_R48_MAX_RTO_MS||120000);
  const maxAgeMs=Number(env.OX_R48_MAX_CONFIRMED_BACKUP_AGE_MS||10800000);
  guard(Number.isSafeInteger(maxRtoMs)&&maxRtoMs>=1000&&maxRtoMs<=3600000&&
    Number.isSafeInteger(maxAgeMs)&&maxAgeMs>=60000&&maxAgeMs<=7*86400000,
    'invalid synthetic recovery thresholds');
  return {...base,protection:true,witnessKey,queueKey,webhookKey,
    witnessEndpoint:env.OX_R48_WITNESS_ENDPOINT,
    witnessToken:env.OX_R48_WITNESS_TOKEN,alertEndpoint:env.OX_R48_ALERT_ENDPOINT,
    allowSyntheticLoopback,useS3,s3,maxRtoMs,maxAgeMs,
    productionCutoverAllowed:false};
}
function ownerOf(studioDb,projectId,actorId){
  const project=studioDb.prepare('SELECT id FROM projects WHERE id=? AND owner_id=? AND type=?')
    .get(projectId,actorId,'crm');
  if(!project)bad(404,'CRM не найдена');
}
async function ctx({dataDir,projectId,actorId,options}){
  const {manifest,manifestSha256}=await verifyTrustedMigration(
    options.bundleDir,options.trustedPublicKey);
  const entry=manifest.databases.find(d=>d.projectId===projectId);
  guard(entry?.role==='crm','signed CRM project not found');
  const token=r47TenantToken(options.catalogKey,projectId);
  const vault={directory:join(dataDir,'.r46-encrypted-vault',projectId),
    projectId,manifestSha256,catalogKey:options.catalogKey,keyRing:options.keyRing};
  const remote=options.useS3?
    createR48S3Transport({...options.s3,projectPrefix:token+'/',
      allowSyntheticLoopback:options.allowSyntheticLoopback}):
    createR47Transport({endpoint:options.endpoint,token:options.remoteToken,
      tenantToken:token,allowLoopbackHttp:options.allowLoopbackHttp});
  const witness=createR48WitnessClient({endpoint:options.witnessEndpoint,
    token:options.witnessToken,secret:options.witnessKey,tenant:token,
    allowSyntheticLoopback:options.allowSyntheticLoopback});
  const sender=createR48AlertSender({endpoint:options.alertEndpoint,
    secret:options.webhookKey,allowSyntheticLoopback:options.allowSyntheticLoopback});
  const outbox=createR48AlertOutbox({directory:join(dataDir,'.r48-alerts',projectId),
    projectId,tenantToken:token,queueKey:options.queueKey,sender});
  return {vault,remote,witness,outbox,actorId,
    bundleDir:options.bundleDir,trustedPublicKey:options.trustedPublicKey};
}
async function serial(projectId,fn){
  if(active.has(projectId))bad(409,'Повторное восстановление уже выполняется');
  active.add(projectId);try{return await fn();}finally{active.delete(projectId);}
}
export async function handleR48Request(req,res,{studioDb,runtime,dataDir,options}={}){
  if(!options?.protection||!runtime?.adapter)bad(404,'Защита удалённых копий отключена');
  const match=new URL(req.url,'http://localhost').pathname.match(R48_PATH);
  if(!match)bad(404,'Маршрут не найден');
  const projectId=checkId(match[1]),action=match[2];
  if(action==='status'&&req.method==='GET'){}
  else if(req.method==='POST'&&['sync','drill','alerts'].includes(action))protectOrigin(req);
  else bad(405,'Метод запрещён');
  const owner=requireUser(req,studioDb,'ox_studio');
  ownerOf(studioDb,projectId,owner.id); // authorize BEFORE remote and local I/O
  return serial(projectId,async()=>{
    const input=await ctx({dataDir,projectId,actorId:owner.id,options});
    if(action==='status'){
      const protection=await inspectR48Protection(input,{maxConfirmedBackupAgeMs:options.maxAgeMs});
      const alerts=await input.outbox.status();
      return ok(res,{projectId,protection,alerts,
        healthy:protection.healthy&&alerts.pending===0,productionCutoverAllowed:false});
    }
    let result;
    try{
      if(action==='sync')result=await runR48WitnessedSync(input,{requireS3Controls:options.useS3});
      else if(action==='drill')result=await runR48RecoveryDrill(input,{
        maxRtoMs:options.maxRtoMs,maxConfirmedBackupAgeMs:options.maxAgeMs});
      else result=await input.outbox.flush();
    }catch(e){
      if(/^R4\.[78] /.test(String(e?.message||'')))
        bad(409,'Защитная проверка удалённой копии не пройдена');
      throw e;
    }
    return ok(res,{projectId,result,productionCutoverAllowed:false});
  });
}
export function startR48ProtectionMonitoring({studioDb,runtime,dataDir,options}={}){
  if(!options?.protection||!runtime?.adapter||!options.scheduleProjects.length)return null;
  let stopped=false,busy=false;
  const tick=async()=>{
    if(stopped||busy)return;
    busy=true;
    try{
      for(const projectId of options.scheduleProjects){
        if(stopped)break;
        const owner=studioDb.prepare('SELECT owner_id FROM projects WHERE id=? AND type=?')
          .get(projectId,'crm');
        if(!owner||active.has(projectId))continue;
        active.add(projectId);
        try{
          const input=await ctx({dataDir,projectId,actorId:owner.owner_id,options});
          await inspectR48Protection(input,{maxConfirmedBackupAgeMs:options.maxAgeMs});
          await input.outbox.flush();
        }catch{console.error('R4.8 synthetic remote monitoring check failed');}
        finally{active.delete(projectId);}
      }
    }finally{busy=false;}
  };
  const timer=setInterval(()=>void tick(),65000);
  timer.unref?.();
  return {tick,stop(){stopped=true;clearInterval(timer);}};
}
