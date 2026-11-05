import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSiteBackupCommand } from './src/site/backup.mjs';
const root=dirname(fileURLToPath(import.meta.url));
try{const output=await runSiteBackupCommand(root,process.argv[2],process.argv.slice(3));console.log(JSON.stringify(output,null,2));}
catch(error){console.error('OSMANX site maintenance:',error.message);process.exitCode=1;}
