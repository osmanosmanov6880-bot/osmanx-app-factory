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
# Avoid removed Docker Hub/Quay container registries. Use a pinned, standalone
# MinIO Client release binary and verify its published SHA-256 before executing.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp"
release="RELEASE.2025-08-13T08-35-41Z"
binary="mc.linux-amd64.$release"
base="https://github.com/minio/mc/releases/download/$release"
# Official MinIO archive endpoint currently returns HTTP 410. Use exact
# release assets from GitHub instead. Fail closed if either asset is missing.
curl -fLSs --retry 3 --retry-delay 2 "$base/$binary" -o "$tmp/$binary"
curl -fLSs --retry 3 --retry-delay 2 "$base/$binary.sha256sum" \
  -o "$tmp/$binary.sha256sum"
printf '%s\n' "$(cat "$tmp/$binary.sha256sum")"
(cd "$tmp" && sha256sum -c "$binary.sha256sum")
chmod 0500 "$tmp/$binary"
MC="$tmp/$binary"
"$MC" alias set r59 http://127.0.0.1:9000 "$OX_R59_MINIO_ROOT" "$OX_R59_MINIO_SECRET"
"$MC" admin user add r59 "$OX_R58_WORKER_ACCESS_KEY" "$OX_R58_WORKER_SECRET_KEY"
"$MC" admin user add r59 "$OX_R58_COORDINATOR_ACCESS_KEY" "$OX_R58_COORDINATOR_SECRET_KEY"
"$MC" admin policy create r59 r59-worker "$PWD/artifacts/r59-iam/publisher.json"
"$MC" admin policy create r59 r59-coordinator "$PWD/artifacts/r59-iam/coordinator.json"
"$MC" admin policy attach r59 r59-worker --user "$OX_R58_WORKER_ACCESS_KEY"
"$MC" admin policy attach r59 r59-coordinator --user "$OX_R58_COORDINATOR_ACCESS_KEY"
"$MC" admin user info r59 "$OX_R58_WORKER_ACCESS_KEY"
"$MC" admin user info r59 "$OX_R58_COORDINATOR_ACCESS_KEY"
echo "R5.9 isolated MinIO IAM users and policies applied"
