#!/usr/bin/env bash
# R6.5 two separate MinIO processes, different ephemeral data volumes and
# different loopback S3 endpoints. These are NOT two geographic regions.
set -euo pipefail
if [[ "$OX_R40_EPHEMERAL" != YES || "$OX_R65_LAB_ACK" != YES ||
      -z "$RUNNER_TEMP" ]]; then
  echo "Refusing non-ephemeral S3 custody laboratory" >&2; exit 4
fi
for name in r65-minio-a r65-minio-b; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo "Refusing to reuse $name" >&2; exit 4
  fi
done
for suffix in a b; do
  if [[ -e "$RUNNER_TEMP/r65-minio-$suffix" ]]; then
    echo "Refusing existing WORM data directory" >&2; exit 4
  fi
  mkdir -m 0700 "$RUNNER_TEMP/r65-minio-$suffix"
done
IMAGE="ghcr.io/intikhab49/minio-from-source@sha256:1025a6dd8452e6fe8d3fdf16dbce7c18f8417acd22e5abd7376d8322aee5edab"
docker run -d --name r65-minio-a \
  -p 127.0.0.1:9000:9000 \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -e MINIO_ROOT_USER="$OX_R65_MINIO_A_KEY" \
  -e MINIO_ROOT_PASSWORD="$OX_R65_MINIO_A_SECRET" \
  -v "$RUNNER_TEMP/r65-minio-a:/data:rw" "$IMAGE" >/dev/null
docker run -d --name r65-minio-b \
  -p 127.0.0.1:9001:9000 \
  --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  -e MINIO_ROOT_USER="$OX_R65_MINIO_B_KEY" \
  -e MINIO_ROOT_PASSWORD="$OX_R65_MINIO_B_SECRET" \
  -v "$RUNNER_TEMP/r65-minio-b:/data:rw" "$IMAGE" >/dev/null
for port in 9000 9001; do
  ready=0
  for attempt in $(seq 1 80); do
    if curl --silent --fail "http://127.0.0.1:$port/minio/health/live" >/dev/null; then
      ready=1;break
    fi
    sleep 1
  done
  if [[ "$ready" != 1 ]]; then
    echo "MinIO $port failed health check" >&2; exit 4
  fi
done
export AWS_DEFAULT_REGION=us-east-1 AWS_EC2_METADATA_DISABLED=true AWS_PAGER=""
export AWS_ACCESS_KEY_ID="$OX_R65_MINIO_A_KEY" AWS_SECRET_ACCESS_KEY="$OX_R65_MINIO_A_SECRET"
aws --endpoint-url "$OX_R65_MINIO_A_ENDPOINT" s3api create-bucket \
  --bucket "$OX_R65_MINIO_A_BUCKET" --object-lock-enabled-for-bucket
aws --endpoint-url "$OX_R65_MINIO_A_ENDPOINT" s3api put-object-lock-configuration \
  --bucket "$OX_R65_MINIO_A_BUCKET" \
  --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":7}}}'
test "$(aws --endpoint-url "$OX_R65_MINIO_A_ENDPOINT" s3api get-bucket-versioning \
  --bucket "$OX_R65_MINIO_A_BUCKET" --query Status --output text)" = Enabled
export AWS_ACCESS_KEY_ID="$OX_R65_MINIO_B_KEY" AWS_SECRET_ACCESS_KEY="$OX_R65_MINIO_B_SECRET"
aws --endpoint-url "$OX_R65_MINIO_B_ENDPOINT" s3api create-bucket \
  --bucket "$OX_R65_MINIO_B_BUCKET" --object-lock-enabled-for-bucket
aws --endpoint-url "$OX_R65_MINIO_B_ENDPOINT" s3api put-object-lock-configuration \
  --bucket "$OX_R65_MINIO_B_BUCKET" \
  --object-lock-configuration '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":7}}}'
test "$(aws --endpoint-url "$OX_R65_MINIO_B_ENDPOINT" s3api get-bucket-versioning \
  --bucket "$OX_R65_MINIO_B_BUCKET" --query Status --output text)" = Enabled
echo "R6.5 two independent local-only WORM MinIO processes ready"
