// R5.6: synthetic-only single-owner checkpoint coordinator.
// The coordinator owns both the lease decision and the only mutable-pointer
// S3 capability. Clients never receive a pointer PUT capability.
import {createHash,randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,rename,unlink,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';

const TENANT=/^[a-f0-9]{24}$/,HOLDER=/^[a-f0-9]{24}$/,LEASE=/^[a-f0-9]{32}$/;
const DIGEST=/^[a-f0-9]{64}$/,ETAG=/^"[a-fA-F0-9-]{1,128}"$/;
const HEAD='r53/head.json';
function deny(ok,reason){if(!ok)throw Error('R5.6 checkpoint coordinator refused: '+reason);}
function digest(bytes){return createHash('sha256').update(bytes).digest('hex');}
function stateFile(root,tenant){return join(root,tenant+'.json');}
function validState(s,tenant){
  return s&&s.format==='ox-r56-coordinator-v1'&&s.tenant===tenant&&
    Number.isSafeInteger(s.epoch)&&s.epoch>=0&&s.epoch<=1000000&&
    (!s.pending||(s.pending&&LEASE.test(s.pending.operation)&&DIGEST.test(s.pending.sha256)&&
      Number.isSafeInteger(s.pending.epoch)&&s.pending.epoch>=1&&
      (!s.pending.expectedEtag||ETAG.test(s.pending.expectedEtag))&&
      typeof s.pending.create==='boolean'));
}
export function createR56PointerCoordinator({root,remote,now=()=>Date.now(),fault=()=>{}}={}){
  deny(typeof root==='string'&&root.length>0&&remote?.put&&remote?.getWithMetadata&&
    remote?.inspectR49Worm&&remote?.assertBucketControls&&typeof now==='function'&&
    typeof fault==='function','private state and real remote interface required');
  const base=resolve(root);
  const serial=new Map();
  async function exclusive(tenant,callback){
    deny(TENANT.test(tenant),'opaque tenant ID required');
    const previous=serial.get(tenant)||Promise.resolve();
    let done;const next=new Promise(resolve=>{done=resolve;});
    serial.set(tenant,next);
    await previous;
    try{return await callback();}
    finally{if(serial.get(tenant)===next)serial.delete(tenant);done();}
  }
  async function ensure(){
    await mkdir(base,{recursive:true,mode:0o700});
    const st=await lstat(base);
    deny(st.isDirectory()&&!st.isSymbolicLink()&&
      (process.platform==='win32'||(st.mode&0o077)===0),'state dir permissions');
  }
  async function load(tenant){
    await ensure();
    let file;try{file=await open(stateFile(base,tenant),constants.O_RDONLY|constants.O_NOFOLLOW);}
    catch(e){if(e.code==='ENOENT')return {format:'ox-r56-coordinator-v1',tenant,epoch:0,
      active:null,pending:null,committed:null};throw e;}
    try{
      const st=await file.stat();
      deny(st.isFile()&&st.nlink===1&&st.size<8192&&
        (process.platform==='win32'||(st.mode&0o077)===0),'unsafe state file');
      const s=JSON.parse(await file.readFile('utf8'));
      deny(validState(s,tenant),'corrupt state');
      return s;
    }finally{await file.close();}
  }
  async function save(tenant,s){
    deny(validState(s,tenant),'invalid state transition');
    const path=join(base,tenant+'.'+randomBytes(8).toString('hex')+'.tmp');
    let fd;
    try{
      fd=await open(path,constants.O_WRONLY|constants.O_EXCL|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
      await fd.writeFile(JSON.stringify(s)+'\n');await fd.sync();await fd.close();fd=null;
      await rename(path,stateFile(base,tenant));
      const dir=await open(base,constants.O_RDONLY);
      try{await dir.sync();}finally{await dir.close();}
    }finally{await fd?.close();await unlink(path).catch(()=>{});}
  }
  function validLease(s,lease){
    deny(lease&&HOLDER.test(lease.holder)&&LEASE.test(lease.leaseId)&&
      Number.isSafeInteger(lease.epoch)&&s.active&&s.epoch===lease.epoch&&
      s.active.holder===lease.holder&&s.active.leaseId===lease.leaseId&&
      now()<s.active.expiresAt,'stale, expired or superseded publisher');
  }
  async function inspectRemote(){
    try{return await remote.getWithMetadata(HEAD);}
    catch(e){if(String(e.message)==='R4.8 S3 denied: GET status 404')return null;throw e;}
  }
  async function reconcilePending(tenant,s){
    if(!s.pending)return s;
    const p=s.pending;
    const live=await inspectRemote();
    if(live&&digest(live.body)===p.sha256){
      const lock=await remote.inspectR49Worm(HEAD);
      deny(lock.objectLockVerified&&lock.retentionMode==='COMPLIANCE'&&lock.versionId,
        'pending object lacks COMPLIANCE retention');
      s.committed={operation:p.operation,sha256:p.sha256,versionId:lock.versionId,
        epoch:p.epoch};
      s.pending=null;
      await save(tenant,s);
      return s;
    }
    // A failed/unknown write cannot be safely discarded merely because the
    // current HEAD differs: the earlier version may exist in version history.
    deny(false,'ambiguous checkpoint: manual version-history investigation required');
  }
  async function acquire({tenant,holder,ttlMs=10000}){
    return exclusive(tenant,async()=>{
      deny(HOLDER.test(holder)&&Number.isSafeInteger(ttlMs)&&ttlMs>=1000&&ttlMs<=30000,
        'invalid lease request');
      let s=await load(tenant);s=await reconcilePending(tenant,s);
      deny(!s.active||now()>=s.active.expiresAt,'active lease exists');
      deny(s.epoch<1000000,'epoch exhausted');
      s.epoch+=1;
      s.active={holder,leaseId:randomBytes(16).toString('hex'),expiresAt:now()+ttlMs};
      await save(tenant,s);
      return Object.freeze({tenant,holder,epoch:s.epoch,leaseId:s.active.leaseId,
        expiresAt:s.active.expiresAt,syntheticOnly:true});
    });
  }
  async function renew(lease,ttlMs=10000){
    return exclusive(lease.tenant,async()=>{
      deny(Number.isSafeInteger(ttlMs)&&ttlMs>=1000&&ttlMs<=30000,'invalid TTL');
      const s=await load(lease.tenant);validLease(s,lease);
      s.active.expiresAt=now()+ttlMs;await save(lease.tenant,s);
      return {...lease,expiresAt:s.active.expiresAt};
    });
  }
  async function assertCurrent(lease){
    return exclusive(lease.tenant,async()=>{
      const s=await load(lease.tenant);validLease(s,lease);
      deny(!s.pending,'unresolved prior write');
      return {remoteFencingVerified:true,epoch:s.epoch,productionCutoverAllowed:false};
    });
  }
  async function release(lease){
    return exclusive(lease.tenant,async()=>{
      const s=await load(lease.tenant);validLease(s,lease);
      s.active=null;await save(lease.tenant,s);
      return {released:true,epoch:s.epoch};
    });
  }
  async function publish({lease,body,ifMatch=null,ifNoneMatch=false,operation=randomBytes(16).toString('hex')}){
    return exclusive(lease.tenant,async()=>{
      deny(Buffer.isBuffer(body)&&body.length>0&&body.length<=4096&&
        LEASE.test(operation)&&((ETAG.test(ifMatch||'')&&!ifNoneMatch)||
        (ifNoneMatch===true&&!ifMatch)),'strict conditional checkpoint write required');
      let s=await load(lease.tenant);validLease(s,lease);
      deny(!s.pending,'unresolved prior checkpoint');
      const controls=await remote.assertBucketControls();
      deny(controls.objectLockEnabled&&controls.versioningEnabled,'bucket controls absent');
      const hash=digest(body);
      if(s.committed?.operation===operation){
        deny(s.committed.sha256===hash,'operation reused with altered payload');
        return {confirmed:true,replayed:true,...s.committed,syntheticOnly:true};
      }
      s.pending={operation,sha256:hash,epoch:lease.epoch,
        expectedEtag:ifMatch,create:ifNoneMatch};
      await save(lease.tenant,s);fault('after-intent');
      // No lease can be granted while this operation is in flight: same lock.
      // The service itself sends S3 PUT, not the externally leased worker.
      await remote.put(HEAD,body,ifMatch?{ifMatch}:{ifNoneMatch:true});
      fault('after-put');
      const live=await inspectRemote();
      deny(live&&digest(live.body)===hash,'readback mismatch');
      const locked=await remote.inspectR49Worm(HEAD);
      deny(locked.objectLockVerified&&locked.retentionMode==='COMPLIANCE'&&locked.versionId,
        'new pointer lacks retained S3 version');
      s.committed={operation,sha256:hash,versionId:locked.versionId,epoch:lease.epoch};
      s.pending=null;await save(lease.tenant,s);
      fault('after-confirmation');
      return {confirmed:true,replayed:false,...s.committed,syntheticOnly:true};
    });
  }
  async function recover(tenant){
    return exclusive(tenant,async()=>{
      let s=await load(tenant);s=await reconcilePending(tenant,s);
      return {ambiguous:!!s.pending,committed:s.committed,epoch:s.epoch,
        syntheticOnly:true,productionCutoverAllowed:false};
    });
  }
  return Object.freeze({acquire,renew,assertCurrent,release,publish,recover,
    syntheticOnly:true,productionCutoverAllowed:false});
}
