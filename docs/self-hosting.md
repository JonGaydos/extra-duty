# Self-Hosting Guide

Running Extra Duty on one Linux machine with Docker Compose. Written for county IT staff. Every setting is
explained in [operations.md](operations.md); this guide is the step-by-step version.

## What you get

One `docker compose up` starts these containers on one machine:

| Container | What it does |
| --------- | ------------ |
| `caddy` | The front door on ports 80 and 443. With a domain name it gets an HTTPS certificate automatically. |
| `web` | The Extra Duty web app. Exactly one. |
| `worker` | Sends email and alerts and runs the scheduled jobs (reminders, nightly training reset). |
| `postgres` | The database: a live database and a training database. |
| `minio` | File storage (W-9s, contracts, ops plans, logos): a live bucket and a training bucket. |
| `migrate`, `buckets` | Run once at each start (database updates; storage buckets and the app's storage account), then stop. |

Run one web container only. The limit on API key requests (600 a minute per key) is counted inside the web
container, so a second copy would double it.

The web and worker containers get only what they need: the app's settings (`app.env`), a database role that can read
and write rows but not change tables, and a storage account limited to the app's two buckets. The database owner
password and the storage administrator login stay in `.env`, which only Compose, the database, the storage and the
one-time `migrate` and `buckets` steps use.

## 1. Prepare the machine

- A Linux virtual machine (Ubuntu Server 24.04 LTS or Debian 12 work well) with at least 2 CPU cores, 4 GB of
  memory and 40 GB of disk. Give the disk room for growth: W-9s and contracts are stored here.
- Docker Engine with the Compose plugin. Follow Docker's own install page for your distribution, then check:

      docker --version
      docker compose version

- Git, to download the app: `sudo apt install git`.
- A fixed address on your network. For access from outside the building, a domain name (for example
  `extraduty.example.org`) pointing to this machine, with ports 80 and 443 reaching it from the internet so Caddy can
  get its certificate.
- An email account the app can send from (your county mail server or a provider), with its SMTP server name, port,
  user name and password. Sign-in codes are emailed, so nobody can sign in without it.

## 2. Download and configure

    sudo mkdir -p /opt/extra-duty && sudo chown "$USER" /opt/extra-duty
    git clone <the Extra Duty repository> /opt/extra-duty
    cd /opt/extra-duty
    cp .env.example .env
    cp app.env.example app.env
    chmod 600 .env app.env

There are two settings files. Make each secret with the command shown next to it in the file
(`openssl rand -hex 24` or `openssl rand -base64 32`), and never reuse one.

`.env` holds Docker Compose's own settings:

| Setting | What to put |
| ------- | ----------- |
| `SITE_DOMAIN` | Your domain name, for HTTPS. Leave it empty only for a site with no domain name (see below). |
| `POSTGRES_PASSWORD` | The database owner's password. Only the `migrate` step uses it. |
| `APP_DB_PASSWORD` | The password of the database role the app runs as. |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | The file storage administrator. Only the storage and the `buckets` step use it. |
| `MINIO_APP_PASSWORD` | The app's own storage account (`extra-duty-app`), limited to the app's two buckets. |

`app.env` holds the app's settings:

| Setting | What to put |
| ------- | ----------- |
| `BETTER_AUTH_URL` | The address people type: `https://your-domain` (or `http://the-machine-address` with no domain). |
| `SECRETS_KEY`, `FILE_MASTER_KEY`, `BETTER_AUTH_SECRET` | Three different random secrets. |
| `SEED_ADMIN_EMAIL` | The email address of the first administrator. |
| `APP_ENV` | `production` for the real site, `staging` for a test copy. |
| `STAGING_EMAIL_ALLOWLIST` | Staging only: the testers' addresses (see section 9). |

Leave the lines under "Without Docker Compose only" in `app.env` as they are; Compose sets those itself.

**HTTPS or plain HTTP.** With `SITE_DOMAIN` set, Caddy gets a certificate for the domain and every plain-HTTP request,
including one typed as the machine's IP address, is redirected to `https://` and the domain. Use this for every
real install. With `SITE_DOMAIN` empty, Caddy serves plain HTTP on port 80 and nothing else. That is only for a
machine with no domain name at all, on a closed local network: over plain HTTP, passwords and the emailed sign-in
codes cross the network unencrypted, and anyone on that network who can see the traffic can capture them and sign
in as that person.

**Copy both files somewhere safe, off this machine** (a password manager or a sealed envelope in a safe). Without
`FILE_MASTER_KEY` nobody can open the W-9s, even from a backup.

## 3. First start

    docker compose up -d --build

The first build takes several minutes. Then check:

    docker compose ps
    docker compose logs migrate

`migrate` should show "live database migrated and seeded" and "training database migrated and seeded" and have
exited with code 0. `web` should be "healthy" after a minute. Open the site in a browser; you should see the
sign-in page.

## 4. First sign-in

The first administrator account exists (from `SEED_ADMIN_EMAIL`) but has no password yet, and sign-in codes are
emailed. Save your email server once from the command line, then use "Forgot password":

    docker compose run --rm -e ROLE=setup-email \
      -e SETUP_EMAIL_FROM="Extra Duty <noreply@your-county.example>" \
      -e SETUP_SMTP_HOST=smtp.your-county.example \
      -e SETUP_SMTP_PORT=587 \
      -e SETUP_SMTP_USER=extraduty \
      -e SETUP_SMTP_PASSWORD='the-mail-password' \
      migrate

(Add `-e SETUP_SMTP_SECURE=true` for a server on port 465.) The password is stored encrypted. The command works
only while no email server is saved; after that, change the email server in the app. If you must replace it from
the command line (for example, nobody can sign in because the mail server changed), add `--replace` at the end. A
replacement is recorded in the audit log and every admin is told in the app and by email. Then:

1. On the sign-in page, choose "Forgot password" and enter the `SEED_ADMIN_EMAIL` address.
2. Open the emailed link, choose a password, and sign in. A 6-digit code arrives by email.
3. In the app, open Management, System, Email and send a test email.
4. Fill in the agency details, then invite coordinators and deputies (Management, Users).

## 5. Backups

Back up every night and keep copies off this machine. This script makes one dated folder with the database, the
files and copies of `.env` and `app.env`:

    #!/bin/sh
    set -eu
    cd /opt/extra-duty
    out=/var/backups/extra-duty/$(date +%Y-%m-%d)
    mkdir -p "$out"
    docker compose exec -T postgres pg_dump -U extra_duty_owner -d extra_duty --format=custom > "$out/extra_duty.dump"
    docker compose run --rm --entrypoint /bin/sh -v "$out:/backup" buckets -c \
      'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror --quiet local/extra-duty /backup/files'
    cp .env "$out/env"
    cp app.env "$out/app.env"
    chmod -R go-rwx "$out"

Save it as `/opt/extra-duty/backup.sh`, make it executable (`chmod 700`), and run it nightly from root's crontab
(`sudo crontab -e`, then `30 1 * * * /opt/extra-duty/backup.sh`). Copy `/var/backups/extra-duty` to another
machine or offsite storage, and delete old folders on a schedule your records policy allows.

The training database and bucket are not backed up; they are rebuilt automatically.

## 6. Updates

    cd /opt/extra-duty
    ./backup.sh
    git pull
    docker compose up -d --build

The `migrate` container runs once with the new version (database updates), then `web` and `worker` restart on it.
Check `docker compose logs migrate` and the site. If you run a staging copy, update it first and check it there
(see operations.md, "Release path").

## 7. Restore

To bring the site back from a backup folder (for example after a disk failure, on a new machine set up through step 2):

    cd /opt/extra-duty
    cp /var/backups/extra-duty/2026-11-24/env .env          # the .env and app.env from the same night
    cp /var/backups/extra-duty/2026-11-24/app.env app.env
    docker compose up -d postgres minio buckets
    docker compose stop web worker
    docker compose exec -T postgres pg_restore -U extra_duty_owner -d extra_duty --clean --if-exists --no-owner \
      < /var/backups/extra-duty/2026-11-24/extra_duty.dump
    docker compose run --rm --entrypoint /bin/sh -v /var/backups/extra-duty/2026-11-24:/backup buckets -c \
      'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mirror --quiet --overwrite /backup/files local/extra-duty'
    docker compose up -d

Then sign in and open a W-9 to confirm the files decrypt. If they do not, `app.env` is not the one from the backup's
date.

## 8. Rotating the W-9 encryption key

When someone who knew `FILE_MASTER_KEY` leaves, or if it may have leaked:

    ./backup.sh
    docker compose stop web worker
    docker compose run --rm -e ROLE=rotate-file-key \
      -e FILE_MASTER_KEY_OLD='the current key' -e FILE_MASTER_KEY='the new key' migrate

Make the new key first with `openssl rand -base64 32`. The command goes through the files one by one, in the same
order every time, and prints how many moved, how many were already on the new key, and any it could not read. If it
stops part way (power loss, a closed terminal), run it again: files already on the new key are recognized and
skipped, and a file is never left half written. If it lists files it could not read, it ends with an error: restore
those files from the backup and run it again. When it finishes with no errors, put the new key in `app.env` as
`FILE_MASTER_KEY`, store it safely, and start again with `docker compose up -d`. Keep the old key with older
backups: they still need it.

## 9. A staging copy

A staging copy checks new versions on made-up data before the real site gets them. Run it on a second machine set
up the same way, with `APP_ENV=staging`, its own secrets and its own address. It loads demo data by itself and keeps
email in its Outbox instead of sending it, with one exception: sign-in codes, invitations and password reset links
go out to the addresses in `STAGING_EMAIL_ALLOWLIST` (comma-separated, in `app.env`), so testers can sign in. Put the
testers' own addresses there, including `SEED_ADMIN_EMAIL`. Invoices and every other email never leave staging, even
to an address on the list.

## Troubleshooting

| Problem | Check |
| ------- | ----- |
| The site does not load | `docker compose ps`; `docker compose logs caddy web`. |
| `web` never becomes healthy | `docker compose logs migrate web`. `migrate` must have exited with code 0. |
| No HTTPS certificate | DNS for `SITE_DOMAIN` must point here, and ports 80 and 443 must reach this machine. `docker compose logs caddy`. |
| No email arrives | Management, System, Email: send a test. Then `docker compose logs worker`. |
| "Too many attempts" for everyone | The edge network range in `docker-compose.yml` must match `TRUSTED_PROXY`. |
| Health | `curl http://localhost/api/health` (or your domain): `"status":"ok"`. |

## First real build on a Docker host: checklist

Extra Duty's container image was written without a Docker host to build it on. Its entry points were checked by
running the same commands directly, but the first real build needs these checks once:

1. `docker compose config` prints the merged file with no errors (it checks `.env` and `app.env` too).
2. `docker compose build` succeeds. It must not download a font: if the build log mentions Google Fonts, stop.
3. `docker compose up -d`: `buckets` and `migrate` exit with code 0; `web` turns healthy; `worker` stays up and its
   log says "worker started (live and training)".
4. The image tags pinned in `docker-compose.yml` (`postgres`, `minio`, `mc`, `caddy`) pull. If one is no longer
   published, choose its current tag and note it here.
5. `docker compose exec postgres psql -U extra_duty_app -d extra_duty -c 'create table t (i int)'` fails with
   "permission denied" (the app's role cannot change the schema).
6. The app containers hold no owner or administrator secret: `docker compose exec web env | grep -c -e POSTGRES_PASSWORD -e MINIO_ROOT`
   and the same for `worker` print 0. `docker compose logs buckets` ends with "buckets and the extra-duty-app account
   are ready", and uploading a W-9 in the app works (the app's storage account can write).
7. With `SITE_DOMAIN` set, `curl -I http://<machine IP>/` answers 301 with `Location: https://<domain>/`, and
   `curl -I https://<domain>/` carries `Strict-Transport-Security`. With it empty, the site answers on plain HTTP
   with no `Strict-Transport-Security` header.
8. `curl -H 'X-Forwarded-For: 203.0.113.9' http://localhost/api/health` works, and the sign-in throttle keys on your
   real address, not the forged one: five wrong passwords for one account from your browser lock that account for
   your address only.
9. Steps 4 (first sign-in), 5 (backup) and 7 (restore, on a spare machine) of this guide work end to end. Running
   `setup-email` a second time is refused.
10. Switch to training as a coordinator, practice as a deputy, and confirm the TRAINING banner, the Outbox, and that
   the nightly reset runs (the worker log has no "failed" lines after 2:00 AM).
11. `docker compose stop web` then `docker compose start web`: the site comes back without running `migrate` again
   by hand.
