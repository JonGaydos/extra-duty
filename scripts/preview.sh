#!/usr/bin/env bash
# Long-running local preview: embedded Postgres (54400) + production Next build on 0.0.0.0:3210.
# Usage: scripts/preview.sh start|stop|restart|status
# State lives in .local-preview/ (gitignored). Secrets are generated once and never printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
P="$ROOT/.local-preview"
PG_BIN="$ROOT/node_modules/@embedded-postgres/linux-x64/native/bin"
PG_DATA="$P/pgdata"
PG_PORT=54400
APP_PORT=3210
PUBLIC_URL="${PREVIEW_URL:-http://localhost:$APP_PORT}"
ENV_FILE="$P/env"
APP_PID="$P/app.pid"

cd "$ROOT"
mkdir -p "$P/logs" "$P/storage"
chmod 700 "$P"

pg_running() { "$PG_BIN/pg_ctl" status -D "$PG_DATA" >/dev/null 2>&1; }
app_running() { [ -f "$APP_PID" ] && kill -0 "$(cat "$APP_PID")" 2>/dev/null; }

make_env() {
  [ -f "$ENV_FILE" ] && return 0
  umask 077
  cat > "$ENV_FILE" <<EOT
DATABASE_URL=postgres://postgres:$(openssl rand -hex 16)@127.0.0.1:$PG_PORT/extra_duty
BETTER_AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
BETTER_AUTH_URL=$PUBLIC_URL
SECRETS_KEY=$(openssl rand -base64 32)
FILE_MASTER_KEY=$(openssl rand -base64 32)
APP_ENV=staging
STORAGE_DRIVER=local
STORAGE_LOCAL_DIR=$P/storage
SEED_ADMIN_EMAIL=admin@preview.test
EOT
}

load_env() { set -a; . "$ENV_FILE"; set +a; }

db_password() { sed -n 's#^DATABASE_URL=postgres://postgres:\([^@]*\)@.*#\1#p' "$ENV_FILE"; }

start_pg() {
  if pg_running; then echo "postgres: running"; return; fi
  if [ ! -f "$PG_DATA/PG_VERSION" ]; then
    local pwf; pwf="$(mktemp)"; db_password > "$pwf"
    "$PG_BIN/initdb" -D "$PG_DATA" -U postgres --pwfile="$pwf" --auth=scram-sha-256 -E UTF8 --locale=C >"$P/logs/initdb.log" 2>&1
    rm -f "$pwf"
  fi
  "$PG_BIN/pg_ctl" start -D "$PG_DATA" -l "$P/logs/postgres.log" -w \
    -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=$P" >/dev/null
  echo "postgres: started on 127.0.0.1:$PG_PORT"
}

ensure_db() {
  PGPASSWORD="$(db_password)" node -e '
    const { Client } = require("pg");
    (async () => {
      const u = new URL(process.env.DATABASE_URL); const name = u.pathname.slice(1); u.pathname = "/postgres";
      const c = new Client({ connectionString: u.toString() }); await c.connect();
      const r = await c.query("select 1 from pg_database where datname=$1", [name]);
      if (!r.rowCount) await c.query(`create database "${name}"`);
      await c.end();
    })().catch((e) => { console.error(e.message); process.exit(1); });
  '
}

stop_app() {
  if app_running; then
    local pid; pid="$(cat "$APP_PID")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$pid" 2>/dev/null || true
    echo "app: stopped"
  fi
  rm -f "$APP_PID"
}

cmd_start() {
  make_env; load_env
  start_pg
  ensure_db
  npm run --silent db:migrate >"$P/logs/migrate.log" 2>&1 || { echo "migrate failed; see $P/logs/migrate.log"; exit 1; }
  npm run --silent db:seed >"$P/logs/seed.log" 2>&1 || { echo "seed failed; see $P/logs/seed.log"; exit 1; }
  npx tsx scripts/preview-demo.ts >"$P/logs/demo.log" 2>&1 || { echo "demo data failed; see $P/logs/demo.log"; exit 1; }
  echo "db: migrated, seeded, demo data present"
  if app_running; then echo "app: already running (use restart to rebuild)"; return; fi
  npx next build >"$P/logs/build.log" 2>&1 || { echo "build failed; see $P/logs/build.log"; exit 1; }
  nohup node_modules/.bin/next start -H 0.0.0.0 -p "$APP_PORT" >"$P/logs/app.log" 2>&1 &
  echo $! > "$APP_PID"
  for _ in $(seq 1 60); do
    if curl -fs -o /dev/null "http://127.0.0.1:$APP_PORT/sign-in"; then echo "app: up at $PUBLIC_URL"; return; fi
    sleep 1
  done
  echo "app: did not answer within 60s; see $P/logs/app.log"; exit 1
}

cmd_stop() {
  stop_app
  if pg_running; then "$PG_BIN/pg_ctl" stop -D "$PG_DATA" -m fast >/dev/null; echo "postgres: stopped"; fi
}

cmd_status() {
  if pg_running; then echo "postgres: running (port $PG_PORT)"; else echo "postgres: stopped"; fi
  if app_running; then
    local code; code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/sign-in" || true)"
    echo "app: running (pid $(cat "$APP_PID")), /sign-in returns $code, $PUBLIC_URL"
  else echo "app: stopped"; fi
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) stop_app; cmd_start ;;
  status) cmd_status ;;
  *) echo "usage: $0 start|stop|restart|status"; exit 2 ;;
esac
