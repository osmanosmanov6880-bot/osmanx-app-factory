/** Build data-free sample deployment ZIPs. Domains are documentation-only placeholders. */
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseStoredZip } from '../src/common/archive.mjs';
import { exportDeploymentBundle } from '../src/studio/deployment.mjs';
const root=resolve(import.meta.dirname,'..');
const out=resolve(process.argv[2]||join(root,'../../r29_samples'));
await mkdir(out,{recursive:true});
const temp=await mkdtemp(join(tmpdir(),'osmanx-r29-samples-'));
const cases=[
 ['restaurant','restaurant.example.com'],
 ['dental','dental.example.com'],
 ['auto','auto.example.com'],
 ['beauty','beauty.example.com'],
 ['retail','retail.example.com'],
 ['site','website.example.com']
];
for(const [industry,domain] of cases){
 const path=join(temp,industry+'.zip');
 const args=industry==='site'?['scripts/build_site_sample.mjs',path]:['scripts/build_industry_sample.mjs',industry,path];
 const child=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'});
 if(child.status!==0)throw Error('Could not create '+industry+': '+child.stderr);
 const entries=parseStoredZip(await readFile(path),{maxFiles:350,maxBytes:60*1024*1024});
 const project=JSON.parse(entries.get('config/project.json').toString('utf8'));
 const bundle=await exportDeploymentBundle(project,root,domain);
 const filename='OSMANX_'+industry.toUpperCase()+'_R29_PREVIEW_DEPLOY.zip';
 await writeFile(join(out,filename),bundle);
 console.log(filename,bundle.length,entries.size,'application files');
}
