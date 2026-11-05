import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOperation } from './src/common/operations.mjs';
const root=dirname(fileURLToPath(import.meta.url));
runOperation(root,process.argv.slice(2)).catch(err=>{console.error('[OSMANX OPS] '+err.message);process.exitCode=1;});
