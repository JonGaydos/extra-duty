#!/bin/sh
# The image's one entry point. ROLE picks what this container runs:
#   migrate  the release step: migrations, pg-boss schema, built-in seed (and demo data where needed); then exits
#   web      the web app on PORT (default 3000)
#   worker   the background worker (email, alerts and the scheduled jobs, for live and training)
#   setup-email  first run only: saves the SMTP server from SETUP_* so the first admin can sign in (refused once one is saved, unless --replace); then exits
#   rotate-file-key  moves encrypted files from FILE_MASTER_KEY_OLD to FILE_MASTER_KEY (docs/operations.md); then exits
set -e

# Disk storage (STORAGE_DRIVER=local): make the live and training folders, since a fresh volume or host folder starts
# empty, and check this user can write them. Under Docker Compose (FILES_MOUNT is the mounted folder) both must be
# inside it; anywhere else they would be lost when the container is recreated.
if [ "${STORAGE_DRIVER:-local}" = local ]; then
  live="${STORAGE_LOCAL_DIR:-./var/storage}"
  training="${TRAINING_STORAGE_LOCAL_DIR:-./var/training-storage}"
  if [ -n "${FILES_MOUNT:-}" ]; then
    for dir in "$live" "$training"; do
      case "$dir" in
        "$FILES_MOUNT"/?*) ;;
        *)
          echo "File storage folder \"$dir\" is outside $FILES_MOUNT, the mounted files folder. Remove STORAGE_LOCAL_DIR and TRAINING_STORAGE_LOCAL_DIR from app.env, or set them inside $FILES_MOUNT." >&2
          exit 78
          ;;
      esac
    done
  fi
  if ! mkdir -p "$live" "$training" || [ ! -w "$live" ] || [ ! -w "$training" ]; then
    echo "Cannot write the file storage folders ($live, $training) as user $(id -u):$(id -g). For a folder on the host, give it to that user: chown -R $(id -u):$(id -g) <the folder>." >&2
    exit 73
  fi
fi

case "${ROLE:-web}" in
  migrate) exec node_modules/.bin/tsx --tsconfig tsconfig.node.json src/db/release.ts ;;
  web) exec node_modules/.bin/tsx --tsconfig tsconfig.node.json src/server.ts ;;
  worker) exec node_modules/.bin/tsx --tsconfig tsconfig.node.json src/jobs/worker.ts ;;
  setup-email) exec node_modules/.bin/tsx --tsconfig tsconfig.node.json src/db/setup-email.ts "$@" ;;
  rotate-file-key) exec node_modules/.bin/tsx --tsconfig tsconfig.node.json src/db/rotate-file-key.ts ;;
  *)
    echo "ROLE must be migrate, web, worker, setup-email or rotate-file-key (got \"${ROLE}\")." >&2
    exit 64
    ;;
esac
