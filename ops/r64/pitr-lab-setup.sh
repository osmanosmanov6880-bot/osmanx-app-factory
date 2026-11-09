#!/usr/bin/env bash
# R6.4 disposable WAL archive and PITR lab. Never run on shared Docker.
set -euo pipefail
[[ "$OX_R40_EPHEMERAL" == "YES" && "$OX_R64_PITR_ACK" == "YES" ]] || {
  echo "R6.4 refuses to touch Docker without isolated lab acknowledgement" >&2; exit 4;
}
case "$OX_R64_POSTGRES_VERSION" in 15|16) ;; *)
  echo "Only disposable PostgreSQL 15/16 allowed" >&2; exit 4;; esac
for c in pg-r64-primary pg-r64-recovered; do
  if docker container inspect "$c" >/dev/null 2>&1; then
    echo "Refusing to replace existing container $c" >&2; exit 4;
  fi
done
for v in ox-r64-walarchive ox-r64-basebackup ox-r64-pitr-restore; do
  if docker volume inspect "$v" >/dev/null 2>&1; then
    echo "Refusing to reuse volume $v" >&2; exit 4;
  fi
done
if docker network inspect ox-r64-net >/dev/null 2>&1; then
  echo "Refusing existing network" >&2; exit 4;
fi
docker network create ox-r64-net >/dev/null
docker volume create ox-r64-walarchive >/dev/null
docker volume create ox-r64-basebackup >/dev/null
docker volume create ox-r64-pitr-restore >/dev/null
docker run --rm -v ox-r64-walarchive:/archive \
  --entrypoint bash "postgres:$OX_R64_POSTGRES_VERSION" -ec '
    chown postgres:postgres /archive
    chmod 0700 /archive
  '
docker run -d --name pg-r64-primary --network ox-r64-net \
  -v ox-r64-walarchive:/archive \
  -p 127.0.0.1:5561:5432 \
  -e POSTGRES_PASSWORD=r64-synthetic-pg \
  -e POSTGRES_DB=ox_r64 \
  "postgres:$OX_R64_POSTGRES_VERSION" \
  -c wal_level=replica -c max_wal_senders=6 \
  -c archive_mode=on \
  -c "archive_command=test ! -f /archive/%f && cp %p /archive/%f" \
  -c archive_timeout=5s -c synchronous_commit=on >/dev/null
ready=0
for i in $(seq 1 100); do
  if docker exec pg-r64-primary pg_isready -U postgres -d ox_r64 >/dev/null 2>&1; then
    ready=1;break
  fi
  sleep 0.2
done
[[ "$ready" == "1" ]] || { docker logs pg-r64-primary >&2;exit 4; }
docker exec pg-r64-primary psql -v ON_ERROR_STOP=1 -U postgres -d ox_r64 \
  -c "CREATE ROLE r64_repl WITH REPLICATION LOGIN PASSWORD 'r64-lab-repl-only';"
docker exec pg-r64-primary bash -ec '
  printf "\nhost replication r64_repl 0.0.0.0/0 scram-sha-256\n" >> "$PGDATA/pg_hba.conf"
  psql -v ON_ERROR_STOP=1 -U postgres -d ox_r64 -c "SELECT pg_reload_conf()"
'
docker exec pg-r64-primary psql -U postgres -d ox_r64 -tAc \
  "SHOW archive_mode" | grep -qx on
echo "R6.4 isolated physical archive_mode=on ready"
