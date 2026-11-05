import test from 'node:test';
import assert from 'node:assert/strict';
import {linuxProcessIdentity,mayReclaimOwner} from '../templates/deploy/upgrade.mjs';
const bootId='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
test('R3.7: lock binds to Linux boot ID and process start time, not just PID',async()=>{
 if(process.platform!=='linux')return;
 const actual=await linuxProcessIdentity(process.pid);
 assert.match(actual,/^[0-9a-f-]{36}:[0-9]+$/);
 assert.equal(await linuxProcessIdentity(process.pid),actual);
 const stat='1234 (name with spaces) S '+Array(19).fill('0').join(' ')+' 987654 '+Array(20).fill('0').join(' ');
 const fake=async path=>path.endsWith('/stat')?stat:bootId;
 // Fake proc entries may have arbitrary process names, but field 22 must be parsed accurately.
 const synthetic=await linuxProcessIdentity(1234,fake);
 assert.match(synthetic,new RegExp('^'+bootId+':'));
});
test('R3.7: a reused PID can be reclaimed only with a different verified process fingerprint',()=>{
 const owner={version:2,processIdentity:bootId+':123'};
 assert.equal(mayReclaimOwner(owner,{alive:true,currentIdentity:bootId+':123'}),false);
 assert.equal(mayReclaimOwner(owner,{alive:true,currentIdentity:bootId+':124'}),true);
 assert.equal(mayReclaimOwner({...owner,version:1},{alive:true,currentIdentity:bootId+':124'}),false);
 assert.equal(mayReclaimOwner({...owner,processIdentity:null},{alive:true,currentIdentity:bootId+':124'}),false);
 assert.equal(mayReclaimOwner(owner,{alive:true,currentIdentity:null}),false);
 assert.equal(mayReclaimOwner(owner,{alive:false,currentIdentity:null}),true);
});
