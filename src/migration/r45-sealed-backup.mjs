// R4.5 encrypted backup envelope for synthetic-only, disposable SQLite restore drills.
// The source is not changed; the encrypted archive is never a production backup service.
import {createCipheriv,createDecipheriv,createHash,hkdfSync,randomBytes} from 'node:crypto';
const MAGIC=Buffer.from('OXB45V1\0','ascii');
const SALT_LEN=16,NONCE_LEN=12,TAG_LEN=16,HEADER_LEN=MAGIC.length+SALT_LEN+NONCE_LEN+TAG_LEN;
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
const DOMAIN=Buffer.from('OSMANX-R45-BACKUP-ENVELOPE-v1\0');
const MAX=128*1024*1024;
function guard(ok,reason){if(!ok)throw Error('R4.5 sealed backup refused: '+reason);}
function params({secret,projectId,manifestSha256}={}){
  guard(Buffer.isBuffer(secret)&&secret.length===32,'32-byte external encryption key required');
  guard(typeof projectId==='string'&&ID.test(projectId),'signed project UUID required');
  guard(typeof manifestSha256==='string'&&HASH.test(manifestSha256),'trusted manifest hash required');
  return {secret,projectId,manifestSha256};
}
function aad(info){return Buffer.from(DOMAIN.toString('utf8')+info.projectId+'\0'+info.manifestSha256);}
function derive(secret,salt){return Buffer.from(hkdfSync('sha256',secret,salt,DOMAIN,32));}
export function sealR45Snapshot(plaintext,input){
  const info=params(input);
  guard(Buffer.isBuffer(plaintext)&&plaintext.length>=16&&plaintext.length<=MAX,'invalid bounded snapshot');
  const salt=randomBytes(SALT_LEN),nonce=randomBytes(NONCE_LEN),key=derive(info.secret,salt);
  try{
    const cipher=createCipheriv('aes-256-gcm',key,nonce,{authTagLength:TAG_LEN});
    cipher.setAAD(aad(info),{plaintextLength:plaintext.length});
    const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);
    const envelope=Buffer.concat([MAGIC,salt,nonce,cipher.getAuthTag(),encrypted]);
    return {envelope,envelopeSha256:createHash('sha256').update(envelope).digest('hex')};
  }finally{key.fill(0);}
}
export function openR45Snapshot(envelope,input){
  const info=params(input);
  guard(Buffer.isBuffer(envelope)&&envelope.length>=HEADER_LEN+16&&envelope.length<=HEADER_LEN+MAX,
    'invalid encrypted archive bounds');
  guard(envelope.subarray(0,MAGIC.length).equals(MAGIC),'unsupported archive format');
  let cursor=MAGIC.length;
  const salt=envelope.subarray(cursor,cursor+=SALT_LEN);
  const nonce=envelope.subarray(cursor,cursor+=NONCE_LEN);
  const tag=envelope.subarray(cursor,cursor+=TAG_LEN);
  const encrypted=envelope.subarray(cursor);
  const key=derive(info.secret,salt);
  try{
    const decipher=createDecipheriv('aes-256-gcm',key,nonce,{authTagLength:TAG_LEN});
    decipher.setAAD(aad(info),{plaintextLength:encrypted.length});
    decipher.setAuthTag(tag);
    try{return Buffer.concat([decipher.update(encrypted),decipher.final()]);}
    catch{throw Error('R4.5 sealed backup refused: archive authentication failed');}
  }finally{key.fill(0);}
}
export const R45_ARCHIVE_FORMAT='osmanx-r45-aes256gcm-v1';
