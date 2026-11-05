// Deterministic ZIP writer, STORE entries, no external packages. Tested with Python zipfile.
export function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i=0;i<8;i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function createZip(files) {
  const local=[], central=[];
  let offset=0;
  const sorted = [...files].sort((a,b)=>a.name.localeCompare(b.name));
  for (const item of sorted) {
    const filename = Buffer.from(item.name.replaceAll('\\','/'), 'utf8');
    if (item.name.startsWith('/') || item.name.split('/').includes('..') || filename.length>65535) throw new Error('Unsafe archive path');
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50,0); lh.writeUInt16LE(20,4); lh.writeUInt16LE(0x0800,6);
    lh.writeUInt16LE(0,8); lh.writeUInt16LE(0,10); lh.writeUInt16LE(0,12);
    lh.writeUInt32LE(crc,14); lh.writeUInt32LE(data.length,18); lh.writeUInt32LE(data.length,22);
    lh.writeUInt16LE(filename.length,26); lh.writeUInt16LE(0,28);
    local.push(lh,filename,data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50,0); ch.writeUInt16LE(20,4); ch.writeUInt16LE(20,6);
    ch.writeUInt16LE(0x0800,8); ch.writeUInt16LE(0,10); ch.writeUInt16LE(0,12); ch.writeUInt16LE(0,14);
    ch.writeUInt32LE(crc,16); ch.writeUInt32LE(data.length,20); ch.writeUInt32LE(data.length,24);
    ch.writeUInt16LE(filename.length,28); ch.writeUInt16LE(0,30); ch.writeUInt16LE(0,32);
    ch.writeUInt16LE(0,34); ch.writeUInt16LE(0,36); ch.writeUInt32LE(0,38); ch.writeUInt32LE(offset,42);
    central.push(ch,filename);
    offset+=lh.length+filename.length+data.length;
  }
  const cbytes=central.reduce((n,b)=>n+b.length,0);
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(0,4); end.writeUInt16LE(0,6);
  end.writeUInt16LE(sorted.length,8); end.writeUInt16LE(sorted.length,10);
  end.writeUInt32LE(cbytes,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,...central,end]);
}
