import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {appendR54CheckpointEvidence,readR54CheckpointEvidence}
  from '../src/migration/r54-checkpoint-evidence.mjs';
const token='a'.repeat(24);
function cycle(source,witnessed){
  return {format:'osmanx-r54-delivery-window-v1',
    syntheticOnly:true,observedCommittedSequence:source,
    witnessedSequence:witnessed,outstandingCommittedEvents:source-witnessed,
    oldestPendingWriteHintAgeMs:source===witnessed?null:1250,
    caughtUp:source===witnessed,alertRequired:source>witnessed,
    realTransactionRpoSecondsMeasured:false,
    maximumRpoSecondsCertified:null,
    productionCutoverAllowed:false};
}
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),'ox-r54-evidence-'));
  return {directory:join(dir,'private'),tenantToken:token,key:randomBytes(32),
    close:()=>rm(dir,{recursive:true,force:true})};
}
test('R5.4 checkpoint ledger chains witnessed progress and never certifies zero production RPO',async()=>{
  const f=await fixture();try{
    const a=await appendR54CheckpointEvidence(f,cycle(250,200));
    assert.equal(a.recordSequence,1);
    assert.equal(a.externallyAnchored,false);
    const b=await appendR54CheckpointEvidence(f,cycle(300,300));
    assert.equal(b.recordSequence,2);
    const status=await readR54CheckpointEvidence(f);
    assert.equal(status.recordCount,2);
    assert.equal(status.lastWitnessedSequence,300);
    assert.equal(status.lastOutstanding,0);
    assert.equal(status.lastAlertRequired,false);
    assert.equal(status.soleAuthorityForRemoteCheckpoint,false);
    assert.equal(status.productionCutoverAllowed,false);
  }finally{await f.close();}
});
test('R5.4 local HMAC rejects altered backlog and wrong independent key',async()=>{
  const f=await fixture();try{
    await appendR54CheckpointEvidence(f,cycle(10,8));
    await assert.rejects(readR54CheckpointEvidence({...f,key:randomBytes(32)}),
      /chain or HMAC failed/);
    const path=join(f.directory,token+'.jsonl');
    const raw=await readFile(path,'utf8');
    await writeFile(path,raw.replace('"outstanding":2','"outstanding":0'));
    await assert.rejects(readR54CheckpointEvidence(f),
      /chain or HMAC failed/);
  }finally{await f.close();}
});
test('R5.4 checkpoint receipt cannot regress external witnessed sequence',async()=>{
  const f=await fixture();try{
    await appendR54CheckpointEvidence(f,cycle(20,17));
    await assert.rejects(appendR54CheckpointEvidence(f,cycle(19,16)),
      /checkpoint cursor regressed/);
    const state=await readR54CheckpointEvidence(f);
    assert.equal(state.recordCount,1);
  }finally{await f.close();}
});
test('R5.4 detects truncated append and refuses false production status',async()=>{
  const f=await fixture();try{
    await appendR54CheckpointEvidence(f,cycle(7,3));
    const path=join(f.directory,token+'.jsonl');
    const raw=await readFile(path,'utf8');
    await writeFile(path,raw.trimEnd());
    await assert.rejects(readR54CheckpointEvidence(f),/torn checkpoint append/);
    await assert.rejects(appendR54CheckpointEvidence(f,{...cycle(7,3),
      productionCutoverAllowed:true}),/validated synthetic delivery receipt/);
  }finally{await f.close();}
});
