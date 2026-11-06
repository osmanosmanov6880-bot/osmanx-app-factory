// Standalone witness receiver for a physically independent host.
// TLS is terminated by Caddy. Secrets are Docker files, not CLI flags.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createR48WitnessReceiver} from '../../src/migration/r48-witness.mjs';
function must(name){const p=process.env[name];if(!p||!p.startsWith('/'))throw Error(name+' requires a private absolute file path');return readFileSync(p,'utf8').trim();}
const token=must('OX_R49_WITNESS_TOKEN_FILE');
const hex=must('OX_R49_WITNESS_HMAC_KEY_FILE');
if(!/^[a-f0-9]{64}$/.test(hex)||!/^[A-Za-z0-9._~-]{32,256}$/.test(token))throw Error('invalid external witness credential format');
const secret=Buffer.from(hex,'hex');
const root=process.env.OX_R49_WITNESS_STATE_DIR||'/state';
const receiver=createR48WitnessReceiver({root,token,secret});
const app=createServer((req,res)=>{
  if(req.url==='/healthz'&&req.method==='GET'){
    res.writeHead(200,{'content-type':'text/plain','cache-control':'no-store'});res.end('ok');return;
  }
  void receiver(req,res);
});
app.requestTimeout=15000;app.headersTimeout=10000;app.keepAliveTimeout=5000;
const port=Number(process.env.OX_R49_WITNESS_PORT||9080);
if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('invalid witness port');
app.listen(port,'0.0.0.0',()=>console.log('R4.9 independent witness listening behind TLS proxy'));
function close(){app.close(()=>{secret.fill(0);process.exit(0)});}
process.on('SIGTERM',close);process.on('SIGINT',close);
