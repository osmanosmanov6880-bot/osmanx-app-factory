import {createHash} from 'node:crypto';
import {parseStoredZip} from './archive.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
export function verifyStandalonePackage(buffer){
 const files=parseStoredZip(buffer,{maxFiles:250,maxBytes:30*1024*1024});
 const manifestData=files.get('manifest.json');const configData=files.get('config/project.json');
 if(!manifestData||!configData)throw Error('Manifest or project configuration missing');
 let manifest,config;
 try{manifest=JSON.parse(manifestData.toString('utf8'));config=JSON.parse(configData.toString('utf8'));}catch{throw Error('Invalid package JSON')}
 if(manifest.manifestVersion!==1||!['osmanx-standalone-release','osmanx-standalone-site'].includes(manifest.format))throw Error('Unsupported standalone format');
 const expected=manifest.files;
 if(!expected||typeof expected!=='object'||Array.isArray(expected))throw Error('Invalid manifest file map');
 const entries=[...files.keys()].filter(name=>name!=='manifest.json');
 if(Object.keys(expected).length!==entries.length)throw Error('Manifest file count mismatch');
 for(const name of entries){
   if(!Object.hasOwn(expected,name)||typeof expected[name]!=='string'||sha(files.get(name))!==expected[name])throw Error('Manifest hash mismatch: '+name);
   if(name.startsWith('data/')||/(?:^|\/)(?:\.env|.*\.sqlite|.*\.sqlite-wal|.*\.sqlite-shm|.*\.db)$/.test(name)&&name!=='.env.example')throw Error('Package must not contain runtime data: '+name);
 }
 if(config.id!==manifest.projectId||!Array.isArray(config.modules)||!Array.isArray(config.pages))throw Error('Invalid project config');
 if(config.type==='crm'&&manifest.format!=='osmanx-standalone-release')throw Error('CRM format mismatch');
 if(config.type==='site'&&manifest.format!=='osmanx-standalone-site')throw Error('Site format mismatch');
 if(!['crm','site'].includes(config.type))throw Error('Unsupported product type');
 if(!files.has('run.mjs')||!files.has('src/common/http.mjs')||!files.has('package.json'))throw Error('Missing executable project files');
 const sensitive=new Set(['password','password_hash','session','session_token','session_hash','token_hash','csrf_token','access_token','refresh_token']);
 const check=(obj)=>{
  if(obj===null||typeof obj!=='object')return;
  for(const [key,val] of Object.entries(obj)){
   if(sensitive.has(key.toLowerCase()))throw Error('Private data found in project configuration: '+key);
   check(val);
  }
 };
 check(config);
 return {ok:true,type:config.type,industry:config.industry,projectId:config.id,fileCount:entries.length,applicationVersion:manifest.applicationVersion||null,workflowPresets:config.automationPresets?.length||0,configBytes:configData.length};
}
