// Separate machine acknowledgement test receiver. No real pager/on-call
// integration exists here. Only the signed DR_TEST challenge is accepted.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createR51AlertChallengeReceiver} from '../../src/migration/r51-alert-ack.mjs';
function secretFile(name){
  const p=process.env[name];
  if(!p?.startsWith('/'))throw Error(name+' absolute secret-file path required');
  return readFileSync(p,'utf8').trim();
}
const token=secretFile('OX_R51_ALERT_TOKEN_FILE');
const hex=secretFile('OX_R51_ALERT_HMAC_FILE');
if(!/^[a-f0-9]{64}$/.test(hex)||!/^[A-Za-z0-9._~-]{32,256}$/.test(token))
  throw Error('invalid independent alert credentials');
const key=Buffer.from(hex,'hex');
const handler=createR51AlertChallengeReceiver({token,secret:key});
const server=createServer((req,res)=>{
  if(req.method==='GET'&&req.url==='/healthz'){
    res.writeHead(200,{'cache-control':'no-store','content-type':'text/plain'});
    res.end('ok');return;
  }
  void handler(req,res).catch(()=>{res.writeHead(503);res.end();});
});
server.requestTimeout=15000;server.headersTimeout=10000;
const port=Number(process.env.OX_R51_ALERT_PORT||9082);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('invalid port');
server.listen(port,'0.0.0.0',()=>console.log('R5.1 signed alert receiver ready behind TLS'));
function stop(){server.close(()=>{key.fill(0);process.exit(0)});}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
