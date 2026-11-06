// R5.2 synthetic transaction-loss measurement. A signed, older backup
// can be perfectly restorable while missing transactions committed later.
// This is a sampled failure scenario, not a real workload RPO SLA.
import {DatabaseSync} from 'node:sqlite';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function deny(ok,msg){if(!ok)throw Error('R5.2 RPO gate refused: '+msg);}
function open(path){
  deny(typeof path==='string'&&path.startsWith('/')&&path.endsWith('.sqlite'),
    'isolated absolute SQLite database path required');
  return new DatabaseSync(path,{readOnly:true});
}
export function inspectR52SyntheticTransactionLoss({
  sourcePath,recoveredPath,committedAfterBackupIds,
  maxLostTransactions=0,syntheticOnly=false
}={}){
  deny(syntheticOnly===true,'RPO rehearsal requires isolated synthetic test mode');
  deny(Array.isArray(committedAfterBackupIds)&&
    committedAfterBackupIds.length>=1&&committedAfterBackupIds.length<=30&&
    committedAfterBackupIds.every(id=>typeof id==='string'&&UUID.test(id))&&
    new Set(committedAfterBackupIds).size===committedAfterBackupIds.length,
    'distinct committed synthetic task transaction IDs required');
  deny(Number.isSafeInteger(maxLostTransactions)&&maxLostTransactions>=0&&
    maxLostTransactions<=30,'invalid synthetic loss budget');
  let source,recovered;
  try{
    source=open(sourcePath);recovered=open(recoveredPath);
    deny(source.prepare('PRAGMA integrity_check').get()?.integrity_check==='ok'&&
      recovered.prepare('PRAGMA integrity_check').get()?.integrity_check==='ok',
      'SQLite integrity check failed');
    const get=db=>db.prepare('SELECT id FROM tasks WHERE id=?');
    const selectSource=get(source),selectRecovered=get(recovered);
    let lastCommitted=0,recoveredCount=0,missingCount=0;
    for(const id of committedAfterBackupIds){
      const sourceHas=!!selectSource.get(id),recoveryHas=!!selectRecovered.get(id);
      deny(sourceHas,'synthetic post-backup transaction not committed in primary');
      lastCommitted++;
      if(recoveryHas)recoveredCount++;else missingCount++;
    }
    return Object.freeze({
      format:'osmanx-r52-transaction-loss-v1',
      syntheticOnly:true,
      transactionIdsChecked:lastCommitted,
      committedAfterBackup:lastCommitted,
      recoveredAfterBackup:recoveredCount,
      lostSinceBackup:missingCount,
      withinTestLossBudget:missingCount<=maxLostTransactions,
      // Counts transactions, not time; a real production RPO needs
      // continuous per-tenant commit watermarks and a verified fault instant.
      transactionLevelRpoSecondsMeasured:false,
      sourceOpenedReadOnly:true,recoveryOpenedReadOnly:true,
      productionCutoverAllowed:false
    });
  }finally{
    recovered?.close();source?.close();
  }
}
export function enforceR52SyntheticLossBudget(result){
  deny(result?.format==='osmanx-r52-transaction-loss-v1'&&
    result.syntheticOnly===true&&
    result.sourceOpenedReadOnly===true&&result.recoveryOpenedReadOnly===true&&
    result.productionCutoverAllowed===false,
    'trusted synthetic transaction-loss measurement required');
  deny(result.withinTestLossBudget===true,
    'committed synthetic transactions missing from last sealed backup');
  return {testLossBudgetAccepted:true,productionCutoverAllowed:false};
}
