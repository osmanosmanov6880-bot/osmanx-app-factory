// R5.4: fail-closed, same-host advisory CDC publisher lease.
// Prevents two jobs on one synthetic host from racing an S3 HEAD update.
// It does not provide a distributed lock across VPS/cloud hosts.
// Stale files require an explicit operator investigation: no lock stealing.
import {constants} from 'node:fs';
import {mkdir,lstat,open,readFile,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes} from 'node:crypto';
const TOKEN=/^[a-f0-9]{24}$/;
function deny(ok,msg){if(!ok)throw Error('R5.4 publisher lease denied: '+msg);}
async function verifyDirectory(directory){
  deny(typeof directory==='string'&&directory.startsWith('/')&&directory.length<1024,
    'private absolute lock directory required');
  const path=resolve(directory);
  await mkdir(path,{recursive:true,mode:0o700});
  const stat=await lstat(path);
  deny(stat.isDirectory()&&!stat.isSymbolicLink()&&
    (process.platform==='win32'||(stat.mode&0o077)===0),
    'publisher lock directory must be private 0700 and not a symlink');
  return path;
}
export async function withR54ExclusivePublisher({
  directory,tenantToken,syntheticOnly=false
}={},job){
  deny(syntheticOnly===true,'only synthetic CDC publishers may acquire lease');
  deny(TOKEN.test(tenantToken||'')&&typeof job==='function',
    'opaque tenant token and publisher callback required');
  const root=await verifyDirectory(directory);
  const path=join(root,tenantToken+'.lease');
  const lease={format:'osmanx-r54-local-publisher-lease-v1',
    runId:randomBytes(16).toString('hex'),
    startedAt:new Date().toISOString(),pid:process.pid};
  let fd;
  try{
    fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  }catch(e){
    if(e.code==='EEXIST')
      throw Error('R5.4 publisher lease denied: another publisher owns tenant lease; manual recovery required');
    throw e;
  }
  let error;
  try{
    await fd.writeFile(JSON.stringify(lease)+'\n');await fd.sync();
    const result=await job({tenantToken,runId:lease.runId});
    return result;
  }catch(e){error=e;throw e;}
  finally{
    // Avoid unlinking a replacement lock that was created by another worker.
    try{
      const held=await fd.stat();
      const current=await lstat(path);
      deny(current.isFile()&&!current.isSymbolicLink()&&
        held.ino===current.ino&&held.dev===current.dev&&current.nlink===1,
        'publisher lease replaced during work; refusing to delete foreign lock');
      const content=await readFile(path,'utf8');
      deny(JSON.parse(content).runId===lease.runId,
        'publisher lease contents changed during work');
      await unlink(path);
    }catch(cleanup){
      if(!error)throw cleanup;
      // Preserve original failure, retain suspect lock for operator inspection.
    }finally{await fd.close();}
  }
}
