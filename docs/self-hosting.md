# Self-Hosting Guide

Running Signal 90 on one Linux machine with Docker Compose. Written for county IT staff. Every setting is
explained in [operations.md](operations.md); this guide is the step-by-step version.

## What you get

One `docker compose up` starts these containers on one machine:

| Container | What it does |
| --------- | ------------ |
| `caddy` | The front door on ports 80 and 443. With a domain name it gets an HTTPS certificate automatically. |
| `web` | The Signal 90 web app. Exactly one. |
| `worker` | Sends email and alerts and runs the scheduled jobs (reminders, nightly training reset). |
| `postgres` | The database: a live database and a training database. |
| `migrate` | Runs once at each start (database updates), then stops. |

Uploaded files (W-9s, contracts, ops plans, logos) are kept on disk in one folder, the `files` volume, which `web`,
`worker` and `migrate` all mount at `/data`: live files in `/data/live`, training files in `/data/training`. The
worker needs it too, because it attaches W-9s and invoice PDFs to email. W-9s are encrypted by the app before they
are written. To keep the files in a folder of your choice on the machine instead of a Docker volume, set
`FILES_PATH` in `.env` (see below). A cloud install can use S3 storage instead ("S3 storage" in section 2).

Run one web container only. The limit on API key requests (600 a minute per key) is counted inside the web
container, so a second copy would double it.

The web and worker containers get only what they need: the app's settings (`app.env`), a database role that can read
and write rows but not change tables, and the files folder. The database owner password stays in `.env`, which only
Compose, the database and the one-time `migrate` step use.

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
    git clone <the Signal 90 repository> /opt/extra-duty
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
| `FILES_PATH` | Optional. A folder on the machine for the uploaded files (for example `/srv/extra-duty/files`). Unset: the Docker volume `files`. |

`app.env` holds the app's settings:

| Setting | What to put |
| ------- | ----------- |
| `BETTER_AUTH_URL` | The address people type: `https://your-domain` (or `http://the-machine-address` with no domain). |
| `SECRETS_KEY`, `FILE_MASTER_KEY`, `BETTER_AUTH_SECRET` | Three different random secrets. |
| `SEED_ADMIN_EMAIL` | The email address of the first administrator. |
| `APP_ENV` | `production` for the real site, `staging` for a test copy. |
| `STAGING_EMAIL_ALLOWLIST` | Staging only: the testers' addresses (see section 9). |

Leave the lines under "Without Docker Compose only" in `app.env` as they are; Compose sets those itself. Leave the
file storage lines commented out too, unless you use S3 storage.

**A folder on the machine for files.** With `FILES_PATH` set, Docker mounts that folder (a bind mount) instead of the
`files` volume. The app runs as user 1000, so create the folder and give it to that user before the first start:

    sudo mkdir -p /srv/extra-duty/files
    sudo chown -R 1000:1000 /srv/extra-duty/files

If the app cannot write it, `migrate` stops with "Cannot write the file storage folders" and the `chown` to run. A
new `files` volume needs nothing: it takes its owner from the image.

**S3 storage.** For a cloud install, files can go to an S3-compatible service (such as DigitalOcean Spaces or AWS)
instead of a folder. In `app.env`, uncomment and fill in `STORAGE_DRIVER=s3`, `S3_ENDPOINT`, `S3_REGION`,
`S3_BUCKET`, `TRAINING_BUCKET` (a second bucket, never the live one), `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY`. Compose reads its disk defaults from `docker/storage.env` first and `app.env` after it, so
the `app.env` settings win. Use an access key limited to those two buckets. The `files` volume then stays empty, and
backups copy the live bucket instead of the folder.

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
      -e SETUP_EMAIL_FROM="Signal 90 <noreply@your-county.example>" \
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
files folder and copies of `.env` and `app.env`:

    #!/bin/sh
    set -eu
    cd /opt/extra-duty
    out=/var/backups/extra-duty/$(date +%Y-%m-%d)
    mkdir -p "$out"
    docker compose exec -T postgres pg_dump -U extra_duty_owner -d extra_duty --format=custom > "$out/extra_duty.dump"
    docker compose run --rm --no-deps --user 0 --entrypoint tar -v "$out:/backup" migrate \
      -C /data -czf /backup/files.tar.gz live
    cp .env "$out/env"
    cp app.env "$out/app.env"
    chmod -R go-rwx "$out"

Save it as `/opt/extra-duty/backup.sh`, make it executable (`chmod 700`), and run it nightly from root's crontab
(`sudo crontab -e`, then `30 1 * * * /opt/extra-duty/backup.sh`). Copy `/var/backups/extra-duty` to another
machine or offsite storage, and delete old folders on a schedule your records policy allows.

