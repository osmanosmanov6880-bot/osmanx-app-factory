import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bad, bodyJson, json, ok, routePath, staticFile, protectOrigin } from '../common/http.mjs';
import { id, now, shortText, hashPassword, verifyPassword, issueSession, revokeSession, requireUser, sessionFromRequest, checkLoginThrottle, cookie, validateEmail, checkId, requireSetupToken } from '../common/security.mjs';
import { withTransaction } from '../common/db.mjs';
import { normalizeSitePage, renderWebsite, siteSettings } from './model.mjs';
import { sitePages, siteConfig, sitePageFromRow, syncSite } from './db.mjs';

const limiter=new Map();
function limitLead(req){
 const ip=req.socket.remoteAddress||'unknown',time=Date.now();
 const record=limiter.get(ip)||{start:time,count:0};
 if(time-record.start>60000){record.start=time;record.count=0;}
 record.count++;limiter.set(ip,record);
 if(limiter.size>2500)limiter.clear();
 if(record.count>8)bad(429,'Слишком много обращений. Попробуйте позже.');
}
const pagePayload=p=>({title:p.title,slug:p.slug,description:p.description,published:p.published,blocks:p.blocks});
const pageExists=(db,slug,except=null)=>db.prepare('SELECT id FROM pages WHERE slug=? AND id IS NOT ?').get(slug,except);
function siteXmlPages(pages,siteUrl){
 return '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+
 pages.filter(p=>p.published).map(p=>`<url><loc>${siteUrl}${p.slug==='home'?'/':'/'+p.slug}</loc></url>`).join('')+'</urlset>';
}
export async function handleSiteRequest(req,res,{db,config,base='',staticRoot,cookieName='ox_site',deploymentIdentity=null}){
 const {path,query}=routePath(req,base);
 if(!['GET','HEAD'].includes(req.method))protectOrigin(req);
 if(path==='/api/health'&&req.method==='GET')return ok(res,{service:'osmanx-website',version:'1.3.0',...(deploymentIdentity?{deployment:deploymentIdentity}:{})});
 if(path==='/assets/site.css')return staticFile(res,resolve(staticRoot,'site.css'),'.css');
 if(path==='/assets/site.js')return staticFile(res,resolve(staticRoot,'site.js'),'.js');
 if(path==='/assets/admin.css')return staticFile(res,resolve(staticRoot,'admin.css'),'.css');
 if(path==='/assets/admin.js')return staticFile(res,resolve(staticRoot,'admin.js'),'.js');
 if(path==='/assets/theme.css'){
   const accent=siteConfig(db,config).settings.accent;
   res.writeHead(200,{'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-store'});
   return res.end(`:root{--brand-accent:${/^#[a-fA-F0-9]{6}$/.test(accent)?accent:'#d0a976'};}`);
 }
 if(path==='/admin'&&req.method==='GET')return staticFile(res,resolve(staticRoot,'admin.html'),'.html');
 if(path==='/api/site/session'&&req.method==='GET'){
   const user=sessionFromRequest(req,db,cookieName);
   return ok(res,{initialized:!!db.prepare('SELECT id FROM users LIMIT 1').get(),authenticated:!!user,
     user:user&&{id:user.id,email:user.email,name:user.name},csrf:user?.csrf||null,requiresSetupToken:!!process.env.SETUP_TOKEN});
 }
 if(path==='/api/site/setup'&&req.method==='POST'){
   const payload=await bodyJson(req);
   if(db.prepare('SELECT id FROM users LIMIT 1').get())bad(409,'Администратор уже создан');
   requireSetupToken(payload.setup_token);
   const name=shortText(payload.name,'Имя',80),email=validateEmail(payload.email),hashed=hashPassword(payload.password),uid=id();
   db.prepare('INSERT INTO users(id,email,name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,1,?)').run(uid,email,name,hashed,'admin',now());
   const session=issueSession(db,uid);
   return json(res,{ok:true,user:{id:uid,name,email},csrf:session.csrf},201,{'Set-Cookie':cookie(session.token,cookieName,base||'/')});
 }
 if(path==='/api/site/login'&&req.method==='POST'){
   checkLoginThrottle(req,'site');
   const payload=await bodyJson(req),email=validateEmail(payload.email);
   const row=db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email);
   if(!row||!verifyPassword(String(payload.password||''),row.password_hash))bad(401,'Неверная почта или пароль');
   const session=issueSession(db,row.id);
   return json(res,{ok:true,user:{id:row.id,email:row.email,name:row.name},csrf:session.csrf},200,{'Set-Cookie':cookie(session.token,cookieName,base||'/')});
 }
 if(path==='/api/site/leads'&&req.method==='POST'){
   if(!config.modules.includes('leads'))bad(404,'Приём заявок отключён');
   limitLead(req);
   const data=await bodyJson(req);
   if(data.website) return json(res,{ok:true,message:'Обращение принято'},202);
   const page=String(data.page||'');
   const match=db.prepare('SELECT * FROM pages WHERE slug=? AND published=1').get(page);
   if(!match||!JSON.parse(match.blocks_json).some(b=>b.type==='form'))bad(404,'Форма недоступна');
   const name=shortText(data.name,'Имя',120),phone=shortText(data.phone??'','Телефон',40,false),email=shortText(data.email??'','Email',254,false),message=shortText(data.message??'','Сообщение',1500,false);
   if(!phone&&!email)bad(400,'Укажите телефон или email');
   if(email)validateEmail(email);
   if(phone&&!/^[+0-9()\s.\-]{6,40}$/.test(phone))bad(400,'Некорректный телефон');
   const leadId=id(),stamp=now();
   db.prepare('INSERT INTO leads(id,page_slug,name,phone,email,message,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
     .run(leadId,page,name,phone,email,message,'new',stamp,stamp);
   return json(res,{ok:true,message:'Обращение принято',id:leadId},201);
 }
 if(path==='/api/site/logout'&&req.method==='POST'){
   const user=requireUser(req,db,cookieName);
   revokeSession(db,user);
   return json(res,{ok:true},200,{'Set-Cookie':cookie('',cookieName,base||'/',0)});
 }
 if(path.startsWith('/api/site/')){
   requireUser(req,db,cookieName,['admin']);
   if(path==='/api/site/overview'&&req.method==='GET'){
     const total=db.prepare('SELECT COUNT(*) n FROM leads').get().n;
     const unread=db.prepare("SELECT COUNT(*) n FROM leads WHERE status='new'").get().n;
     const live=db.prepare('SELECT COUNT(*) n FROM pages WHERE published=1').get().n;
     return ok(res,{overview:{leads:total,newLeads:unread,publishedPages:live}});
   }
   if(path==='/api/site/leads'&&req.method==='GET'){
     const limit=Math.max(1,Math.min(100,Number(query.get('limit')||30)||30)),offset=Math.max(0,Math.min(100000,Number(query.get('offset')||0)||0));
     return ok(res,{leads:db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT ? OFFSET ?').all(limit,offset),total:db.prepare('SELECT COUNT(*) n FROM leads').get().n});
   }
   const leadMatch=path.match(/^\/api\/site\/leads\/([0-9a-f-]{36})$/);
   if(leadMatch&&req.method==='PATCH'){
     const input=await bodyJson(req);checkId(leadMatch[1]);
     if(!['new','in_progress','closed'].includes(input.status))bad(400,'Недопустимый статус');
     const result=db.prepare('UPDATE leads SET status=?,updated_at=? WHERE id=?').run(input.status,now(),leadMatch[1]);
     if(!result.changes)bad(404,'Обращение не найдено');
     return ok(res,{updated:leadMatch[1]});
   }
   if(path==='/api/site/pages'&&req.method==='GET')return ok(res,{pages:sitePages(db)});
   if(path==='/api/site/pages'&&req.method==='POST'){
     const all=sitePages(db);if(all.length>=30)bad(409,'Максимум 30 страниц');
     const page=normalizeSitePage(await bodyJson(req),config.modules);
     if(pageExists(db,page.slug))bad(409,'Такой URL уже занят');
     const pid=id();
     db.prepare('INSERT INTO pages(id,source_id,source_revision,slug,title,description,published,blocks_json,local_revision,locally_edited,position,updated_at) VALUES(?,NULL,0,?,?,?,?,?,1,1,?,?)')
       .run(pid,page.slug,page.title,page.description,Number(page.published),JSON.stringify(page.blocks),all.length,now());
     return json(res,{ok:true,page:sitePageFromRow(db.prepare('SELECT * FROM pages WHERE id=?').get(pid))},201);
   }
   const pageMatch=path.match(/^\/api\/site\/pages\/([0-9a-f-]{36})$/);
   if(pageMatch){
     checkId(pageMatch[1]);const current=db.prepare('SELECT * FROM pages WHERE id=?').get(pageMatch[1]);
     if(!current)bad(404,'Страница не найдена');
     const input=await bodyJson(req);
     if(input.revision!==current.local_revision)bad(409,'Другая вкладка обновила страницу');
     if(req.method==='PATCH'){
       const page=normalizeSitePage(input,config.modules);
       if(pageExists(db,page.slug,current.id))bad(409,'URL уже занят');
       const update=db.prepare('UPDATE pages SET slug=?,title=?,description=?,published=?,blocks_json=?,local_revision=local_revision+1,locally_edited=1,updated_at=? WHERE id=? AND local_revision=?')
         .run(page.slug,page.title,page.description,Number(page.published),JSON.stringify(page.blocks),now(),current.id,current.local_revision);
       if(update.changes!==1)bad(409,'Страница изменена');
       return ok(res,{page:sitePageFromRow(db.prepare('SELECT * FROM pages WHERE id=?').get(current.id))});
     }
     if(req.method==='DELETE'){
       if(current.slug==='home')bad(400,'Главную страницу удалять нельзя');
       db.prepare('DELETE FROM pages WHERE id=? AND local_revision=?').run(current.id,current.local_revision);
       return ok(res,{deleted:current.id});
     }
   }
   if(path==='/api/site/settings'&&req.method==='GET')return ok(res,{settings:siteConfig(db,config)});
   if(path==='/api/site/settings'&&req.method==='PATCH'){
     const body=await bodyJson(req);
     const updates=siteSettings(body,siteConfig(db,config).settings);
     const brand=shortText(body.brand??siteConfig(db,config).name,'Название компании',80);
     withTransaction(db,()=>{for(const [key,value] of Object.entries({...updates,brand,local_config_edited:'1'}))db.prepare('INSERT INTO site_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);});
     return ok(res,{settings:siteConfig(db,config)});
   }
   bad(404,'Маршрут администратора не найден');
 }
 if(req.method==='GET'&&(path==='/robots.txt'||path==='/sitemap.xml')){
   const origin=process.env.PUBLIC_SITE_URL;
   if(path==='/robots.txt'){
     res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
     return res.end(origin&&/^https:\/\/[a-zA-Z0-9.-]+(?::443)?$/.test(origin)?`User-agent: *\nDisallow: /admin\nDisallow: /api/\nSitemap: ${origin}${base}/sitemap.xml\n`:'User-agent: *\nDisallow: /\n');
   }
   if(!origin||!/^https:\/\/[a-zA-Z0-9.-]+(?::443)?$/.test(origin))bad(404,'Укажите PUBLIC_SITE_URL для sitemap.xml');
   res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'no-store'});
   return res.end(siteXmlPages(sitePages(db),origin+base));
 }
 if(req.method==='GET'&&(path==='/'||/^\/[a-z][a-z0-9-]{1,47}$/.test(path))){
   const slug=path==='/'?'home':path.slice(1);
   const rows=sitePages(db),page=rows.find(p=>p.slug===slug&&p.published);
   if(!page)bad(404,'Страница не опубликована');
   const html=renderWebsite(page,rows,siteConfig(db,config),base);
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
   return res.end(html);
 }
 bad(404,'Страница не найдена');
}
