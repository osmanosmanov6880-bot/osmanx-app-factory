#!/usr/bin/env node
// No cloud credentials required: network sanity check, NOT proof of provider ownership.
import {inspectR50Topology} from '../../src/migration/r50-topology.mjs';
const required=name=>{
  const x=process.env[name];
  if(!x)throw Error('Missing '+name);
  return x;
};
try{
  const result=await inspectR50Topology({
    storageEndpoint:required('OX_R50_STORAGE_ENDPOINT'),
    witnessEndpoint:required('OX_R50_WITNESS_ENDPOINT'),
    alertEndpoint:process.env.OX_R50_ALERT_ENDPOINT||undefined,
    allowSyntheticLoopback:process.env.OX_R50_CONFIRM_SYNTHETIC==='YES'&&
      process.env.OX_R40_EPHEMERAL==='YES'
  });
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
  if(!result.syntheticOnly&&!result.dnsAddressSeparated)process.exitCode=2;
}catch(e){
  process.stderr.write('R5.0 network preflight: '+String(e.message).slice(0,200)+'\n');
  process.exitCode=2;
}
