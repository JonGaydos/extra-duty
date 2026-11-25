#!/bin/sh
# Runs once, when the PostgreSQL volume is first created. Creates the app's role (rows only, no schema changes)
# and the training database. The owner role (POSTGRES_USER) runs the migrations.
set -eu

: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is not set}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE extra_duty_app LOGIN PASSWORD :'app_password';
CREATE DATABASE extra_duty_training OWNER extra_duty_owner;
SQL

for db in "$POSTGRES_DB" extra_duty_training; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" --set db="$db" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"db" TO extra_duty_app;
GRANT USAGE ON SCHEMA public TO extra_duty_app;
-- Everything the owner creates later (tables, sequences, the pg-boss schema and its functions) is usable, not alterable.
ALTER DEFAULT PRIVILEGES FOR ROLE extra_duty_owner GRANT USAGE ON SCHEMAS TO extra_duty_app;
ALTER DEFAULT PRIVILEGES FOR ROLE extra_duty_owner GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO extra_duty_app;
ALTER DEFAULT PRIVILEGES FOR ROLE extra_duty_owner GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO extra_duty_app;
ALTER DEFAULT PRIVILEGES FOR ROLE extra_duty_owner GRANT EXECUTE ON FUNCTIONS TO extra_duty_app;
SQL
done
