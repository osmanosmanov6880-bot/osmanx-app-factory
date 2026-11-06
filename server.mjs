import { createServer } from 'node:http';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioDb } from './src/studio/db.mjs';
import { getProject, handleStudioRequest } from './src/studio/routes.mjs';
import { crmDb } from './src/crm/db.mjs';
import { handleCrmRequest } from './src/crm/routes.mjs';
import { siteDb } from './src/site/db.mjs';
import { handleSiteRequest } from './src/site/routes.mjs';
import { bad, json, respondError, securityHeaders } from './src/common/http.mjs';
import { sessionFromRequest, assertSafePublicBootstrap } from './src/common/security.mjs';
import { acquireLock } from './src/common/maintenance.mjs';
import { createR40Runtime, handleR40PreviewRequest, R40_PREFIX } from './src/migration/r40-pg-http.mjs';
import {handleR41PreviewRequest} from './src/migration/r41-pg-workflows.mjs';
import {handleR42Request,validateR42Options,R42_PATH} from './src/migration/r42-pg-http.mjs';
import {handleR43Request,validateR43Options,R43_PATH} from './src/migration/r43-pg-http.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const data=resolve(process.env.DATA_DIR || resolve(root,'data'));
const releaseLock=acquireLock(data,'server');
let db;
try{db=studioDb(resolve(data,'studio.sqlite'));}catch(e){releaseLock();throw e;}
const crmCache=new Map();
// Strictly opt-in PostgreSQL staging API. Any failed setup aborts server startup.
let pgPreview,r42Options,r43Options;
try {
  r42Options=validateR42Options(process.env);
  r43Options=validateR43Options(process.env);
  pgPreview=await createR40Runtime({studioDb:db});
} catch(error) {db.close();releaseLock();throw error;}
const port=Number(process.env.PORT||4173);
const host=process.env.HOST||'127.0.0.1';
assertSafePublicBootstrap(host,!!db.prepare('SELECT id FROM users LIMIT 1').get());
const server=createServer(async(req,res)=>{
  try {
    securityHeaders(res);
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/api/health') return json(res,{ok:true,service:'osmanx-app-factory',version:'1.3.0'});
    if(R43_PATH.test(url.pathname))
      return await handleR43Request(req,res,{studioDb:db,runtime:pgPreview,dataDir:data,options:r43Options});
    if(R42_PATH.test(url.pathname))
      return await handleR42Request(req,res,{studioDb:db,runtime:pgPreview,dataDir:data,options:r42Options});
    if(/^\/api\/studio\/pg-preview\/projects\/[0-9a-f-]{36}\/(tasks|visits)(\/|$)/.test(url.pathname))
      return await handleR41PreviewRequest(req,res,{studioDb:db,runtime:pgPreview});
    if(url.pathname.startsWith(R40_PREFIX + '/')) return await handleR40PreviewRequest(req,res,{studioDb:db,runtime:pgPreview});
    const match=url.pathname.match(/^\/workspace\/([0-9a-f-]{36})(\/.*|$)/);
    if(match) {
      const project=getProject(db,match[1]);
      if(!project) bad(404,'Проект не найден');
      if(req.method==='POST' && (url.pathname===`/workspace/${project.id}/api/setup` || (project.type==='site'&&url.pathname===`/workspace/${project.id}/api/site/setup`))) {
        const owner=sessionFromRequest(req,db,'ox_studio');
        const row=db.prepare('SELECT owner_id FROM projects WHERE id=?').get(project.id);
        if(!owner || row?.owner_id!==owner.id || req.headers['x-studio-csrf-token']!==owner.csrf) bad(403,'Первого администратора CRM должен создать авторизованный владелец фабрики');
      }
      if(project.type==='site'){
        if(!crmCache.has(project.id))crmCache.set(project.id,siteDb(resolve(data,'projects',`${project.id}.sqlite`),project));
        else {
          // Source pages in Studio update only pages not edited locally in the site's CMS.
          const {syncSite}=await import('./src/site/db.mjs');
          syncSite(crmCache.get(project.id),project);
        }
        return await handleSiteRequest(req,res,{db:crmCache.get(project.id),config:project,
          base:`/workspace/${project.id}`,staticRoot:resolve(root,'public/site'),cookieName:'ox_site'});
      }
      if(!crmCache.has(project.id)) crmCache.set(project.id,crmDb(resolve(data,'projects',`${project.id}.sqlite`),project.entities,project.automationPresets||[],project.modules));
      if(url.pathname.startsWith(`/workspace/${project.id}/api/pg-preview/`))
        return await handleR41PreviewRequest(req,res,{studioDb:db,runtime:pgPreview,crmDb:crmCache.get(project.id),workspaceProjectId:project.id});
      return await handleCrmRequest(req,res,{db:crmCache.get(project.id),config:project,
        base:`/workspace/${project.id}`,staticRoot:resolve(root,'public/crm'),cookieName:'ox_crm'});
    }
    await handleStudioRequest(req,res,{db,root});
  } catch(err) { respondError(res,err); }
});
server.listen(port,host,()=>console.log(`OSMANX APP FACTORY http://${host}:${port}`));
function close() {server.close(async()=>{try{await pgPreview?.close();}finally{for(const crm of crmCache.values())crm.close();db.close();releaseLock();process.exit(0);}});}
process.on('SIGINT',close);process.on('SIGTERM',close);
