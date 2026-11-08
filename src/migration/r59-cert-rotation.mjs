// R5.9 Ed25519-signed, tenant-pinned dual-certificate rotation.
// Offline signer private key NEVER belongs on the mTLS gateway. Callers
// verify using a pinned public key and PG-backed monotonic generation.
import {sign,verify,createHash} from 'node:crypto';
const HEX=/^[a-f0-9]{64}$/,TENANT=/^[a-f0-9]{24}$/,
  FORMAT='osmanx-r59-rotation-v1';
function deny(ok,msg){if(!ok)throw Error('R5.9 certificate rotation refused: '+msg);}
function exact(obj,keys){
  return obj&&typeof obj==='object'&&!Array.isArray(obj)&&
    Object.keys(obj).length===keys.length&&
    keys.every(k=>Object.hasOwn(obj,k));
}
function pin(p){
  deny(exact(p,['sha256','notBefore','notAfter'])&&
    HEX.test(p.sha256)&&Number.isSafeInteger(p.notBefore)&&
    Number.isSafeInteger(p.notAfter)&&p.notAfter>p.notBefore&&
    p.notAfter-p.notBefore<=90*24*3600*1000,
    'invalid certificate pin window');
  return {sha256:p.sha256,notBefore:p.notBefore,notAfter:p.notAfter};
}
function pinGroup(items){
  deny(Array.isArray(items)&&items.length>=1&&items.length<=2,
    'one or two exact certificate fingerprints required');
  const fields=items.map(pin);
  deny(new Set(fields.map(x=>x.sha256)).size===fields.length,
    'duplicate certificate fingerprint');
  return fields;
}
function fields(v){
  deny(v&&typeof v==='object'&&TENANT.test(v.tenantId||'')&&
    Number.isSafeInteger(v.generation)&&v.generation>=1&&v.generation<=1000000&&
    Number.isSafeInteger(v.issuedAt)&&Number.isSafeInteger(v.expiresAt)&&
    v.expiresAt>v.issuedAt&&v.expiresAt-v.issuedAt<=90*24*3600*1000,
    'invalid manifest tenant, generation or validity');
  const clients=pinGroup(v.clients),servers=pinGroup(v.servers);
  return {format:FORMAT,tenantId:v.tenantId,generation:v.generation,
    issuedAt:v.issuedAt,expiresAt:v.expiresAt,clients,servers};
}
export function signR59PinManifest({payload,privateKey}={}){
  deny(privateKey,'offline Ed25519 private key required');
  const body=fields(payload);
  return {...body,signature:sign(null,Buffer.from(JSON.stringify(body)),privateKey)
    .toString('base64')};
}
export function verifyR59PinManifest({
  manifest,publicKey,tenantId,minGeneration=1,now=()=>Date.now()
}={}){
  deny(exact(manifest,[
    'format','tenantId','generation','issuedAt','expiresAt',
    'clients','servers','signature'
  ])&&manifest.format===FORMAT&&manifest.tenantId===tenantId&&
    Number.isSafeInteger(minGeneration)&&minGeneration>=1,
    'wrong manifest format, tenant or schema');
  const body=fields(manifest);
  const signature=manifest.signature;
  deny(typeof signature==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(signature)&&
    Buffer.from(signature,'base64').toString('base64')===signature&&
    Buffer.from(signature,'base64').length===64,
    'noncanonical Ed25519 signature');
  let valid=false;
  try{
    valid=verify(null,Buffer.from(JSON.stringify(body)),publicKey,
      Buffer.from(signature,'base64'));
  }catch{valid=false;}
  deny(valid,'invalid offline signature');
  const timestamp=now();
  deny(Number.isSafeInteger(timestamp)&&timestamp>=body.issuedAt&&
    timestamp<body.expiresAt&&body.generation>=minGeneration,
    'expired, future or rolled back signed manifest');
  return body;
}
export function createR59TrustWindow({
  manifest,publicKey,tenantId,minGeneration=1,now=()=>Date.now()
}={}){
  const original=verifyR59PinManifest({
    manifest,publicKey,tenantId,minGeneration,now
  });
  function allowed(kind,at=now()){
    const current=verifyR59PinManifest({
      manifest,publicKey,tenantId,minGeneration,now:()=>at
    });
    const active=current[kind].filter(p=>p.notBefore<=at&&at<p.notAfter);
    deny(active.length>0,'no currently trusted '+kind+' certificate');
    return active.map(p=>p.sha256);
  }
  return Object.freeze({
    generation:original.generation,tenantId,syntheticOnly:true,
    trustedClientPins:at=>allowed('clients',at),
    trustedServerPins:at=>allowed('servers',at),
    manifestDigest:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
  });
}
export async function activateR59PgTrustGeneration({
  pool,tenantId,trustWindow
}={}){
  deny(pool?.connect&&TENANT.test(tenantId||'')&&
    trustWindow?.tenantId===tenantId&&
    HEX.test(trustWindow.manifestDigest||'')&&
    Number.isSafeInteger(trustWindow.generation),
    'invalid PG trust activation');
  const client=await pool.connect();
  let begun=false;
  try{
    await client.query('BEGIN');begun=true;
    await client.query(
      'INSERT INTO ox_r59_cert_generation(tenant,generation,manifest_sha) VALUES($1,0,$2) ON CONFLICT DO NOTHING',
      [tenantId,'0'.repeat(64)]);
    const locked=await client.query(
      'SELECT generation,manifest_sha FROM ox_r59_cert_generation WHERE tenant=$1 FOR UPDATE',
      [tenantId]);
    const prior=locked.rows[0];
    deny(prior&&Number(prior.generation)<=trustWindow.generation,
      'signed rotation generation rollback');
    if(Number(prior.generation)===trustWindow.generation){
      deny(prior.manifest_sha===trustWindow.manifestDigest,
        'same generation cannot authorize different certificate pins');
    }else{
      await client.query(
        'UPDATE ox_r59_cert_generation SET generation=$2,manifest_sha=$3,modified_at=clock_timestamp() WHERE tenant=$1',
        [tenantId,trustWindow.generation,trustWindow.manifestDigest]);
    }
    await client.query('COMMIT');begun=false;
    return {generation:trustWindow.generation,activated:true,
      productionCutoverAllowed:false};
  }catch(e){
    if(begun)await client.query('ROLLBACK').catch(()=>{});
    throw e;
  }finally{client.release();}
}
