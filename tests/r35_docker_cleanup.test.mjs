import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {scenario} from '../scripts/r34_docker_fleet_e2e.mjs';

const local=(argv,cwd,timeout)=>{
 const result=spawnSync(argv[0],argv.slice(1),{cwd,encoding:'utf8',timeout:timeout||30000});
 if(result.status!==0||result.error)throw Error(result.stderr||result.error?.message||'script failed');
 return result.stdout;
};
test('R3.5 Docker E2E always tears down synthetic volumes even if compose up fails',{timeout:30000},async()=>{
 const seen=[];
 const fake=(args,cwd,timeout)=>{
  if(args[0]==='docker'){
   seen.push(args.slice(1).join(' '));
   if(args.includes('up'))throw Error('synthetic Docker build failed');
   return '';
  }
  return local(args,cwd,timeout);
 };
 await assert.rejects(scenario('crm',{runCommand:fake}),/synthetic Docker build failed/);
 assert.deepEqual(seen,['compose config --quiet','compose up -d --build --wait app','compose down --volumes --remove-orphans']);
});
test('R3.5 Docker E2E retains diagnostics when teardown fails instead of reporting success',{timeout:30000},async()=>{
 const fake=(args,cwd,timeout)=>{
  if(args[0]==='docker'){
   if(args.includes('down'))throw Error('synthetic cleanup refusal');
   if(args.includes('ps'))return '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n';
   return '';
  }
  return local(args,cwd,timeout);
 };
 let location='';
 try{await scenario('site',{runCommand:fake});assert.fail('Cleanup failure cannot be ignored')}
 catch(e){
  assert.ok(e instanceof AggregateError);assert.match(e.message,/cleanup failed/);
  location=e.message.split(' at ').at(-1);
 }
 // Only test-generated, randomly created /tmp folders may be removed here.
 assert.match(location,/ox-r34-docker-/);
 const {rm}=await import('node:fs/promises');await rm(location,{recursive:true,force:true});
});
