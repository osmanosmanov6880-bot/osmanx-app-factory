#!/usr/bin/env node
import { resolve } from 'node:path';
import { exportMigration, planMigration, verifyMigration, verifyPostgres } from '../src/migration/pg-kit.mjs';
import { preflightPostgres, applyPostgres, applyTenantAcl, assessPostgresTarget, verifyPostgresSnapshot, verifyTenantAcl } from '../src/migration/pg-operations.mjs';
import { createSigningIdentity, signMigration, verifyTrustedMigration } from '../src/migration/pg-trust.mjs';

function option(args,key,defaultValue=null){
  const index=args.indexOf(key);
  if(index<0)return defaultValue;
  if(index===args.length-1 || args[index+1].startsWith('--'))throw Error('Missing value for '+key);
  return args[index+1];
}
const usage=`OSMANX PostgreSQL offline migration (R13 source baseline)

  npm run pg:plan -- --data ./data
  npm run pg:export -- --data ./data --out ./private-migration --allow-sensitive
  npm run pg:verify -- --in ./private-migration
  npm run pg:keygen -- --out ./private-signing-identity
  npm run pg:sign -- --in ./private-migration --key ./private-signing-identity/private.pem
  npm run pg:verify-signature -- --in ./private-migration --trusted-public-key ./private-signing-identity/public.pem
  npm run pg:preflight -- --in ./private-migration
  npm run pg:apply -- --in ./private-migration --trusted-public-key ./private-signing-identity/public.pem --confirm-atomic-import --receipt ./private-receipt.json
  npm run pg:verify-snapshot -- --in ./private-migration
  npm run pg:apply-acl -- --in ./private-migration --trusted-public-key ./private-signing-identity/public.pem --confirm-tenant-acl
  npm run pg:assess -- --in ./private-migration --trusted-public-key ./private-signing-identity/public.pem
  npm run pg:verify-acl -- --in ./private-migration
  npm run pg:verify-target -- --in ./private-migration # legacy per-table verifier

Export requires the factory to be stopped. Only use a private, encrypted disk and
restrict access to the output: it contains customer records and password hashes.
Sessions are reset. The PostgreSQL importer runs as ONE transaction.
--confirm-atomic-import permits changes to the configured PGDATABASE.
The live application still runs on SQLite. No runtime database switch is enabled.
The target verification reads connection settings from PG* environment variables.
`;
try{
  const args=process.argv.slice(2);
  const command=args[0];
  const data=resolve(option(args,'--data', process.env.DATA_DIR||'./data'));
  if(command==='keygen'){
    const out=option(args,'--out');if(!out)throw Error('Provide --out for the private key directory');
    console.log(JSON.stringify(await createSigningIdentity(resolve(out)),null,2));
  }else if(command==='sign'){
    const input=option(args,'--in'),key=option(args,'--key');if(!input||!key)throw Error('Provide --in and --key');
    console.log(JSON.stringify(await signMigration(resolve(input),resolve(key)),null,2));
  }else if(command==='verify-signature'){
    const input=option(args,'--in'),key=option(args,'--trusted-public-key');if(!input||!key)throw Error('Provide --in and --trusted-public-key');
    const r=await verifyTrustedMigration(resolve(input),resolve(key));
    console.log(JSON.stringify({ok:true,manifestSha256:r.manifestSha256,keyFingerprint:r.keyFingerprint,databases:r.manifest.databases.length},null,2));
  }else if(command==='plan'){
    console.log(JSON.stringify({ok:true,databases:await planMigration(data)},null,2));
  }else if(command==='export'){
    const out=option(args,'--out');if(!out)throw Error('Provide --out');
    const result=await exportMigration(data,resolve(out),{allowSensitive:args.includes('--allow-sensitive')});
    console.log(JSON.stringify({ok:true,...result,sensitive:true,postgreSqlRuntimeConnected:false},null,2));
  }else if(command==='verify'){
    const input=option(args,'--in');if(!input)throw Error('Provide --in');
    const manifest=await verifyMigration(resolve(input));
    console.log(JSON.stringify({ok:true,databases:manifest.databases.length,checksumsVerified:true,targetVerified:false}));
  }else if(command==='preflight'){
    const input=option(args,'--in');if(!input)throw Error('Provide --in');
    console.log(JSON.stringify(await preflightPostgres(resolve(input)),null,2));
  }else if(command==='apply'){
    const input=option(args,'--in');if(!input)throw Error('Provide --in');
    const receiptPath=option(args,'--receipt');
    const result=await applyPostgres(resolve(input),{
      confirm:args.includes('--confirm-atomic-import'),
      verify:!args.includes('--skip-target-verification'),
      receiptPath:receiptPath?resolve(receiptPath):null,
      trustedPublicKey:option(args,'--trusted-public-key')?resolve(option(args,'--trusted-public-key')):null
    });
    console.log(JSON.stringify({...result,sqliteRuntimeUnchanged:true},null,2));
  }else if(command==='apply-acl'){
    const input=option(args,'--in');if(!input)throw Error('Provide --in');
    console.log(JSON.stringify(await applyTenantAcl(resolve(input),{
      confirm:args.includes('--confirm-tenant-acl'),
      trustedPublicKey:option(args,'--trusted-public-key')?resolve(option(args,'--trusted-public-key')):null,
      receiptPath:option(args,'--receipt')?resolve(option(args,'--receipt')):null
    }),null,2));
  }else if(command==='assess'){
    const input=option(args,'--in'),key=option(args,'--trusted-public-key');if(!input||!key)throw Error('Provide --in and --trusted-public-key');
    console.log(JSON.stringify(await assessPostgresTarget(resolve(input),{
      trustedPublicKey:resolve(key),receiptPath:option(args,'--receipt')?resolve(option(args,'--receipt')):null
    }),null,2));
  }else if(command==='verify-snapshot'){
    const input=option(args,'--in');if(!input)throw Error('Provide --in');
    console.log(JSON.stringify(await verifyPostgresSnapshot(resolve(input)),null,2));
  }else if(command==='verify-acl'){
    const input=option(args,'--in');if(!input)throw Error('Provide --in');
    console.log(JSON.stringify(await verifyTenantAcl(resolve(input)),null,2));
  }else if(command==='verify-target'){
    const input=option(args,'--in');if(!input)throw Error('Provide --in');
    const result=await verifyPostgres(resolve(input));
    console.log(JSON.stringify({ok:true,tableCount:result.tables,sourceAndTargetHashesMatch:true}));
  }else {console.log(usage);if(command && command!=='help')process.exitCode=2;}
}catch(error){console.error('[PG-MIGRATION] '+error.message);process.exitCode=1;}
