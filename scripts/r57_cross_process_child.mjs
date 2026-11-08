// R5.7 external-process lease probe for disposable PostgreSQL CI only.
import pg from 'pg';
import {createR57PgCoordinator} from '../src/migration/r57-pg-coordinator.mjs';
const tenant=process.argv[2],holder=process.argv[3];
if(process.env.OX_R57_E2E!=='YES'||!(/^[a-f0-9]{24}$/.test(tenant||''))||
  !(/^[a-f0-9]{24}$/.test(holder||''))){
  process.stderr.write('R5.7 synthetic-only child denied\n');process.exit(4);
}
const pool=new pg.Pool({
  host:process.env.PGHOST||'127.0.0.1',
  port:Number(process.env.PGPORT||5432),
  user:process.env.PGUSER||'postgres',
  password:process.env.PGPASSWORD||'',
  database:process.env.PGDATABASE||'ox_r57',
  connectionTimeoutMillis:5000,statement_timeout:10000
});
const deniedRemote={
  tenantPrefix:tenant+'/',role:'pointer-coordinator-only',
  async put(){throw Error('child process has no S3 PUT capability');},
  async getWithMetadata(){throw Error('child process has no S3 GET capability');},
  async inspectR49Worm(){throw Error('child process has no S3 WORM capability');},
  async assertBucketControls(){throw Error('child process has no S3 bucket capability');}
};
try{
  const c=createR57PgCoordinator({
    pool,privilegedRemote:deniedRemote,tenantId:tenant,syntheticOnly:true
  });
  try{
    const lease=await c.acquire({tenant,holder,ttlMs:1000});
    await c.release(lease);
    process.stdout.write(JSON.stringify({acquired:true,epoch:lease.epoch})+'\n');
  }catch(e){
    if(!/another publisher holds the lease|unresolved S3 intent/.test(String(e.message))){
      throw e;
    }
    process.stdout.write(JSON.stringify({acquired:false})+'\n');
  }
}finally{await pool.end();}
