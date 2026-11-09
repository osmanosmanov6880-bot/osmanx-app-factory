#!/usr/bin/env bash
# R6.4 disposable WAL-archiving PG15/16 primary for a REAL target-LSN PITR.
# Synthetic WAL files are readable by the non-root CI verifier for hashing;
# do not copy these CI-only permissions to a real customer backup system.
# NEVER run on production or any Docker host with shared customer data.
set -euo pipefail
if [[ "$OX_R40_EPHEMERAL" != "YES" || "$OX_R64_LAB_ACK" != "YES" ]]; then
  echo "Refusing non-disposable PITR lab" >&2; exit 4
fi
case "$OX_R64_POSTGRES_VERSION" in 15|16) ;; *) exit 4;; esac
if [[ -z "$RUNNER_TEMP" ]]; then echo "RUNNER_TEMP required" >&2; exit 4; fi
OX_R64_ARCHIVE_DIR="$RUNNER_TEMP/r64-archive"
export OX_R64_ARCHIVE_DIR
if [[ "$OX_R64_ARCHIVE_DIR" != "$RUNNER_TEMP/r64-archive" ]]; then
  echo "Archive must live in this runner's disposable private directory" >&2; exit 4
fi
if [[ -e "$OX_R64_ARCHIVE_DIR" ]]; then
  echo "Refusing to reuse archive directory" >&2; exit 4
fi
for name in pg-r64-primary pg-r64-restored; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo "Container exists: $name" >&2; exit 4
  fi
done
for name in ox-r64-backup ox-r64-restored; do
  if docker volume inspect "$name" >/dev/null 2>&1; then
    echo "Volume exists: $name" >&2; exit 4
  fi
done
if docker network inspect ox-r64-net >/dev/null 2>&1; then
  echo "Refusing to reuse network ox-r64-net" >&2; exit 4
fi
mkdir -p "$OX_R64_ARCHIVE_DIR"
chmod 0700 "$OX_R64_ARCHIVE_DIR"
docker network create ox-r64-net >/dev/null
docker volume create ox-r64-backup >/dev/null
docker run --rm -v "$OX_R64_ARCHIVE_DIR:/archive:rw" --entrypoint bash \
  "postgres:$OX_R64_POSTGRES_VERSION" -ec \
  'chown postgres:postgres /archive; chmod 0755 /archive'
docker run -d --name pg-r64-primary --network ox-r64-net \
  -e POSTGRES_PASSWORD=r64-disposable-only \
  -e POSTGRES_DB=ox_r64 \
  -v "$OX_R64_ARCHIVE_DIR:/archive:rw" \
  -p 127.0.0.1:5564:5432 "postgres:$OX_R64_POSTGRES_VERSION" \
  -c wal_level=replica \
  -c max_wal_senders=6 \
  -c archive_mode=on \
  -c "archive_command=test ! -e /archive/%f && cp %p /archive/%f && chmod 0644 /archive/%f" >/dev/null
ready=0
for attempt in $(seq 1 90); do
  if docker exec pg-r64-primary pg_isready -U postgres -d ox_r64 >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then echo "PITR primary failed to start" >&2; exit 4; fi
docker exec pg-r64-primary psql -v ON_ERROR_STOP=1 -U postgres -d ox_r64 \
  -c "CREATE ROLE r64_repl WITH REPLICATION LOGIN PASSWORD 'r64-only-repl';"
docker exec pg-r64-primary bash -ec '
  printf "\nhost replication r64_repl 0.0.0.0/0 scram-sha-256\n" >> "$PGDATA/pg_hba.conf"
  psql -v ON_ERROR_STOP=1 -U postgres -d ox_r64 -c "SELECT pg_reload_conf()"
'
docker exec pg-r64-primary psql -U postgres -d ox_r64 -tAc \
  "SHOW archive_mode" | grep -qx 'on'
docker exec pg-r64-primary psql -U postgres -d ox_r64 -tAc \
  "SHOW wal_segment_size" | grep -qx '16MB'
echo "R6.4 private WAL-archived PG$OX_R64_POSTGRES_VERSION primary is ready"
