import { createServer } from 'node:http';
import { createRequestDrain } from './src/common/request-drain.mjs';
import { createRuntimeCounters } from './src/common/runtime-health.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crmDb } from './src/crm/db.mjs';
import { handleCrmRequest } from './src/crm/routes.mjs';
import { respondError, securityHeaders } from './src/common/http.mjs';
import { assertSafePublicBootstrap } from './src/common/security.mjs';
import { acquireLock } from './src/common/maintenance.mjs';
import { existsSync } from 'node:fs';

const root=dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(readFileSync(resolve(root,'config/project.json'),'utf8'));
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'));
if(manifest.projectId!==config.id || !Number.isSafeInteger(manifest.release?.sequence)) throw Error('Invalid deployment identity');
const deploymentIdentity={projectId:config.id,releaseSequence:manifest.release.sequence};
const dataDir=resolve(process.env.DATA_DIR || resolve(root,'data'));
if(existsSync(resolve(dataDir,'update-in-progress.json')))throw Error('Interrupted upgrade: run node ops.mjs recover --confirm before starting CRM');
const releaseLock=acquireLock(dataDir,'server');
let db;
try{db=crmDb(resolve(dataDir,'crm.sqlite'),config.entities||[],config.automationPresets||[],config.modules);}catch(e){releaseLock();throw e;}
const counters=await createRuntimeCounters({dataDir,projectId:config.id,service:'crm',releaseSequence:manifest.release.sequence});
const port=Number(process.env.PORT || 4180);
const host=process.env.HOST || '127.0.0.1';
assertSafePublicBootstrap(host,!!db.prepare('SELECT id FROM users LIMIT 1').get());
const drain=createRequestDrain(async(req,res)=>{
  try {
    securityHeaders(res);
    await handleCrmRequest(req,res,{db,config,base:'',staticRoot:resolve(root,'public/crm'),cookieName:'ox_crm',deploymentIdentity});
  } catch(err) { respondError(res,err); }
});
const server=createServer((req,res)=>{res.once('finish',()=>counters.record(res.statusCode));return drain.handle(req,res)});
server.listen(port,host,()=>console.log(`OSMANX Business CRM: http://${host}:${port}`));
function close(){drain.stop(server,async()=>{try{await counters.flush()}finally{db.close();releaseLock()}}).catch(e=>{console.error('CRM graceful shutdown: '+e.message);process.exitCode=1});}
process.once('SIGINT',close);process.once('SIGTERM',close);
