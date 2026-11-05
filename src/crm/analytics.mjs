export function readAnalytics(db, currency='RUB') {
  const count = (sql,...params)=>db.prepare(sql).get(...params).n;
  const clients=count('SELECT COUNT(*) n FROM clients WHERE archived_at IS NULL');
  const visits=count('SELECT COUNT(*) n FROM visits');
  const visitedClients=count('SELECT COUNT(DISTINCT client_id) n FROM visits');
  const repeatClients=count('SELECT COUNT(*) n FROM (SELECT client_id FROM visits GROUP BY client_id HAVING COUNT(*)>=2)');
  const openTasks=count("SELECT COUNT(*) n FROM tasks WHERE status IN ('todo','doing')");
  const overdueTasks=count("SELECT COUNT(*) n FROM tasks WHERE status IN ('todo','doing') AND due_at IS NOT NULL AND due_at < ?",new Date().toISOString());
  const paid=db.prepare("SELECT COALESCE(SUM(amount_minor),0) sum FROM payments WHERE status='paid' AND currency=?").get(currency).sum;
  const pending=db.prepare("SELECT COALESCE(SUM(amount_minor),0) sum FROM payments WHERE status='pending' AND currency=?").get(currency).sum;
  const monthly=db.prepare(`SELECT substr(created_at,1,7) month,
    COALESCE(SUM(CASE WHEN status='paid' THEN amount_minor ELSE 0 END),0) total_minor
    FROM payments WHERE currency=? AND created_at>=? GROUP BY substr(created_at,1,7) ORDER BY month`).all(currency,new Date(Date.now()-365*24*3600*1000).toISOString());
  const sourceBreakdown=db.prepare(`SELECT source,COUNT(*) count FROM clients WHERE archived_at IS NULL GROUP BY source ORDER BY count DESC`).all();
  const latestTasks=db.prepare(`SELECT t.id,t.title,t.status,t.priority,t.due_at,c.full_name client_name
    FROM tasks t LEFT JOIN clients c ON c.id=t.client_id
    WHERE t.status IN ('todo','doing') ORDER BY CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END,t.due_at LIMIT 6`).all();
  return {
    currency,
    totals:{clients,visits,visitedClients,repeatClients,repeatShare:visitedClients?Math.round(1000*repeatClients/visitedClients)/10:0,
      openTasks,overdueTasks,paidMinor:paid,pendingMinor:pending},
    monthly,sourceBreakdown,latestTasks,
    notes:{
      repeatShare:'Доля клиентов с двумя или более зарегистрированными визитами среди клиентов хотя бы с одним визитом; не когортное удержание.',
      paidMinor:'Сумма только вручную зарегистрированных операций в статусе paid по выбранной валюте; не банковская выручка.'
    }
  };
}
