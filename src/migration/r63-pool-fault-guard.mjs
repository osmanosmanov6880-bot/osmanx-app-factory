// R6.3: bounded observations of idle pg.Pool connection failures.
// An error on a pool's idle socket is async; not catching it can crash
// an otherwise correctly fenced disaster drill. Never convert to success.
const ROLES=new Set(['primary','standby','restore']);
function deny(ok,why){if(!ok)throw Error('R6.3 pool fault observer refused: '+why);}
export function observeR63PgPoolFaults({
  pool,role,limit=32,now=()=>Date.now()
}={}){
  deny(pool?.on&&pool?.off&&ROLES.has(role)&&
    Number.isSafeInteger(limit)&&limit>=1&&limit<=64&&
    typeof now==='function',
    'pinned PostgreSQL pool and role required');
  const events=[];let total=0,closed=false;
  function onError(error){
    total++;
    const message=String(error?.message||error||'unknown').slice(0,160);
    const code=String(error?.code||'SOCKET_CLOSED').slice(0,24);
    events.push(Object.freeze({role,at:now(),code,message}));
    if(events.length>limit)events.shift();
  }
  pool.on('error',onError);
  function snapshot(){
    return Object.freeze({
      format:'osmanx-r63-pg-pool-faults-v1',role,
      totalFaults:total,retainedFaults:[...events],
      diagnosticOnly:true,quarantineRequired:total>0,
      commitOutcomeConfirmed:false,canPromote:false,
      canClearPendingIntent:false,productionCutoverAllowed:false
    });
  }
  function stop(){
    if(!closed){closed=true;pool.off('error',onError);}
    return snapshot();
  }
  return Object.freeze({snapshot,stop,role,
    productionCutoverAllowed:false});
}
