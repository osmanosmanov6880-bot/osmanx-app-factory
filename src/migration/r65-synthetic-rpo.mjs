// R6.5 synthetic acknowledged-commit gap measured across real PostgreSQL
// source acknowledgement and detached recovery. This does NOT measure source
// SQLite COMMIT-to-remote delivery or certify a production RPO.
const TENANT=/^[a-f0-9]{24}$/,SHA=/^[a-f0-9]{64}$/,
  LSN=/^[0-9A-F]+\/[0-9A-F]+$/;
function deny(ok,msg){if(!ok)throw Error('R6.5 acknowledged RPO refused: '+msg);}
function lsn(x){
  deny(LSN.test(x||''),'invalid acknowledged WAL LSN');
  const [hi,lo]=x.split('/');
  return BigInt('0x'+hi)*4294967296n+BigInt('0x'+lo);
}
function rows(input,max=250){
  deny(Array.isArray(input)&&input.length>=1&&input.length<=max,
    'bounded contiguous ledger required');
  return input.map((x,i)=>{
    deny(x&&Number(x.seq)===i+1&&SHA.test(x.sha256||''),
      'synthetic ledger duplicate, hole or altered payload hash');
    return {seq:i+1,sha256:x.sha256};
  });
}
export async function readR65PostgresLedger({
  pool,tenantId
}={}){
  deny(pool?.query&&TENANT.test(tenantId||''),
    'bound tenant and read-only PG query required');
  const x=await pool.query(
    'SELECT seq,payload_sha AS sha256 FROM ox_r65_commit_ledger '+
    'WHERE tenant=$1 ORDER BY seq LIMIT 251',[tenantId]);
  return Object.freeze(rows(x.rows));
}
export function measureR65SyntheticRpo({
  tenantId,acknowledged,restoredRows,targetLsn,
  failureAtMs,recoveryAtMs,
  sourceProcessDestroyed=false,
  dualRemoteBytesVerified=false
}={}){
  deny(TENANT.test(tenantId||'')&&
    Number.isSafeInteger(failureAtMs)&&failureAtMs>0&&
    Number.isSafeInteger(recoveryAtMs)&&recoveryAtMs>=failureAtMs&&
    sourceProcessDestroyed===true&&dualRemoteBytesVerified===true,
    'full source crash and two independently verified WAL processes required');
  const source=rows(acknowledged),restored=rows(restoredRows);
  deny(restored.length<=source.length,
    'restored ledger has unexplained post-source phantom rows');
  const target=lsn(targetLsn);
  let lastLsn=0n,lastTime=0;
  const checked=acknowledged.map((ack,i)=>{
    deny(Number.isSafeInteger(ack.acknowledgedAtMs)&&
      ack.acknowledgedAtMs>0&&ack.acknowledgedAtMs<=failureAtMs&&
      ack.acknowledgedAtMs>=lastTime,
      'acknowledgement timestamps are reordered or later than crash');
    const wal=lsn(ack.committedLsn);
    deny(wal>lastLsn,'source acknowledgement WAL positions are nonmonotonic');
    lastTime=ack.acknowledgedAtMs;lastLsn=wal;
    return {...source[i],acknowledgedAtMs:lastTime,lsn:wal};
  });
  for(let i=0;i<restored.length;i++){
    deny(restored[i].sha256===source[i].sha256,
      'restored acknowledged prefix is corrupted or reordered');
    deny(checked[i].lsn<=target,
      'restored transaction committed beyond target WAL LSN');
  }
  // The observed recovered prefix must include all ack'd rows whose
  // post-commit WAL observation is not after the chosen target LSN.
  const supposed=checked.filter(x=>x.lsn<=target).length;
  deny(restored.length===supposed,
    'recovery omitted a pre-target commit or included post-target data');
  const recoveredAck=checked[restored.length-1];
  const newestAck=checked[source.length-1];
  return Object.freeze({
    format:'osmanx-r65-synthetic-rpo-measurement-v1',
    tenantId,targetLsn,acknowledgedTransactions:source.length,
    recoveredTransactions:restored.length,
    lostAcknowledgedTransactions:source.length-restored.length,
    lastRecoveredSequence:restored.length,
    lastSourceAcknowledgedSequence:source.length,
    lastRecoveredAckAtMs:recoveredAck.acknowledgedAtMs,
    lastSourceAckAtMs:newestAck.acknowledgedAtMs,
    observedAckGapMs:newestAck.acknowledgedAtMs-
      recoveredAck.acknowledgedAtMs,
    failureToRestoreMs:recoveryAtMs-failureAtMs,
    sourceProcessDestroyed:true,dualRemoteBytesVerified:true,
    syntheticOnly:true,sourceSqliteCommitMeasured:false,
    fullApplicationWorkloadMeasured:false,
    zeroRpoDemonstrated:source.length===restored.length,
    industrialZeroRpoCertified:false,
    productionCutoverAllowed:false
  });
}
