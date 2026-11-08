#!/usr/bin/env bash
# R5.9 throwaway PG physical-replica lab. Never run on a live Docker host.
set -euo pipefail
if [[ "$OX_R59_LAB_ACK" != "YES" || "$OX_R40_EPHEMERAL" != "YES" ]]; then
  echo "R5.9 requires disposable-lab acknowledgement" >&2; exit 4
fi
case "$OX_R59_POSTGRES_VERSION" in 15|16) ;; *) echo "PG version must be 15 or 16" >&2; exit 4;; esac
for name in pg-r59-primary pg-r59-standby; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo "Refusing to replace pre-existing Docker container $name" >&2; exit 4
  fi
done
if docker network inspect ox-r59-net >/dev/null 2>&1 ||
  docker volume inspect ox-r59-standby >/dev/null 2>&1; then
  echo "Refusing to reuse existing network or volume" >&2; exit 4
fi
docker network create ox-r59-net >/dev/null
docker volume create ox-r59-standby >/dev/null
docker run -d --name pg-r59-primary --network ox-r59-net \
  -e POSTGRES_PASSWORD=r59-disposable-pg \
  -e POSTGRES_DB=ox_r59 \
  -p 127.0.0.1:5543:5432 \
  "postgres:$OX_R59_POSTGRES_VERSION" \
  -c wal_level=replica -c max_wal_senders=10 \
  -c hot_standby=on -c max_replication_slots=10 >/dev/null
for attempt in $(seq 1 80); do
  if docker exec pg-r59-primary pg_isready -U postgres -d ox_r59 >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec pg-r59-primary pg_isready -U postgres -d ox_r59
docker exec pg-r59-primary psql -v ON_ERROR_STOP=1 -U postgres -d ox_r59 \
  -c "CREATE ROLE r59_repl WITH REPLICATION LOGIN PASSWORD 'r59-only-disposable-repl';"
docker run --rm --network ox-r59-net \
  --volume ox-r59-standby:/var/lib/postgresql/data \
  --entrypoint bash "postgres:$OX_R59_POSTGRES_VERSION" -ec '
    chown postgres:postgres /var/lib/postgresql/data
    chmod 0700 /var/lib/postgresql/data
    gosu postgres env PGPASSWORD=r59-only-disposable-repl pg_basebackup \
      -h pg-r59-primary -p 5432 -U r59_repl \
      -D /var/lib/postgresql/data -Fp -Xs -R --checkpoint=fast
    printf "\nprimary_conninfo = '\''host=pg-r59-primary port=5432 user=r59_repl password=r59-only-disposable-repl application_name=r59-standby'\''\n" \
      >> /var/lib/postgresql/data/postgresql.auto.conf
    chown postgres:postgres /var/lib/postgresql/data/postgresql.auto.conf
    chmod 0600 /var/lib/postgresql/data/postgresql.auto.conf
  '
docker run -d --name pg-r59-standby --network ox-r59-net \
  -v ox-r59-standby:/var/lib/postgresql/data \
  -p 127.0.0.1:5544:5432 "postgres:$OX_R59_POSTGRES_VERSION" >/dev/null
for attempt in $(seq 1 80); do
  if docker exec pg-r59-standby pg_isready -U postgres -d ox_r59 >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec pg-r59-standby pg_isready -U postgres -d ox_r59
docker exec pg-r59-standby psql -U postgres -d ox_r59 -tAc \
  "SELECT pg_is_in_recovery()" | grep -qx 't'
echo "R5.9 disposable physical PG replica is streaming"
