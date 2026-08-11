#!/bin/sh
# Build the snapshot and push it to the bucket. Run it by hand (or from cron if
# you want it hourly) — nothing runs at request time.
#
# Requires node >= 20 and awscli. Env: S3_BUCKET, S3_ENDPOINT, plus the usual
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. CDN_PURGE_CMD is optional.
set -eu

: "${S3_BUCKET:?set S3_BUCKET}"
: "${S3_ENDPOINT:?set S3_ENDPOINT}"

node bin/pipeline.js --out data

# Keys carry no extension, so the content type has to be set explicitly —
# otherwise aws infers from the name and browsers download instead of display.
# --delete drops zones whose provider was down this run; the next request
# falls back to the country.
aws s3 sync data "s3://$S3_BUCKET" --endpoint-url "$S3_ENDPOINT" --delete \
  --content-type application/json \
  --cache-control "public, max-age=60, s-maxage=3600"

# The hour of s-maxage is only safe because the purge follows every sync.
if [ -n "${CDN_PURGE_CMD:-}" ]; then
  sh -c "$CDN_PURGE_CMD"
fi
