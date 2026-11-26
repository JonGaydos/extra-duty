# Operations Guide

How Extra Duty is deployed, configured, backed up, updated and restored. The step-by-step install for one Linux
machine with Docker Compose is in [self-hosting.md](self-hosting.md).

## Two deployments from one image

Every release is one container image. The same image runs in two deployments, which differ only in their settings.

| Deployment | `APP_ENV` | Data | Email |
| ---------- | --------- | ---- | ----- |
| Production | `production` | Real users, vendors and money records, plus training mode | Sent |
| Staging | `staging` | Made-up demo data only | Never sent; kept in the Outbox |

**Production** is the live site. It carries **training mode** with it: coordinators and admins can switch to
training (top bar, "Switch to training") and practice as a deputy, coordinator, admin or vendor. Training has its
own database (`TRAINING_DATABASE_URL`) and its own file storage (`TRAINING_BUCKET`, or `TRAINING_STORAGE_LOCAL_DIR`
for local files), filled with made-up demo data. Nothing done in training reaches live data, and no email leaves
training: every message is kept in the Outbox (an "Outbox" item in the staff menu while in training). Every page and
every PDF in training shows "TRAINING". Each new sign-in starts in live. Training is reset to the starting demo
data every night at 2:00 AM agency time (a setting under Reminders and locks), and a coordinator can reset it at
any time from the Outbox page.

**Staging** is a separate copy used only to check a new version before production gets it. It runs on demo data
(loaded by the release step when its database is empty) and keeps email in its Outbox instead of sending it. The
one exception is sign-in email (codes, invitations, password reset links) to the addresses in
`STAGING_EMAIL_ALLOWLIST`, so testers can sign in; invoices and every other message never leave staging, even to
those addresses. Use separate databases, storage and secrets for staging.

## Release path

1. Build the image for the new version.
2. Deploy it to **staging**. The release step runs first (below).
3. Check it on staging: sign in, walk through the changed screens, look at the Outbox.
4. Deploy the same image to **production**.

### The release step

Each deploy runs the release step exactly once, before the web app and the worker start (`ROLE=migrate`; in
Docker Compose, the `migrate` service). For the live database, and the training database when it is configured, it:

- applies the database migrations;
- installs or upgrades the job queue (pg-boss) schema and its queues;
- runs the built-in seed, which only adds what is missing (ranks, position and detail types, payment methods,
  built-in reports; settings use their defaults until changed);
- loads the demo data where a database has none yet: always for training, and for the live database on staging.

It is the only step that needs to change the database schema. The web app and the worker connect with a database
role that can read and write rows but cannot create or alter tables.

### Container roles

The image's entry point picks what to run from `ROLE`:

| `ROLE` | Runs |
| ------ | ---- |
| `migrate` | The release step, then exits |
| `web` | The web app on `PORT` (default 3000) |
| `worker` | Email, alerts and the scheduled jobs, for live and training |
| `setup-email` | First run only: saves the SMTP server from `SETUP_*` so the first admin can sign in, then exits. Refused once a server is saved, unless run with `--replace` (audited; every admin is alerted in the app and by email). |
| `rotate-file-key` | Moves encrypted files to a new `FILE_MASTER_KEY`, then exits |

Run **one** web container. The API key rate limit (600 requests a minute per key) is kept in each web process, so
more web containers would multiply it. Run one worker.

### Health check

`GET /api/health` answers 200 with `{"status":"ok","appEnv":...,"database":"ok","queue":"ok","training":...}`
when the live database and the queue answer, and 503 when they do not. `training` is `ok`, `down` or `off`; a
training problem never fails the check. It never shows error details.

## Environment variables

The app's settings go in `app.env` (copy `app.env.example`; without Docker Compose, use `.env.local`). Docker
Compose's own secrets go in `.env` (copy `.env.example`). Never put real secrets in a file that is committed.

