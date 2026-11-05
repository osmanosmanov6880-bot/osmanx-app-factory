import { createServer } from 'node:http';
import { createRequestDrain } from './src/common/request-drain.mjs';
import { createRuntimeCounters } from './src/common/runtime-health.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { siteDb } from './src/site/db.mjs';
import { handleSiteRequest } from './src/site/routes.mjs';
import { respondError, securityHeaders } from './src/common/http.mjs';
import { assertSafePublicBootstrap } from './src/common/security.mjs';
import { acquireLock } from './src/common/maintenance.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(readFileSync(resolve(root,'config/project.json'),'utf8'));
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'));
if(manifest.projectId!==config.id || !Number.isSafeInteger(manifest.release?.sequence)) throw Error('Invalid deployment identity');
const deploymentIdentity={projectId:config.id,releaseSequence:manifest.release.sequence};
if(config.type!=='site')throw Error('This archive is not a website project');
const dataDir=resolve(process.env.DATA_DIR||resolve(root,'data'));
const lock=acquireLock(dataDir,'server');
let db;
try{db=siteDb(resolve(dataDir,'site.sqlite'),config);}catch(e){lock();throw e;}
const counters=await createRuntimeCounters({dataDir,projectId:config.id,service:'site',releaseSequence:manifest.release.sequence});
const port=Number(process.env.PORT||4181),host=process.env.HOST||'127.0.0.1';
assertSafePublicBootstrap(host,!!db.prepare('SELECT id FROM users LIMIT 1').get());
const drain=createRequestDrain(async(req,res)=>{
 try{securityHeaders(res);await handleSiteRequest(req,res,{db,config,base:'',staticRoot:resolve(root,'public/site'),deploymentIdentity});}
 catch(e){respondError(res,e);}
});
const server=createServer((req,res)=>{res.once('finish',()=>counters.record(res.statusCode));return drain.handle(req,res)});
server.listen(port,host,()=>console.log(`OSMANX Website: http://${host}:${port}`));
function close(){drain.stop(server,async()=>{try{await counters.flush()}finally{db.close();lock()}}).catch(e=>{console.error('Site graceful shutdown: '+e.message);process.exitCode=1});}
process.once('SIGINT',close);process.once('SIGTERM',close);
