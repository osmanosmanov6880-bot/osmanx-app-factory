/** R3.6 read-only, in-container summary. Never opens customer SQLite or HTTP logs. */
import {readFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadRuntimeSummary} from '../../src/common/runtime-health.mjs';

export async function readInstalledRuntimeSummary({root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),dataDir=process.env.DATA_DIR||join(root,'data')}={}){
 const app=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
 const service=app.format==='osmanx-standalone-release'?'crm':app.format==='osmanx-standalone-site'?'site':null;
 if(!service||!app.projectId||!Number.isSafeInteger(app.release?.sequence))throw Error('Invalid installed application identity');
 return loadRuntimeSummary({dataDir,projectId:app.projectId,service,releaseSequence:app.release.sequence});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 readInstalledRuntimeSummary().then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error('R3.6 COUNTERS: '+e.message);process.exitCode=1});
}