| Variable | Needed | What it is |
| -------- | ------ | ---------- |
| `APP_ENV` | Yes | `production` or `staging`. Anything else counts as production. |
| `DATABASE_URL` | Yes | The live PostgreSQL database. The release step uses the owner role; web and worker use the app role. |
| `TRAINING_DATABASE_URL` | For training | The training database. Empty turns training mode off. |
| `SECRETS_KEY` | Yes | Encrypts stored secrets (email passwords, API keys). Base64 of 32 random bytes. |
| `FILE_MASTER_KEY` | Yes | Encrypts W-9 files. Base64 of 32 random bytes, different from `SECRETS_KEY`. Keep a copy offline: without it W-9s cannot be read. |
| `BETTER_AUTH_SECRET` | Yes | Signs sign-in sessions. At least 32 random characters. Changing it signs everyone out. |
| `BETTER_AUTH_URL` | Yes | The public address people use, such as `https://extraduty.example.org`. Links in email use it. |
| `APP_URL` | No | Overrides the address used in alert email links. |
| `SEED_ADMIN_EMAIL` | First run | The release step creates this admin account if it does not exist. |
| `TRUSTED_PROXY` | Behind a proxy | Addresses or CIDR ranges of the reverse proxy. Only from these is `X-Forwarded-For` believed; sign-in throttling keys on the client address. Empty trusts no one and uses the connection's address. |
| `PORT`, `HOST` | No | Where the web app listens (default `3000`, `0.0.0.0`). |
| `STORAGE_DRIVER` | Yes in production | `s3` (MinIO, DigitalOcean Spaces, AWS) or `local`. Production refuses to start without it. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | For `s3` | The bucket for live files. `S3_ENDPOINT` is blank for AWS. |
| `TRAINING_BUCKET` | For training with `s3` | The training bucket. Never the live bucket. |
| `STORAGE_LOCAL_DIR`, `TRAINING_STORAGE_LOCAL_DIR` | For `local` | Folders for live and training files (default `./var/storage`, `./var/training-storage`). |
| `STAGING_EMAIL_ALLOWLIST` | On staging | Comma-separated addresses that receive sign-in codes, invitations and password reset links on staging. Everything else stays in the outbox. Ignored in production; training mode never sends anything. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | No | Web push. Without them push is skipped. |
| `DEMO_PASSWORD` | No | Local development only: the password of the local preview's demo accounts and the screenshot capture's practice deputy. Unset: random for each run, printed once. Never set it on a live site. |
| `NODE_OPTIONS` | No | The image sets `--max-old-space-size=768` (heap per process). Raise it with the container's memory. |

Docker Compose's `.env` holds `SITE_DOMAIN`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `MINIO_ROOT_USER`,
`MINIO_ROOT_PASSWORD` and `MINIO_APP_PASSWORD`. Compose builds the database and storage settings from them; web and
the worker receive only the app role's database URL and the app's storage account (`extra-duty-app`, limited to the
two app buckets), never the owner password or the storage administrator login (see self-hosting.md).

The email server (SMTP or a provider) is set inside the app by an admin (Management, System, Email), not here.

## Backups

Back up three things, every night, and keep copies off the machine:

1. **The live database**: `pg_dump --format=custom` of `DATABASE_URL`'s database.
2. **The live file storage**: every object in the live bucket (or `STORAGE_LOCAL_DIR`). W-9s in it are encrypted.
3. **The `.env` and `app.env` files** (or `.env.local`), kept separately and securely. It holds `FILE_MASTER_KEY` and `SECRETS_KEY`; a backup
   cannot be read without them.

The training database and bucket need no backup: the release step and the nightly reset rebuild them.

Test a restore at least twice a year on a spare machine.

## Restore

1. Stop the web app and the worker.
2. Restore the database dump into an empty database: `pg_restore --clean --if-exists --no-owner --role=<owner role>`
   (or create a fresh database and restore into it).
3. Copy the files back into the live bucket or folder, with the same names.
4. Put the `.env` and `app.env` from the same date in place. `FILE_MASTER_KEY` and `SECRETS_KEY` must be the ones the backup was
   made with.
5. Run the release step (it applies any newer migrations), then start the web app and the worker.
6. Sign in and open a W-9 to confirm files decrypt.

Docker Compose commands for each step are in self-hosting.md.

## Rotating FILE_MASTER_KEY

Rotate it when someone who had it leaves, or if it may have been exposed. Every W-9 has its own data key; rotation
re-wraps those keys with the new master key, so the files themselves are not re-encrypted.

1. Make a fresh backup (database, files and the settings files).
2. Make a new key: `openssl rand -base64 32`.
3. Stop the web app and the worker.
4. Run the image with `ROLE=rotate-file-key`, `FILE_MASTER_KEY_OLD` set to the old key and `FILE_MASTER_KEY` to the
   new one. It handles live and training, goes through the files in a fixed order, and prints how many moved, how
   many were already on the new key and which could not be read. Every file records which master key wraps it, so if
   the run stops part way, running it again skips the files already moved. On local storage a file is replaced in
   one step (written beside it, then renamed), so an interruption never leaves a truncated file. Files it cannot
   read are listed and skipped, and the run ends with an error; restore them from the backup and run it again.
5. Put the new key in `app.env` as `FILE_MASTER_KEY` and remove the old one from the machine. Keep the old key with the
   backups made before the rotation; they still need it.
6. Start the web app and the worker, and open a W-9 to confirm.

`SECRETS_KEY` has no rotation tool. Changing it makes the saved email password and provider key unreadable: an admin
then enters them again (Management, System, Email).

## Updates

1. Read the release notes.
2. Back up.
3. Build or pull the new image and deploy it to staging; check it.
4. Deploy the same image to production. The release step runs once, then web and the worker start on the new
   version.

Rolling back to an older image is safe only when the new version added no migrations; otherwise restore the backup
taken in step 2.
