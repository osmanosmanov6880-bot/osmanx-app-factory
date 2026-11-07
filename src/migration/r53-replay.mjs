// R5.3 restore a signed R4.9 BASE plus independently witnessed encrypted
// R5.3 increments into a *new* private SQLite file. Only synthetic fixtures.
// No original archive or source DB is changed, no payments are executed.
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes} from 'node:crypto';
import {lstat,readFile,mkdir,open,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {inspectR53Schema} from './r53-commit-journal.mjs';
import {readR53AuthenticatedStream} from './r53-incremental.mjs';
const ID=/^[a-z][a-z0-9_]{0,63}$/;
function deny(ok,msg){if(!ok)throw Error('R5.3 replay refused: '+msg);}
function qi(v){deny(typeof v==='string'&&ID.test(v),'unsafe SQL identifier');return '"'+v+'"';}
async function inputFile(path){
  deny(typeof path==='string'&&path.startsWith('/'),'absolute trusted sealed snapshot required');
  const st=await lstat(path);
  deny(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&
    st.size>=4096&&st.size<=128*1024*1024&&
    (process.platform==='win32'||(st.mode&0o077)===0),
    'signed base SQLite must be private ordinary file');
  return st;
}
async function outputDir(path){
  deny(typeof path==='string'&&path.startsWith('/'),'private absolute restore directory required');
  const dst=resolve(path);
  await mkdir(dst,{recursive:true,mode:0o700});
  const st=await lstat(dst);
  deny(st.isDirectory()&&!st.isSymbolicLink()&&
    (process.platform==='win32'||(st.mode&0o077)===0),
    'recovery directory requires 0700 and no symlink');
  return dst;
}
function hashRows(db,schema){
  const hash=createHash('sha256');
  for(const item of schema.tables){
    const rows=db.prepare('SELECT '+item.columns.map(c=>qi(c.name)).join(',')+
      ' FROM '+qi(item.table)+' ORDER BY '+qi(item.key)).all();
    deny(rows.length<=10000,'replayed table outside synthetic row bound');
    hash.update(item.table+'\0'+rows.length+'\n');
    for(const row of rows)hash.update(JSON.stringify(
      item.columns.map(c=>row[c.name]))+'\n');
  }
  return hash.digest('hex');
}
function apply(db,events,schema){
  const specs=new Map(schema.tables.map(x=>[x.table,x]));
  let current=0;
  for(const event of events){
    deny(event.seq===++current&&typeof event.recordKey==='string'&&
      event.recordKey.length>0&&event.recordKey.length<=256,
      'replayed commit cursor not contiguous');
    const item=specs.get(event.table);
    deny(item&&['upsert','delete'].includes(event.operation),
      'untracked data or invalid commit operation');
    if(event.operation==='delete'){
      deny(event.after===null,'delete event contains data');
      db.prepare('DELETE FROM '+qi(item.table)+' WHERE '+qi(item.key)+'=?')
        .run(event.recordKey);
      continue;
    }
    deny(event.after&&typeof event.after==='object'&&!Array.isArray(event.after)&&
      Object.keys(event.after).length===item.columns.length&&
      event.after[item.key]===event.recordKey,
      'invalid after-image primary key or column count');
    const columns=item.columns.map(c=>c.name);
    deny(columns.every(key=>Object.hasOwn(event.after,key)&&
      (event.after[key]===null||
      (typeof event.after[key]==='string'||typeof event.after[key]==='number'))),
      'invalid decrypted column type');
    const params=columns.map(c=>event.after[c]);
    const update=columns.filter(c=>c!==item.key).map(c=>
      qi(c)+'=excluded.'+qi(c)).join(',');
    const sql='INSERT INTO '+qi(item.table)+' ('+columns.map(qi).join(',')+
      ') VALUES ('+columns.map(()=>'?').join(',')+') ON CONFLICT('+qi(item.key)+
      ') DO UPDATE SET '+update;
    db.prepare(sql).run(...params);
  }
}
export async function restoreR53Incremental({
  baseRestoreReceipt,recoveryDirectory,...streamConfig
}={}){
  deny(baseRestoreReceipt?.format==='osmanx-r49-offline-dr-v1'&&
    baseRestoreReceipt.readOnlySource===true&&
    baseRestoreReceipt.catalogWitnessVerified===true&&
    baseRestoreReceipt.objectLockVerified===true&&
    baseRestoreReceipt.productionCutoverAllowed===false&&
    Number.isSafeInteger(baseRestoreReceipt.signedTablesVerified)&&
    baseRestoreReceipt.signedTablesVerified>0,
    'R4.9 signed, WORM-protected base recovery proof required');
  const source=baseRestoreReceipt.outputFile;
  await inputFile(source);
  const dir=await outputDir(recoveryDirectory);
  const stream=await readR53AuthenticatedStream({
    ...streamConfig,baselineArchiveId:baseRestoreReceipt.archiveId
  });
  deny(stream.baselineArchiveId===baseRestoreReceipt.archiveId&&stream.authenticated===true&&
    stream.allVersionsWormVerified===true&&stream.independentWitnessVerified===true&&
    stream.events.length===stream.throughSequence,
    'encrypted incremental chain not bound to sealed baseline');
  const plaintext=await readFile(source);
  const signedBaseSha256=createHash('sha256').update(plaintext).digest('hex');
  const output=join(dir,'r53-recovered-'+randomBytes(12).toString('hex')+'.sqlite');
  let fd,db,created=false;
  try{
    fd=await open(output,'wx',0o600);created=true;
    await fd.writeFile(plaintext);await fd.sync();await fd.close();fd=null;
    db=new DatabaseSync(output,{enableForeignKeyConstraints:true});
    const schema=inspectR53Schema(db);
    deny(schema.digest===stream.schemaDigest,'restored base schema differs from journal schema');
    db.exec('BEGIN IMMEDIATE');
    try{
      db.exec('PRAGMA defer_foreign_keys=ON');
      apply(db,stream.events,schema);
      deny(db.prepare('PRAGMA foreign_key_check').all().length===0,
        'replayed commits violate foreign keys');
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    const fingerprint=hashRows(db,schema);
    // Idempotent retry runs on an isolated copy; any different row hash
    // means an upsert/delete changed business data on retry.
    db.exec('BEGIN IMMEDIATE');
    try{
      db.exec('PRAGMA defer_foreign_keys=ON');
      apply(db,stream.events,schema);
      deny(db.prepare('PRAGMA foreign_key_check').all().length===0,
        'idempotent retry changed foreign keys');
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    deny(hashRows(db,schema)===fingerprint,
      'replaying signed changes twice is not idempotent');
    deny(db.prepare('PRAGMA integrity_check').get()?.integrity_check==='ok'&&
      db.prepare('PRAGMA foreign_key_check').all().length===0,
      'restored incremental SQLite integrity failed');
    db.close();db=null;
    const unchanged=createHash('sha256').update(await readFile(source)).digest('hex');
    deny(unchanged===signedBaseSha256,'original signed R4.9 base was modified');
    return {format:'osmanx-r53-incremental-recovery-v1',
      syntheticOnly:true,outputFile:output,
      appliedCommittedChanges:stream.events.length,
      lastCoveredSequence:stream.throughSequence,
      authenticatedHistoryVerified:true,independentWitnessVerified:true,
      versionedObjectLockVerified:true,sourceSealedBaseUnchanged:true,
      idempotentRetryVerified:true,sqliteIntegrityVerified:true,
      foreignKeysVerified:true,recoveredBusinessRowsSha256:fingerprint,
      lostFromCoveredCommittedSequence:0,
      originalSnapshotAgeDoesNotProveRpo:true,
      preCaptureTransactionsNotCovered:true,
      continuousProductionCaptureVerified:false,
      realTransactionRpoSecondsMeasured:false,
      productionCutoverAllowed:false};
  }catch(e){
    db?.close();await fd?.close();
    if(created)await unlink(output).catch(()=>{});
    throw e;
  }finally{plaintext.fill(0);}
}
