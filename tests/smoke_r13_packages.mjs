// Runs each generated ZIP with its own fresh data directory and checks real HTTP health.
// Requires unzip installed. It does not need npm packages or public network access.
import {readdir,mkdtemp,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
const root=new URL('../../demo_archives/',import.meta.url).pathname;
async function getPort(){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port;}
for(const file of (await readdir(root)).filter(x=>x.endsWith('.zip')).sort()){
 const dest=await mkdtemp(join(tmpdir(),'osmanx-r13-package-'));
 execFileSync('unzip',['-q',join(root,file),'-d',dest]);
 const port=await getPort();
 const child=spawn(process.execPath,['run.mjs'],{cwd:dest,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATA_DIR:join(dest,'fresh-database'),NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});
 let log='';child.stderr.on('data',d=>log+=d);child.stdout.on('data',d=>log+=d);
 try{
  let health;
  for(let i=0;i<100;i++){
   if(child.exitCode!==null)throw Error('Process exited: '+log);
   try{const r=await fetch(`http://127.0.0.1:${port}/api/health`);if(r.ok){health=await r.json();break;}}catch{}
   await new Promise(r=>setTimeout(r,60));
  }
  assert.equal(health?.ok,true,`No health for ${file}: ${log}`);
  console.log('OK',file,health.service||'',health.version||'');
 }finally{child.kill('SIGTERM');}
}
