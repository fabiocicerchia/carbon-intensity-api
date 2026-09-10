#!/bin/sh
# Build the snapshot and push it to the bucket. Run it by hand (or from cron if
# you want it hourly) — nothing runs at request time.
#
# Requires node >= 20 and awscli. Env: S3_BUCKET, S3_ENDPOINT, plus the usual
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. CDN_PURGE_CMD is optional, and
# OUT_DIR moves the build somewhere other than ./data.
set -eu

: "${S3_BUCKET:?set S3_BUCKET}"
: "${S3_ENDPOINT:?set S3_ENDPOINT}"

# Paths are resolved from this script rather than from the working directory:
# the deployment repo runs this from a submodule checkout, where the build has
# to land in that repo's data/ while the pipeline is read from here.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT_DIR="${OUT_DIR:-data}"

node "$SCRIPT_DIR/bin/pipeline.js" --out "$OUT_DIR"

# Three passes, because a closed history day, everything else, and the site
# pages want different cache lifetimes and content types, and `aws s3 sync`
# takes one of each per invocation. Most keys carry no extension either, so the
# content type has to be set explicitly — otherwise aws infers from the name and
# browsers download instead of display.
TODAY=$(date -u +%F)

# The hand-written pages the pipeline copies in from site/. Excluded from both
# JSON passes below and uploaded last with their own types — labelling the
# landing page application/json makes the browser download it instead of
# rendering it. Excluding them also protects them from --delete.
SITE="--exclude index.html --exclude docs.html --exclude favicon.svg"

# Pass 1 — everything mutable: all of v1, and v2 apart from its closed days.
# s-maxage now matches the pipeline's own cadence, so the edge is at most one
# run behind and heals itself without a purge. Excluding the closed days here
# also protects them from --delete, which skips whatever the filters exclude.
# --delete still drops zones whose provider was down this run; the next request
# falls back to the country.
# --only-show-errors: a full sync narrates ~1600 lines of per-file progress
# every run, which buries the pipeline's own output — the provider health lines
# it prints before any of this starts. What was uploaded is already recorded in
# the commit, and whatever invokes this verifies the keys afterwards.
# shellcheck disable=SC2086 # $SITE is a list of flags, and is meant to split
aws s3 sync "$OUT_DIR" "s3://$S3_BUCKET" --endpoint-url "$S3_ENDPOINT" --delete \
  --exclude "*/history/*" --include "*/history/$TODAY" $SITE \
  --content-type application/json --only-show-errors \
  --cache-control "public, max-age=60, s-maxage=1200"

# Pass 2 — closed history days. Once a day is over the pipeline stops rewriting
# its file, so the object never changes again and can be cached indefinitely.
# --delete here is what carries retention through to the bucket: a day the
# pipeline pruned locally is removed from the bucket on the next sync.
# shellcheck disable=SC2086 # $SITE is a list of flags, and is meant to split
aws s3 sync "$OUT_DIR" "s3://$S3_BUCKET" --endpoint-url "$S3_ENDPOINT" --delete \
  --exclude "*" --include "*/history/*" --exclude "*/history/$TODAY" $SITE \
  --content-type application/json --only-show-errors \
  --cache-control "public, max-age=31536000, s-maxage=31536000, immutable"

# Pass 3 — the site. Three objects, unchanged between most runs, re-uploaded
# every time because that costs less than working out whether they moved.
SITE_CACHE="public, max-age=60, s-maxage=3600"
for page in index.html docs.html; do
  aws s3 cp "$OUT_DIR/$page" "s3://$S3_BUCKET/$page" \
    --endpoint-url "$S3_ENDPOINT" --only-show-errors \
    --content-type "text/html; charset=utf-8" --cache-control "$SITE_CACHE"
done
aws s3 cp "$OUT_DIR/favicon.svg" "s3://$S3_BUCKET/favicon.svg" \
  --endpoint-url "$S3_ENDPOINT" --only-show-errors \
  --content-type "image/svg+xml" --cache-control "$SITE_CACHE"

# Prove the objects are there: a sync that uploaded nothing must not pass as
# success, or the bucket keeps serving last hour behind a green run.
for key in v1/latest.json v1/countries v1/last-hour/IT \
  v2/countries.json v2/past-hour.json v2/IT/yearly index.html; do
  aws s3api head-object --bucket "$S3_BUCKET" --key "$key" \
    --endpoint-url "$S3_ENDPOINT" >/dev/null
done

# Optional, and no longer load-bearing: s-maxage matches the write cadence, so
# skipping the purge costs at most one cycle of edge staleness rather than an
# hour. Do NOT purge everything if you add one — that would evict the immutable
# closed days too and make their long TTL decorative.
if [ -n "${CDN_PURGE_CMD:-}" ]; then
  sh -c "$CDN_PURGE_CMD"
fi
