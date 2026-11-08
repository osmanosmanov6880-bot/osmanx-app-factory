#!/usr/bin/env bash
# Real, disposable MinIO IAM role provisioning via mc. Do NOT run on a live host.
set -euo pipefail
if [[ "$OX_R59_LAB_ACK" != "YES" || "$OX_R40_EPHEMERAL" != "YES" ||
  "$OX_R59_IAM_TENANT" != "cccccccccccccccccccccccc" ||
  "$OX_R59_IAM_BUCKET" != "r59-failover-worm" ]]; then
  echo "Refusing real IAM writes outside the fixed disposable lab" >&2; exit 4
fi
if [[ "$OX_R58_WORKER_ACCESS_KEY" == "$OX_R58_COORDINATOR_ACCESS_KEY" ]]; then
  echo "IAM worker and coordinator must have distinct identities" >&2; exit 4
fi
node scripts/r59_write_iam_policies.mjs
# The isolated MinIO instance was created in this CI job, not a shared service.
# The container's startup shell initializes aliases, users and role policies.
docker run --rm --network host \
  -v "$PWD/artifacts/r59-iam:/lab:ro" \
  -e R59_ROOT="$OX_R59_MINIO_ROOT" \
  -e R59_ROOT_SECRET="$OX_R59_MINIO_SECRET" \
  -e R59_WORKER="$OX_R58_WORKER_ACCESS_KEY" \
  -e R59_WORKER_SECRET="$OX_R58_WORKER_SECRET_KEY" \
  -e R59_COORD="$OX_R58_COORDINATOR_ACCESS_KEY" \
  -e R59_COORD_SECRET="$OX_R58_COORDINATOR_SECRET_KEY" \
  --entrypoint /bin/sh quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z -ec '
    mc alias set r59 http://127.0.0.1:9000 "$R59_ROOT" "$R59_ROOT_SECRET"
    mc admin user add r59 "$R59_WORKER" "$R59_WORKER_SECRET"
    mc admin user add r59 "$R59_COORD" "$R59_COORD_SECRET"
    mc admin policy create r59 r59-worker /lab/publisher.json
    mc admin policy create r59 r59-coordinator /lab/coordinator.json
    mc admin policy attach r59 r59-worker --user "$R59_WORKER"
    mc admin policy attach r59 r59-coordinator --user "$R59_COORD"
    mc admin user info r59 "$R59_WORKER"
    mc admin user info r59 "$R59_COORD"
  '
echo "R5.9 isolated MinIO IAM users and policies applied"
