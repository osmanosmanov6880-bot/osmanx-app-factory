import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { createZip } from '../common/zip.mjs';

async function walk(root, dir, into) {
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    const path=join(dir,entry.name);
    if (entry.isDirectory()) await walk(root,path,into);
    else if (entry.isFile()) into.push({name:relative(root,path).replaceAll('\\','/'),data:await readFile(path)});
  }
}
const sha=data=>createHash('sha256').update(data).digest('hex');
export async function exportProject(project, projectRoot, release=null) {
  if(project.type==='site')return exportSite(project,projectRoot,release);
  const files=[];
  await walk(projectRoot,join(projectRoot,'src/common'),files);
  await walk(projectRoot,join(projectRoot,'src/crm'),files);
  await walk(projectRoot,join(projectRoot,'public/crm'),files);
  const run=await readFile(join(projectRoot,'templates/standalone/run.mjs'));
  const ops=await readFile(join(projectRoot,'templates/standalone/ops.mjs'));
  files.push({name:'run.mjs',data:run});
  files.push({name:'ops.mjs',data:ops});
  files.push({name:'config/project.json',data:JSON.stringify(project,null,2)+'\n'});
  files.push({name:'package.json',data:JSON.stringify({
    name:'osmanx-'+project.id.slice(0,8)+'-crm',version:'1.3.0',private:true,type:'module',
    engines:{node:'>=22.16.0'},scripts:{start:'node run.mjs',backup:'node ops.mjs backup',plan:'node ops.mjs plan'}
  },null,2)+'\n'});
  files.push({name:'.env.example',data:'PORT=4180\nHOST=127.0.0.1\nCOOKIE_SECURE=0\n'});
  files.push({name:'.gitignore',data:'data/\n.env\nbackups/\n.osmanx-upgrades/\n.osmanx-volume-migration/\n.osmanx-rollout/\n.osmanx-acceptance/\n.osmanx-fleet/\n.osmanx-trust/\nrelease-keys/\n*.pem\n*.key\nartifacts/\n*.log\n'});
  files.push({name:'README.md',data:`# ${project.name}\n\nAutonomous industry CRM with manual payment ledger and conditional local automation rules, exported by OSMANX APP FACTORY R1.3.\n\nRequires Node.js >=22.16.0 (no npm install). Run: node run.mjs. Local URL: http://127.0.0.1:4180\n\nThis archive contains NO production customer data, passwords or sessions. Payments are a MANUAL LEDGER, not acquiring.\n\nOperations (stop the CRM server first):\n- node ops.mjs backup\n- node ops.mjs verify <backup-directory-name>\n- node ops.mjs plan <next-version.zip>\n- node ops.mjs update <next-version.zip> --confirm\n- node ops.mjs restore <backup-directory-name> --confirm\n\nA backup includes personal customer data. Keep it secure and separately stored; make off-site copies.\n\nOnly install ZIPs obtained from a trusted factory. SHA-256 proves internal consistency, NOT origin authenticity.\nUpdates support additive schema changes, not destructive migrations. Never modify generator-managed files in place.\nThe CRM update engine maintains manifest contract 0.4.0 for R0.4-compatible additive updates; R1.3 is the product version. Workflow presets are seeded only into entirely new CRM databases, never silently overwritten in existing installations. Tested update compatibility must be verified before deploying to customer data.
There is no live update while CRM is running, and no remote update service.\n`});
  const manifest={format:'osmanx-standalone-release',manifestVersion:1,projectId:project.id,
    release:{id:release?.id??null,sequence:release?.sequence??0,notes:release?.notes??'',createdAt:release?.createdAt??null},
    snapshotSha256:release?.snapshotSha256??sha(JSON.stringify(project)),
    applicationVersion:'0.4.0',files:Object.fromEntries(files.map(x=>[x.name,sha(x.data)]))};
  files.push({name:'manifest.json',data:JSON.stringify(manifest,null,2)+'\n'});
  return createZip(files);
}

// Independent website export: pages, administrative CMS and leads. No CRM data or runtime.
// Unlike CRM R0.4, safe in-place upgrade support has NOT been implemented for websites.
async function exportSite(project,projectRoot,release){
  const files=[];
  await walk(projectRoot,join(projectRoot,'src/common'),files);
  await walk(projectRoot,join(projectRoot,'src/site'),files);
  await walk(projectRoot,join(projectRoot,'public/site'),files);
  files.push({name:'run.mjs',data:await readFile(join(projectRoot,'templates/standalone/site-run.mjs'))});
  files.push({name:'ops.mjs',data:await readFile(join(projectRoot,'templates/standalone/site-ops.mjs'))});
  files.push({name:'config/project.json',data:JSON.stringify(project,null,2)+'\n'});
  files.push({name:'package.json',data:JSON.stringify({name:'osmanx-'+project.id.slice(0,8)+'-site',version:'1.3.0',private:true,type:'module',engines:{node:'>=22.16.0'},scripts:{start:'node run.mjs',backup:'node ops.mjs backup'}},null,2)+'\n'});
  files.push({name:'.env.example',data:'PORT=4181\nHOST=127.0.0.1\nCOOKIE_SECURE=0\n# PUBLIC_SITE_URL=https://example.com\n# SETUP_TOKEN=long-secret-for-first-admin\n'});
  files.push({name:'.gitignore',data:'data/\n.env\nbackups/\n.osmanx-upgrades/\n.osmanx-volume-migration/\n.osmanx-rollout/\n.osmanx-acceptance/\n.osmanx-fleet/\n.osmanx-trust/\nrelease-keys/\n*.pem\n*.key\nartifacts/\n*.log\n'});
  files.push({name:'README.md',data:`# ${project.name}\n\nАвтономный корпоративный сайт от OSMANX R1.3. Node.js >=22.16.0, npm install не нужен.\n\n1. node run.mjs\n2. http://127.0.0.1:4181/ — публичный сайт, http://127.0.0.1:4181/admin — закрытая CMS.\n3. Для публикации на публичном сервере задайте SETUP_TOKEN до создания администратора, включите HTTPS и COOKIE_SECURE=1.\n4. PUBLIC_SITE_URL=https://example.com включает sitemap.xml и robots.txt. Без него поисковая индексация намеренно отключена.\n\nИз архива исключены реальные заявки, пароли и сессии; при первом запуске создаётся пустая SQLite база.\nОбслуживание офлайн: остановите сайт, затем node ops.mjs backup; node ops.mjs verify BACKUP_ID; node ops.mjs restore BACKUP_ID --confirm. Копии хранят личные данные, защищайте их и храните вне сервера.\nНе подключены: загрузка медиа, домены, платёжные шлюзы, email-рассылки, облачный деплой, обновление сайта через ops.mjs.\nСайт сохраняет личные данные обращений; внедрите HTTPS, политику приватности, лимиты хранения, бэкапы и контроль доступа до публичного использования.\n`});
  const manifest={format:'osmanx-standalone-site',manifestVersion:1,projectId:project.id,
    release:{id:release?.id??null,sequence:release?.sequence??0,notes:release?.notes??'',createdAt:release?.createdAt??null},
    snapshotSha256:release?.snapshotSha256??sha(JSON.stringify(project)),applicationVersion:'1.3.0',
    files:Object.fromEntries(files.map(x=>[x.name,sha(x.data)]))};
  files.push({name:'manifest.json',data:JSON.stringify(manifest,null,2)+'\n'});
  return createZip(files);
}
