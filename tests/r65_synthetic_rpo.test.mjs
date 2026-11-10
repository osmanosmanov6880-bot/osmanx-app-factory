import test from 'node:test';
import assert from 'node:assert/strict';
import {measureR65SyntheticRpo,readR65PostgresLedger}
  from '../src/migration/r65-synthetic-rpo.mjs';
const TENANT='a'.repeat(24),START=Date.now();
function fixture(){
  const acknowledged=Array.from({length:20},(_,i)=>({
    seq:i+1,sha256:(i+1).toString(16).padStart(64,'0'),
    committedLsn:'0/'+(0x1000+i*0x100).toString(16).toUpperCase(),
    acknowledgedAtMs:START+i*25
  }));
  const restoredRows=acknowledged.slice(0,12).map(x=>({
    seq:x.seq,sha256:x.sha256
  }));
  return {tenantId:TENANT,acknowledged,restoredRows,
    targetLsn:acknowledged[11].committedLsn,
    failureAtMs:START+600,recoveryAtMs:START+4600,
    sourceProcessDestroyed:true,dualRemoteBytesVerified:true};
}
test('R6.5 actual acknowledgements after last restored transaction yield positive synthetic RPO gap',
  ()=>{
    const v=measureR65SyntheticRpo(fixture());
    assert.equal(v.acknowledgedTransactions,20);
    assert.equal(v.recoveredTransactions,12);
    assert.equal(v.lostAcknowledgedTransactions,8);
    assert.equal(v.lastRecoveredSequence,12);
    assert.equal(v.observedAckGapMs,8*25);
    assert.equal(v.failureToRestoreMs,4000);
    assert.equal(v.zeroRpoDemonstrated,false);
    assert.equal(v.sourceSqliteCommitMeasured,false);
    assert.equal(v.industrialZeroRpoCertified,false);
    assert.equal(v.productionCutoverAllowed,false);
});
test('R6.5 ledger holes, phantom transaction and missing source WAL reject verification',
  ()=>{
    const f=fixture();
    assert.throws(()=>measureR65SyntheticRpo({...f,
      restoredRows:[...f.restoredRows.slice(0,3),{
        seq:5,sha256:'f'.repeat(64)
      },...f.restoredRows.slice(4)]
    }),/ledger duplicate, hole/);
    assert.throws(()=>measureR65SyntheticRpo({...f,
      restoredRows:[...f.restoredRows,{
        seq:13,sha256:'e'.repeat(64)
      }]
    }),/corrupted or reordered/);
    assert.throws(()=>measureR65SyntheticRpo({...f,
      restoredRows:f.restoredRows.slice(0,11)
    }),/omitted a pre-target commit/);
    assert.throws(()=>measureR65SyntheticRpo({...f,
      acknowledged:f.acknowledged.map((x,i)=>
        i===10?{...x,committedLsn:'0/0001'}:x)
    }),/nonmonotonic/);
});
test('R6.5 remote WORM must be verified and former primary actually destroyed',()=>{
  const f=fixture();
  assert.throws(()=>measureR65SyntheticRpo({...f,
    sourceProcessDestroyed:false
  }),/full source crash/);
  assert.throws(()=>measureR65SyntheticRpo({...f,
    dualRemoteBytesVerified:false
  }),/full source crash/);
  assert.throws(()=>measureR65SyntheticRpo({...f,
    failureAtMs:START+50
  }),/later than crash/);
});
test('R6.5 tenant-scope PostgreSQL ledger rows are read with query parameters',
  async()=>{
    const q=[];
    const out=await readR65PostgresLedger({
      tenantId:TENANT,pool:{async query(sql,values){
        q.push([sql,values]);
        return {rows:[{seq:1,sha256:'f'.repeat(64)}]};
      }}
    });
    assert.equal(out.length,1);
    assert.match(q[0][0],/WHERE tenant=\$1/);
    assert.deepEqual(q[0][1],[TENANT]);
    assert.equal(out[0].seq,1);
  });
