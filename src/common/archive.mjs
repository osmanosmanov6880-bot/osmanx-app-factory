import { crc32 } from './zip.mjs';

function safeName(name){
  return typeof name==='string' && name.length<=200 && !name.startsWith('/') &&
    !name.includes('\\') && !name.includes('\0') && !name.includes(':') &&
    name.split('/').every(x=>x && x!=='.' && x!=='..') &&
    /^[a-zA-Z0-9_./-]+$/.test(name);
}
// STORE-only ZIP reader for packages emitted by this factory; rejects malformed and oversized archives.
export function parseStoredZip(buffer,{maxFiles=250,maxBytes=30*1024*1024}={}){
  if(!Buffer.isBuffer(buffer)||buffer.length>maxBytes||buffer.length<22)throw Error('Invalid or oversized ZIP');
  const end=buffer.length-22;
  if(buffer.readUInt32LE(end)!==0x06054b50||buffer.readUInt16LE(end+20)!==0)throw Error('ZIP trailer invalid');
  const count=buffer.readUInt16LE(end+10),centralSize=buffer.readUInt32LE(end+12),centralOffset=buffer.readUInt32LE(end+16);
  if(count<1||count>maxFiles||count!==buffer.readUInt16LE(end+8)||centralOffset+centralSize!==end)throw Error('ZIP central directory invalid');
  const result=new Map();let off=centralOffset,used=0;
  for(let i=0;i<count;i++){
    if(off+46> end||buffer.readUInt32LE(off)!==0x02014b50)throw Error('Bad ZIP central header');
    const flags=buffer.readUInt16LE(off+8),method=buffer.readUInt16LE(off+10);
    const crc=buffer.readUInt32LE(off+16),compressed=buffer.readUInt32LE(off+20),size=buffer.readUInt32LE(off+24);
    const nameLength=buffer.readUInt16LE(off+28),extra=buffer.readUInt16LE(off+30),comment=buffer.readUInt16LE(off+32);
    const disk=buffer.readUInt16LE(off+34),localOffset=buffer.readUInt32LE(off+42);
    if(flags!==0x0800||method!==0||size!==compressed||disk!==0)throw Error('Unsupported ZIP compression or flags');
    if(off+46+nameLength+extra+comment>end)throw Error('ZIP directory bounds');
    const name=buffer.subarray(off+46,off+46+nameLength).toString('utf8');
    if(!safeName(name)||result.has(name))throw Error('Duplicate or unsafe ZIP entry');
    if(localOffset+30>centralOffset||buffer.readUInt32LE(localOffset)!==0x04034b50)throw Error('Local ZIP header missing');
    const lNameLength=buffer.readUInt16LE(localOffset+26),lExtra=buffer.readUInt16LE(localOffset+28);
    if(buffer.readUInt16LE(localOffset+8)!==0||buffer.readUInt32LE(localOffset+18)!==size)throw Error('Local ZIP size or method mismatch');
    const localName=buffer.subarray(localOffset+30,localOffset+30+lNameLength).toString('utf8');
    if(localName!==name)throw Error('ZIP header name mismatch');
    const start=localOffset+30+lNameLength+lExtra;
    if(start+size>centralOffset)throw Error('ZIP data bounds');
    const data=buffer.subarray(start,start+size);
    if(crc32(data)!==crc)throw Error('ZIP CRC mismatch: '+name);
    used+=size;if(used>maxBytes)throw Error('ZIP extracted content too large');
    result.set(name,Buffer.from(data));
    off+=46+nameLength+extra+comment;
  }
  if(off!==end)throw Error('ZIP directory length mismatch');
  return result;
}
