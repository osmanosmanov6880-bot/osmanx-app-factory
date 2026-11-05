import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {normalizePage,makeStarterPage,PAGE_SCHEMA_VERSION} from '../src/common/pages.mjs';

const modules=['auth','clients','analytics','tasks','payments'];
const block=(type,extra)=>({id:randomUUID(),type,...extra});
const page=(blocks)=>({title:'Контроль ресторана',slug:'service-desk',description:'Настраиваемый экран',published:true,blocks});
const check400=fn=>assert.throws(fn,e=>e.status===400);

test('Page schema: starter projects work with modules and only accepted block types',()=>{
 const first=makeStarterPage(modules);
 assert.equal(first.schemaVersion,PAGE_SCHEMA_VERSION);
 assert.equal(first.slug,'service');
 assert.ok(first.blocks.some(b=>b.type==='metric'));
 const tiny=makeStarterPage(['auth','tasks']);
 assert.ok(!tiny.blocks.some(b=>b.type==='table'&&b.entity==='clients'));
 assert.ok(tiny.blocks.every(b=>b.type!=='metric'||b.metric!=='clients_total'));
});

test('Page schema: text is data, executable actions and paths are not allowed',()=>{
 const text=block('text',{title:'Слова',body:'<img src=x onerror=alert(1)>'});
 const r=normalizePage(page([text]),modules);
 assert.equal(r.blocks[0].body,'<img src=x onerror=alert(1)>');
 assert.equal(r.blocks[0].id,text.id);
 check400(()=>normalizePage(page([block('script',{code:'alert(1)'})]),modules));
 check400(()=>normalizePage(page([block('button',{label:'Do',action:'fetch:https://evil.invalid',style:'primary'})]),modules));
 check400(()=>normalizePage(page([block('button',{label:'Оплаты',action:'create:payments',style:'primary'})]),['auth','clients']));
 check400(()=>normalizePage({...page([]),slug:'../admin'},modules));
 check400(()=>normalizePage({...page([]),slug:'analytics'},modules));
 check400(()=>normalizePage({...page([]),blocks:Array.from({length:31},()=>block('divider'))},modules));
 check400(()=>normalizePage(page([text,text]),modules));
});

test('Page schema: form fields and data sources are explicitly limited',()=>{
 const good=normalizePage(page([block('form',{title:'Гость',entity:'clients',fields:['full_name','phone'],submitLabel:'Создать'})]),modules);
 assert.deepEqual(good.blocks[0].fields,['full_name','phone']);
 check400(()=>normalizePage(page([block('form',{title:'Гость',entity:'clients',fields:['phone'],submitLabel:'Создать'})]),modules));
 check400(()=>normalizePage(page([block('table',{title:'SQL',entity:'clients',columns:['full_name','password_hash']})]),modules));
 check400(()=>normalizePage(page([block('form',{title:'Гость',entity:'clients',fields:['full_name'],submitLabel:'Создать'})]),['auth','tasks']));
});
