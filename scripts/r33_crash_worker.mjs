/** Internal isolated child: exercises an actual SIGKILL at an upgrade boundary. */
import {resolve} from 'node:path';
import {runMaintenance} from '../templates/deploy/maintenance.mjs';
import {applyUpgrade} from '../templates/deploy/upgrade.mjs';
const [root,zipPath,dataDir,phase]=process.argv.slice(2);
if(!root||!zipPath||!dataDir||!['after-stop','before-new-boot'].includes(phase))throw Error('Invalid crash fixture');
if(process.env.OSMANX_R33_SYNTHETIC_CRASH!=='YES')throw Error('Crash injection explicitly disabled');
const forceKill=()=>{process.kill(process.pid,'SIGKILL')};
const adapter={
 async stop(){if(phase==='after-stop')forceKill()},
 async backup(){return runMaintenance({root,dataDir,backupDir:resolve(root,'backups'),command:'backup'})},
 async restore(_,id){return runMaintenance({root,dataDir,backupDir:resolve(root,'backups'),command:'restore',id,confirm:true})},
 async up(){if(phase==='before-new-boot')forceKill()},
 async health(){},
 async observe(){return {observedStable:true,samplesCompleted:3}}
};
await applyUpgrade({root,zipPath,confirm:true,requireSignature:true,adapter});
throw Error('Expected synthetic process kill did not occur');
