#!/bin/sh
# The image's one entry point. ROLE picks what this container runs:
#   migrate  the release step: migrations, pg-boss schema, built-in seed (and demo data where needed); then exits
#   web      the web app on PORT (default 3000)
#   worker   the background worker (email, alerts and the scheduled jobs, for live and training)
#   setup-email  first run only: saves the SMTP server from SETUP_* so the first admin can sign in (refused once one is saved, unless --replace); then exits
#   rotate-file-key  moves encrypted files from FILE_MASTER_KEY_OLD to FILE_MASTER_KEY (docs/operations.md); then exits
set -e
case "${ROLE:-web}" in
  migrate) exec node_modules/.bin/tsx src/db/release.ts ;;
  web) exec node_modules/.bin/tsx src/server.ts ;;
  worker) exec node_modules/.bin/tsx src/jobs/worker.ts ;;
  setup-email) exec node_modules/.bin/tsx src/db/setup-email.ts "$@" ;;
  rotate-file-key) exec node_modules/.bin/tsx src/db/rotate-file-key.ts ;;
  *)
    echo "ROLE must be migrate, web, worker, setup-email or rotate-file-key (got \"${ROLE}\")." >&2
    exit 64
    ;;
esac
