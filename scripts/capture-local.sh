#!/usr/bin/env bash
# Takes the manual screenshots locally: starts the e2e server as a staging site on the demo agency (its own database
# and port, clear of a preview on 3210), runs scripts/capture-screenshots.ts against it, then stops the server.
# Any arguments replace the capture command (for example a one-off script). E2E_REUSE_BUILD=1 skips the rebuild.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
. scripts/e2e-env.sh
export E2E_DEMO=staging
url="http://localhost:${E2E_PORT}"

node_modules/.bin/tsx tests/e2e/server.ts &
server=$!
stop() { kill -TERM "$server" 2>/dev/null || true; wait "$server" 2>/dev/null || true; }
trap stop EXIT
trap 'exit 130' INT TERM
for _ in $(seq 1 600); do
  if curl -fs -o /dev/null "$url/sign-in"; then break; fi
  kill -0 "$server" 2>/dev/null || { echo "the e2e server stopped; see test-results/e2e-server.log" >&2; exit 1; }
  sleep 1
done

export CAPTURE_BASE_URL="$url"
export CAPTURE_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${E2E_DB_PORT}/test"
export BETTER_AUTH_SECRET="e2e-only-better-auth-secret-0123456789abcdef"
if [ "$#" -gt 0 ]; then "$@"; else npx tsx scripts/capture-screenshots.ts; fi