The `tar` line packs the live files from the files folder, whether it is the `files` volume or a `FILES_PATH`
folder, and keeps each file's owner. With `FILES_PATH` you can instead pack that folder directly:
`tar -czf "$out/files.tar.gz" -C <FILES_PATH> live`. Each file is written whole (beside the old one, then renamed
over it), so a copy taken while the site runs never holds a half-written file; a W-9 uploaded during the copy is in
the next night's backup.

The training database and files are not backed up; they are rebuilt automatically.

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
    docker compose up -d postgres
    docker compose stop web worker
    docker compose exec -T postgres pg_restore -U extra_duty_owner -d extra_duty --clean --if-exists --no-owner \
      < /var/backups/extra-duty/2026-11-24/extra_duty.dump
    docker compose run --rm --no-deps --user 0 --entrypoint tar -v /var/backups/extra-duty/2026-11-24:/backup migrate \
      -C /data -xzf /backup/files.tar.gz
    docker compose up -d

The `tar` line puts the live files back into the files folder with their names and owner (the app's user, 1000).
With `FILES_PATH` you can unpack into that folder directly instead
(`tar -xzf files.tar.gz -C <FILES_PATH>`, then `chown -R 1000:1000 <FILES_PATH>`).

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

## Unraid

Signal 90 runs on an Unraid server with the same files. The differences:

1. **Compose.** Use the Docker Compose Manager plugin (Apps tab) or the terminal (`docker compose`, from the
   project folder). The steps below use the terminal; in the plugin, point the stack at the same folder.
2. **Folder.** Put the project in `/mnt/user/appdata/extra-duty`:

       git clone <the Signal 90 repository> /mnt/user/appdata/extra-duty
       cd /mnt/user/appdata/extra-duty
       cp .env.example .env
       cp app.env.example app.env
       chmod 600 .env app.env

3. **Files on a bind mount.** Keep the uploaded files under appdata. Create the folder, give it to the app's user
   (1000), and set it in `.env`:

       mkdir -p /mnt/user/appdata/extra-duty/files
       chown -R 1000:1000 /mnt/user/appdata/extra-duty/files

   In `.env`: `FILES_PATH=/mnt/user/appdata/extra-duty/files`.
4. **Caddy ports.** Unraid's own web interface uses ports 80 and 443, so publish Caddy on another port. Create
   `docker-compose.override.yml` next to `docker-compose.yml` (Compose reads it automatically):

       services:
         caddy:
           ports: !override
             - "8380:80"

   `!override` needs Docker Compose 2.24 or newer (`docker compose version`). On an older version, change the
   `ports` lines of the `caddy` service in `docker-compose.yml` itself instead (and again after each `git pull`).
5. **Address.** Leave `SITE_DOMAIN` empty (plain HTTP on the local network; see "HTTPS or plain HTTP" above) and set
   `BETTER_AUTH_URL=http://<server IP>:8380` in `app.env`, where `<server IP>` is the Unraid server's address.
   Automatic HTTPS with a domain needs ports 80 and 443 from the internet to reach Caddy, which this port change
   does not give.
6. **Start and back up.** `docker compose up -d --build`, then sections 3 and 4. In the backup and restore scripts,
   use `cd /mnt/user/appdata/extra-duty` and a backup folder on the array, such as
   `/mnt/user/backups/extra-duty`.

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

Signal 90's container image was written without a Docker host to build it on. Its entry points were checked by
running the same commands directly, but the first real build needs these checks once:

1. `docker compose config` prints the merged file with no errors (it checks `.env` and `app.env` too).
2. `docker compose build` succeeds. It must not download a font: if the build log mentions Google Fonts, stop.
3. `docker compose up -d`: `migrate` exits with code 0; `web` turns healthy; `worker` stays up and its log says
   "worker started (live and training)". `docker compose exec web ls -ld /data/live /data/training` shows both
   folders owned by `node`.
4. The image tags pinned in `docker-compose.yml` (`postgres`, `caddy`) pull. If one is no longer published, choose
   its current tag and note it here.
5. `docker compose exec postgres psql -U extra_duty_app -d extra_duty -c 'create table t (i int)'` fails with
   "permission denied" (the app's role cannot change the schema).
6. The app containers hold no owner secret: `docker compose exec web env | grep -c POSTGRES_PASSWORD` and the same
   for `worker` print 0. Uploading a W-9 in the app works, a file appears in both `docker compose exec web ls -R
   /data/live` and the same for `worker`, and an invoice email with the W-9 attached is sent (the worker reads the
   same folder).
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
12. With `FILES_PATH` set to a new empty folder not owned by user 1000, `migrate` stops with "Cannot write the file
   storage folders"; after the `chown`, it starts. The backup and restore `tar` lines (sections 5 and 7) work.
