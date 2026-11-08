#!/usr/bin/env node
// Read-only release report inspector. No deployment, merge, or unquarantine.
import {readFile} from 'node:fs/promises';
import {evaluateR59ReleaseGate} from '../../src/migration/r59-release-gate.mjs';
if(process.env.OX_R59_SYNTHETIC_ONLY!=='YES'||
  process.env.OX_R40_EPHEMERAL!=='YES')throw Error('synthetic-only release report');
const source=process.argv[2];
if(!source||!source.startsWith('/'))throw Error('absolute report manifest path required');
const config=JSON.parse(await readFile(source,'utf8'));
const trusted={};
for(const [issuer,value] of Object.entries(config.trustedReporters||{})){
  if(!value?.publicKeyFile||!value.publicKeyFile.startsWith('/'))
    throw Error('absolute trusted reporter public key file required');
  trusted[issuer]={issuer,category:value.category,
    publicKey:await readFile(value.publicKeyFile)};
}
const result=evaluateR59ReleaseGate({
  tenantId:config.tenantId,evidence:config.evidence,trustedReporters:trusted
});
process.stdout.write(JSON.stringify(result,null,2)+'\n');
// All reports may be valid, but production still never passes through this CLI.
if(!result.syntheticLabGatePassed)process.exitCode=4;
