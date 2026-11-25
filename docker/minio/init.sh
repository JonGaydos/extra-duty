#!/bin/sh
# Runs at every start, before migrate. Creates the live and training buckets if missing, and the app's own MinIO
# account (extra-duty-app) whose policy allows object reads and writes in those two buckets only. The web app, the
# worker and migrate use that account; only this step uses the MinIO root login.
set -eu
: "${MINIO_APP_PASSWORD:?MINIO_APP_PASSWORD is not set}"

mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing local/extra-duty local/extra-duty-training

policy=/tmp/extra-duty-app-policy.json
cat > "$policy" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::extra-duty", "arn:aws:s3:::extra-duty-training"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::extra-duty/*", "arn:aws:s3:::extra-duty-training/*"]
    }
  ]
}
JSON
mc admin policy create local extra-duty-app "$policy"
# Adding an existing user sets its secret again, so a changed MINIO_APP_PASSWORD takes effect.
mc admin user add local extra-duty-app "$MINIO_APP_PASSWORD"
# Attaching a policy that is already attached reports an error; the check below is what counts.
mc admin policy attach local extra-duty-app --user extra-duty-app >/dev/null 2>&1 || true
mc admin user info local extra-duty-app | grep -qi "policy.*extra-duty-app"
echo "buckets and the extra-duty-app account are ready"
