#!/usr/bin/env bash
# Playwright UI mode, reachable from another machine on the LAN: open http://<this host>:3211 in a browser to pick
# tests, run them and watch each step. Extra arguments go to Playwright (for example a spec file or --project flows).
# Stop it with Ctrl+C.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/e2e-env.sh
exec npx playwright test --ui --ui-host=0.0.0.0 --ui-port=3211 "$@"
