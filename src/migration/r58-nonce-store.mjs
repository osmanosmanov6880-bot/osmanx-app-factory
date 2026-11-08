// R5.8 durable request anti-replay. Consume before dispatch, including
// failed operations. A lost HTTP response is retried with a fresh nonce and
// the SAME application-level idempotency operation ID.
const TENANT=/^[a-f0-9]{24}$/,NONCE=/^[a-f0-9]{32}$/;
function deny(ok,msg){if(!ok)throw Error('R5.8 nonce store refused: '+msg);}
export function createR58PgNonceStore({pool,tenantId}={}){
  deny(pool?.connect&&TENANT.test(tenantId||''),'pinned PostgreSQL tenant required');
  return Object.freeze({
    async consume(nonce){
      deny(NONCE.test(nonce||''),'invalid request ID');
      const client=await pool.connect();
      try{
        // This insert is committed before invoking the coordinator.
        // No delete/reuse in an automatic failure recovery path.
        const result=await client.query(
          'INSERT INTO ox_r58_request_nonce(tenant,nonce) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING nonce',
          [tenantId,nonce]);
        deny(result.rows.length===1,'duplicate request ID');
        return true;
      }finally{client.release();}
    },
    tenantId,syntheticOnly:true
  });
}
