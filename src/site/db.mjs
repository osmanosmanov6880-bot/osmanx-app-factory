import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb, withTransaction } from '../common/db.mjs';
import { id, now } from '../common/security.mjs';
import { normalizeSitePage, makeSitePages } from './model.mjs';
const schema=readFileSync(fileURLToPath(new URL('./schema.sql',import.meta.url)),'utf8');
export function siteDb(filename,project){
  const db=openDb(filename);
  db.exec(schema);
  syncSite(db,project);
  return db;
}
export const sitePageFromRow=r=>r&&({id:r.id,sourceId:r.source_id,sourceRevision:r.source_revision,slug:r.slug,title:r.title,description:r.description,published:!!r.published,blocks:JSON.parse(r.blocks_json),revision:r.local_revision,position:r.position,updatedAt:r.updated_at});
export function sitePages(db){return db.prepare('SELECT * FROM pages ORDER BY position ASC, slug ASC').all().map(sitePageFromRow);}
export function syncSite(db,project){
  const pages=Array.isArray(project.pages)&&project.pages.length?project.pages:makeSitePages(project.name,project.modules);
  withTransaction(db,()=>{
    pages.forEach((raw,index)=>{
      const p=normalizeSitePage(raw,project.modules);
      const src=raw.id||`starter-${p.slug}`;
      const old=db.prepare('SELECT * FROM pages WHERE source_id=?').get(src);
      if(!old){
        db.prepare('INSERT OR IGNORE INTO pages(id,source_id,source_revision,slug,title,description,published,blocks_json,local_revision,locally_edited,position,updated_at) VALUES(?,?,?,?,?,?,?,?,1,0,?,?)')
          .run(id(),src,raw.revision||1,p.slug,p.title,p.description,Number(p.published),JSON.stringify(p.blocks),index,now());
      } else if(!old.locally_edited && old.source_revision < (raw.revision||1)){
        db.prepare('UPDATE pages SET slug=?,title=?,description=?,published=?,blocks_json=?,source_revision=?,local_revision=local_revision+1,position=?,updated_at=? WHERE id=?')
          .run(p.slug,p.title,p.description,Number(p.published),JSON.stringify(p.blocks),raw.revision||1,index,now(),old.id);
      }
    });
    if(!db.prepare("SELECT key FROM site_settings WHERE key='brand'").get()){
      for(const [key,value] of Object.entries({brand:project.name,tagline:project.settings?.tagline||'',accent:project.settings?.accent||'#d0a976',contactEmail:project.settings?.contactEmail||''})){
        db.prepare('INSERT INTO site_settings(key,value) VALUES(?,?)').run(key,value);
      }
    }
    if(db.prepare("SELECT value FROM site_settings WHERE key='local_config_edited'").get()?.value!=='1'){
      for(const [key,value] of Object.entries({brand:project.name,tagline:project.settings?.tagline||'',accent:project.settings?.accent||'#d0a976',contactEmail:project.settings?.contactEmail||''})){
        if(db.prepare('SELECT value FROM site_settings WHERE key=?').get(key)?.value!==value)
          db.prepare('INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
      }
    }
  });
}
export function siteConfig(db,project){
 const settings=Object.fromEntries(db.prepare('SELECT key,value FROM site_settings').all().map(x=>[x.key,x.value]));
 return {name:settings.brand||project.name,settings:{accent:settings.accent||'#d0a976',tagline:settings.tagline||'',contactEmail:settings.contactEmail||''}};
}
