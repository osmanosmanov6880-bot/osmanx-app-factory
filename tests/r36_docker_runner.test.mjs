import test from 'node:test';
import assert from 'node:assert/strict';
import {dockerRestartScenario} from '../scripts/r36_docker_e2e.mjs';

test('R3.6 synthetic Docker suite always cleans up after a failed app build',async()=>{
 const calls=[];
 const fake=(args)=>{
  calls.push(args.join(' '));
  if(args.slice(0,4).join(' ')==='docker compose up -d')throw Error('synthetic build failed');
  return '';
 };
 await assert.rejects(dockerRestartScenario('crm',{exec:fake}),/synthetic build failed/);
 assert.ok(calls.some(c=>c==='docker compose down --volumes --remove-orphans'));
 assert.ok(!calls.some(c=>c.includes('gateway')));
});

test('R3.6 Docker cleanup failures are never reported as a successful acceptance',async()=>{
 const fake=args=>{
  const command=args.join(' ');
  if(command.startsWith('docker compose up -d'))throw Error('app failed');
  if(command==='docker compose down --volumes --remove-orphans')throw Error('cannot remove volume');
  return '';
 };
 await assert.rejects(dockerRestartScenario('site',{exec:fake}),/cleanup failed/);
});
