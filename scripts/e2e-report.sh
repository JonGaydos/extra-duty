#!/usr/bin/env bash
# Serves a recorded run's HTML report (from scripts/e2e-record.sh) on port 3211 for any machine on the LAN:
# open http://<this host>:3211. Each flow's video and trace open from its test page. Stop it with Ctrl+C.
#
# Usage: scripts/e2e-report.sh [run]   the newest run by default, or a folder name from the list it prints.
# With no recorded runs it serves the last plain Playwright run (playwright-report/).
set -euo pipefail
cd "$(dirname "$0")/.."
RUNS=.local-preview/e2e-runs
runs=$(ls -1 "$RUNS" 2>/dev/null | sort -r || true)
if [[ -n "$runs" ]]; then
  echo "Recorded runs, newest first:"
  for r in $runs; do echo "  $r  $(grep -cE '^[a-z0-9-]+: .*passed' "$RUNS/$r/summary.txt" 2>/dev/null || true) passed, $(grep -cE '^[a-z0-9-]+: .*(failed|stopped)' "$RUNS/$r/summary.txt" 2>/dev/null || true) failed or stopped"; done
fi
run="${1:-$(echo "$runs" | head -n 1)}"
if [[ -n "$run" ]]; then
  dir="$RUNS/$run/report"
  [[ -f "$dir/index.html" ]] || { echo "No report in $RUNS/$run" >&2; exit 1; }
else
  dir=playwright-report
fi
echo "Serving $dir on http://0.0.0.0:3211"
pw="$PWD/node_modules/.bin/playwright"
[[ -x "$pw" ]] || { echo "playwright is not installed; run npm install first." >&2; exit 1; }
exec "$pw" show-report "$dir" --host 0.0.0.0 --port 3211
