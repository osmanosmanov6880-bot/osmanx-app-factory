/**
 * R3.3 standalone HTTP ingress drain. Stop admitting requests before shutdown,
 * then wait for handlers AND Node's listener to finish before closing SQLite.
 * A timeout must NOT close the DB while an asynchronous handler is still active.
 */
export function createRequestDrain(handler,{graceMs=75_000}={}) {
  if(typeof handler!=='function'||!Number.isInteger(graceMs)||graceMs<100||graceMs>120_000)
    throw Error('Invalid HTTP drain configuration');
  let draining=false,active=0,stopPromise=null;
  const waiters=new Set();
  const waitEmpty=()=>active===0?Promise.resolve():new Promise(resolve=>waiters.add(resolve));
  const handle=async(req,res)=>{
    if(draining){
      res.writeHead(503,{
        'Content-Type':'application/json; charset=utf-8',
        'Cache-Control':'no-store','Retry-After':'30','Connection':'close',
        'X-Content-Type-Options':'nosniff'
      });
      res.end(req.method==='HEAD'?'':JSON.stringify({ok:false,error:'Service is temporarily unavailable during maintenance'}));
      return;
    }
    active++;
    try{await handler(req,res)}
    finally{
      active--;
      if(active===0){for(const resolve of waiters)resolve();waiters.clear()}
    }
  };
  const stop=(server,closeDatabase)=>{
    if(stopPromise)return stopPromise;
    draining=true;
    stopPromise=(async()=>{
      const closed=new Promise((resolve,reject)=>{
        try{server.close(error=>error?reject(error):resolve())}
        catch(error){reject(error)}
      });
      server.closeIdleConnections?.();
      let timeout;
      try{
        await Promise.race([
          Promise.all([closed,waitEmpty()]),
          new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('HTTP drain exceeded '+graceMs+'ms; SQLite left open for safety')),graceMs)})
        ]);
      }finally{clearTimeout(timeout)}
      if(typeof closeDatabase==='function')await closeDatabase();
      return {ok:true,drained:true,activeRequests:0};
    })();
    return stopPromise;
  };
  return {handle,stop,get active(){return active},get draining(){return draining}};
}
