#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.16+ required: https://nodejs.org/en/download"
  exit 1
fi
echo "Open http://127.0.0.1:4173 in your browser"
exec node server.mjs
