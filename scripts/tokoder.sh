#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
[ -f .env ] || { [ -f .env.example ] && echo "Brak .env - skopiuj z .env.example"; }
[ -d node_modules ] || npm install
npm run build >/dev/null
if command -v node >/dev/null 2>&1; then exec node dist/cli.js "$@"; else exec /mnt/c/Program\ Files/nodejs/node.exe dist/cli.js "$@"; fi
