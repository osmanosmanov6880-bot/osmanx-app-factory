// Dedicated audit-anchor receiver. Deploy on a host independent of S3 and
// of the original backup witness. TLS is terminated by a trusted ingress.
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {createR48WitnessReceiver} from '../../src/migration/r48-witness.mjs';
const required=name=>{
  const path=process.env[name];
  if(!path?.startsWith('/'))throw Error(name+' absolute secret-file path required');
  return readFileSync(path,'utf8').trim();
};
const token=required('OX_R51_ANCHOR_TOKEN_FILE');
const hex=required('OX_R51_ANCHOR_HMAC_FILE');
if(!/^[a-f0-9]{64}$/.test(hex)||!/^[A-Za-z0-9._~-]{32,256}$/.test(token))
  throw Error('Invalid independent anchor credential format');
const secret=Buffer.from(hex,'hex');
const receiver=createR48WitnessReceiver({root:process.env.OX_R51_ANCHOR_ROOT||'/state',
  token,secret});
const server=createServer((req,res)=>{
  if(req.method==='GET'&&req.url==='/healthz'){
    res.writeHead(200,{'cache-control':'no-store','content-type':'text/plain'});
    res.end('ok');return;
  }
  void receiver(req,res).catch(()=>{res.writeHead(503);res.end();});
});
server.requestTimeout=15000;
server.headersTimeout=10000;
const port=Number(process.env.OX_R51_ANCHOR_PORT||9081);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('invalid port');
server.listen(port,'0.0.0.0',()=>console.log('R5.1 independent audit anchor ready behind TLS'));
function stop(){server.close(()=>{secret.fill(0);process.exit(0)});}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
