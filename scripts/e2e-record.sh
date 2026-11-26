#!/usr/bin/env bash
# Records the walkthrough and flow specs (video and trace on), one spec file at a time, into a dated run folder:
# .local-preview/e2e-runs/<YYYY-MM-DD-HHMM>/ (git-ignored). After each spec its videos, traces and blob report are in
# that folder and the HTML report (report/) is rebuilt from every blob so far, so a crash or freeze loses only the spec
# in progress. Open it with scripts/e2e-report.sh.
#
# Usage: scripts/e2e-record.sh [spec file ...]   (default: every tests/e2e/flows/*.spec.ts)
# SPEC_TIMEOUT (seconds, default 900) ends a spec that runs too long; what finished is kept.
# The first spec builds the app; the rest reuse that build.
set -uo pipefail
cd "$(dirname "$0")/.."
source scripts/e2e-env.sh

RUNS=.local-preview/e2e-runs
RUN="$RUNS/$(date +%Y-%m-%d-%H%M)"
[[ -e "$RUN" ]] && RUN="$RUN-$(date +%S)"
mkdir -p "$RUN/blobs" "$RUN/specs"
SPECS=("$@")
[[ ${#SPECS[@]} -eq 0 ]] && SPECS=(tests/e2e/flows/*.spec.ts)
{
  echo "Started: $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "Commit: $(git rev-parse --short HEAD 2>/dev/null)$(git diff --quiet 2>/dev/null || echo ' (with uncommitted changes)')"
} > "$RUN/summary.txt"
echo "Recording into $RUN"

# A spec stopped hard can leave the e2e app or its database running; free their ports before the next spec.
free_ports() {
  for port in "$E2E_PORT" "$E2E_DB_PORT" "$((E2E_PORT + 2))" "$((E2E_PORT + 3))"; do
    for pid in $(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do kill "$pid" 2>/dev/null; done
  done
}

# Rebuilds report/ from every spec's blob so far (merged from a copy: merge-reports unpacks into the folder it reads).
merge() {
  ls "$RUN"/blobs/*.zip >/dev/null 2>&1 || return 0
  local tmp
  tmp=$(mktemp -d)
  cp "$RUN"/blobs/*.zip "$tmp"/
  PLAYWRIGHT_HTML_OUTPUT_DIR="$RUN/report.new" PLAYWRIGHT_HTML_OPEN=never node_modules/.bin/playwright merge-reports --reporter html "$tmp" > "$RUN/merge.log" 2>&1 &&
    rm -rf "$RUN/report" && mv "$RUN/report.new" "$RUN/report" || echo "merge-reports failed; see $RUN/merge.log"
  rm -rf "$tmp"
}

# A run that was killed outright can leave its app, database and mail catcher behind.
free_ports
first=1
for spec in "${SPECS[@]}"; do
  name=$(basename "$spec" .spec.ts)
  if [[ "$first" = 1 ]]; then unset E2E_REUSE_BUILD; else export E2E_REUSE_BUILD=1; fi
  first=0
  echo "== $name"
  # SIGINT first, so Playwright stops the test, closes its browsers (saving the video) and writes the blob report.
  PLAYWRIGHT_BLOB_OUTPUT_FILE="$RUN/blobs/$name.zip" timeout --signal=INT --kill-after=60 "${SPEC_TIMEOUT:-900}" \
    node_modules/.bin/playwright test "$spec" --project flows --output "$RUN/specs/$name" --reporter=line,blob > "$RUN/specs/$name.log" 2>&1
  code=$?
  result=$(grep -E '^\s+[0-9]+ (passed|failed|flaky|interrupted|did not run)' "$RUN/specs/$name.log" | tr -s ' ' | tr '\n' ' ')
  [[ "$code" = 124 ]] && result="stopped after ${SPEC_TIMEOUT:-900} s; $result"
  echo "$name: ${result:-exit $code}" | tee -a "$RUN/summary.txt"
  free_ports
  merge
done
echo "Finished: $(date '+%Y-%m-%d %H:%M:%S %Z')" >> "$RUN/summary.txt"

# Keep runs from the last 30 days, at most the newest 10, and under 3 GB in all (oldest go first; this run stays).
find "$RUNS" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
ls -1d "$RUNS"/*/ 2>/dev/null | sort -r | tail -n +11 | xargs -r rm -rf
MAX_KB=$((3 * 1024 * 1024))
while [[ "$(du -sk "$RUNS" | cut -f1)" -gt "$MAX_KB" ]]; do
  oldest=$(ls -1d "$RUNS"/*/ | sort | head -n 1)
  [[ "${oldest%/}" = "$RUN" ]] && break
  rm -rf "$oldest"
done
echo "Report: scripts/e2e-report.sh $(basename "$RUN")"
