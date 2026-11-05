import { mkdirSync, readFileSync, openSync, writeFileSync, closeSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

// Linux /proc start ticks distinguish a restarted container's PID 1 from the
// previous container's PID 1. PID existence alone is never sufficient.
function startTicks(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const ticks = fields[19]; // proc field 22, with field 3 at index 0
    return /^\d+$/.test(ticks || '') ? ticks : null;
  } catch { return null; }
}
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}
function liveLock(path, expectedKind) {
  let value, st;
  try {
    st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) throw Error('Unsafe lock file');
    if (process.platform !== 'win32' && (st.mode & 0o022)) throw Error('Writable lock file');
    if (st.size > 2048) throw Error('Oversized lock file');
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw Error('Invalid lock file: ' + path);
  }
  if (!value || value.kind !== expectedKind || !Number.isSafeInteger(value.pid) || value.pid < 1)
    throw Error('Invalid lock identity: ' + path);
  if (processAlive(value.pid)) {
    const seen = startTicks(value.pid);
    // Older files without ticks and unsupported platforms fail closed if PID lives.
    if (!seen || !value.startTicks) return true;
    if (typeof value.startTicks !== 'string' || !/^\d+$/.test(value.startTicks))
      throw Error('Invalid process start identity: ' + path);
    if (seen === value.startTicks) return true;
  }
  // The process died or the same numeric PID belongs to a different process.
  unlinkSync(path);
  return false;
}
export function acquireLock(dataDir, kind) {
  if (!['server','maintenance'].includes(kind)) throw Error('Invalid lock');
  mkdirSync(dataDir, {recursive:true,mode:0o700});
  const own=join(dataDir,kind+'.lock');
  const otherKind=kind==='server'?'maintenance':'server';
  const other=join(dataDir,otherKind+'.lock');
  if (liveLock(other,otherKind) || liveLock(own,kind)) throw Error('Application is active: stop before maintenance');
  let fd;
  try { fd=openSync(own,'wx',0o600); }
  catch (e) { if (e.code==='EEXIST') throw Error('Operation locked'); throw e; }
  try { writeFileSync(fd,JSON.stringify({pid:process.pid,kind,startedAt:new Date().toISOString(),startTicks:startTicks(process.pid)})); }
  finally { closeSync(fd); }
  if (liveLock(other,otherKind)) {
    unlinkSync(own); throw Error('Operation conflict: server is running');
  }
  let released=false;
  return ()=>{if(!released){released=true;try{unlinkSync(own)}catch(e){if(e.code!=='ENOENT')throw e}}};
}
