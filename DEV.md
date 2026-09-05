# Development & Deployment

How to run, deploy, and operate carbon-intensity-api. See [`README.md`](./README.md)
for what the service is and its endpoints.

## Architecture recap — one source of truth

Compute happens **once**, in [`sync.sh`](./sync.sh), run by hand: it runs the
pipeline and syncs `data/` to an S3-compatible bucket. The bucket is **served
directly** on the custom domain — no application in the request path.

```
./sync.sh ─► data/ (commit it for audit/history)
          └► aws s3 sync ─► bucket ─► CDN ─► clients
```

Run it whenever you want the numbers refreshed — hourly from cron if you want
the published cadence to match the hourly claim in the docs.

Any S3-compatible object store with public reads and a custom domain works, put
behind a CDN. Nothing below depends on which one, beyond the wording of the
dashboard menus. `sync.sh` takes `S3_BUCKET`, `S3_ENDPOINT`, the usual AWS
credential variables, and an optional `CDN_PURGE_CMD`. Provider tokens
(`ENTSOE_TOKEN`, `EIA_TOKEN`) are read by the pipeline it calls.

## Local development

Requires Node ≥ 20. No dependencies, runtime or dev.

```bash
npm test                 # node:test — parsers, data layer, handler, pipeline
npm run pipeline:offline # build data/ from the annual snapshot (no network)
npm run pipeline         # also fetch live providers (uses tokens if set)
npm run serve            # Node server on :8000, serving data/
```

Quick check:

```bash
curl localhost:8000/v1/last-hour/DE
curl localhost:8000/v1/latest.json
```

## Key layout

Keys carry **no extension** so that `/v1/last-hour/DE` — the published URL —
matches an object exactly. The sync sets `--content-type application/json`
explicitly; without it aws infers from the name and serves
`application/octet-stream`, which browsers download instead of display.

```
v2/DE/yearly             annual average, every country
v2/DE/past-hour          last completed clock hour
v2/DE/current-hour       hour in progress
v2/DE/history/2026-08-27 one UTC day of hourly means
v2/IT/SICI/past-hour     a zone is just the next code down
v2/countries.json        catalogue + annual figures  (bulk -> keeps its extension)
v2/past-hour.json        measured countries, one document
v2/openapi.json          the generated contract

v1/last-hour/DE          country (ISO-2)
v1/last-hour/DEU         ISO-3 alias, identical content
v1/zones/IT/SICI         zone
v1/latest.json           combined snapshot   (extension kept, it is documented)
v1/last-hour/index.json  directory listing   (ditto)
v1/countries             country list
index.html, favicon.svg  the site
```

Zones sit under `v1/zones/` rather than `v1/last-hour/<CODE>/<ZONE>`. Object
keys are flat strings and would accept either, but the pipeline writes to a directory
before syncing and a filesystem cannot have `v1/last-hour/AU` be both the
country's file and the folder holding its zones.

`v1/countries` and the ISO-3 aliases are written as objects: a bucket cannot run
`resolveCode()`, so `DEU` has to exist as a key of its own.

**Two naming rules for v2, both load-bearing.** An UPPERCASE segment is a code
and a lowercase-hyphenated one is a resource, which is what lets
`v2/IT/SICI/past-hour` be parsed without a `zones/` marker — checked against all
80 live zone codes, every one uppercase alphanumeric. And a per-entity key
carries no extension while a bulk document ends `.json`, extending what v1
already did for `latest.json` and `index.json`.

v2 sidesteps the file-versus-directory trap entirely: nothing is ever both,
since `v2/IT` and `v2/IT/SICI` are only ever directories. It is also why a date
is a path segment (`history/2026-08-27`) — the bucket is served directly, so
`?start=&end=` has nothing to parse it.

A day's history file is **not rewritten once the day closes**. `writeHistory`
compares the document it would write against the stored one and skips an
identical result, so a provider returning a long window costs a comparison
rather than a churned object. Anything caching those objects can rely on it.

## What serving statically gives up

- **No computed staleness.** A static object cannot evaluate freshness when it
  is fetched; callers derive it from `generated_at` and `basis`, as the README
  describes.
- **No provider retry.** A zone missed by a run stays missing until the next
  one; nothing re-checks the provider on request.
- **The CDN's generic 404 page**, not `{"detail": "...", "zones": [...]}`.

## Provider tokens

Live readings need no token for GB, BR, AU, SG, ZA. ENTSO-E (~38 zones) needs
`ENTSOE_TOKEN` (free — transparency.entsoe.eu) and the US needs `EIA_TOKEN`
(free — eia.gov/opendata). Without a token those countries fall back to the
annual snapshot. Tokens are only read when you run the pipeline; nothing runs at
request time.

Mexico has no provider: CENACE publishes generation by technology only as a
monthly settled export (June's file appears in mid-July), and its real-time web
services carry prices, not the generation mix.

## Operational notes

- **Write cadence:** measured countries are rewritten every run. Annual-average
  countries are left alone unless their figures change or the stored copy is a
  week old — a yearly figure cannot change hour to hour, and rewriting all 176
  of them every run churned the repo and the bucket for three timestamps. They
  also carry `hour_start`/`hour_end` as `null`, since an annual average
  describes no particular hour.
- **Refreshing bundled annual data:** re-run the extraction from the OWID energy
  dataset into `src/datasets/countries.csv`, regenerate `countries.json`, and
  commit. Sources live in `src/datasets/sources.csv`.
- **Curated lifecycle/consumption deltas:** `src/datasets/curated-deltas.json` is
  hand-maintained, unlike the `.csv`/`.json` pairs beside it. A country absent
  from it falls back to the modelled uplift in `src/data.js`.
- **Attribution URL:** the `attribution` block in responses is defined in
  [`src/data.js`](./src/data.js) (`ATTRIBUTION`). Update it if the site URL or
  repository location changes.
- **Adding a provider:** add a pure `parse*` + `fetch*` in
  [`src/live.js`](./src/live.js), map its fuels in
  [`src/factors.js`](./src/factors.js), route it in `providerFor`, and add a
  fixture test. `measured_count` rises automatically.

## Edge caching

Objects are synced with `Cache-Control: public, max-age=60, s-maxage=3600`, and
`sync.sh` purges the CDN cache immediately afterwards (`CDN_PURGE_CMD`).

The two TTLs differ on purpose. A purge clears the CDN's cache but **cannot
reach a browser's**, so the shared cache takes the hour and browsers keep sixty
seconds — otherwise a client that fetched at :59 would hold last hour's numbers
until :59 the next hour, with no way for you to fix it.

An hour at the edge is only safe *because* the purge follows every sync. If you
drop the purge step, drop `s-maxage` to a few minutes with it.

Cache hits never reach the bucket, so they cost no read operation. Rate limiting
sits ahead of the cache, so it still counts requests that never touch the bucket.

## Rate limiting

A CDN/WAF **rate limiting rule** in front of the bucket. There is no application
code to put a limiter in, and the rule runs at the edge before the bucket is
read, so it also protects against requests that would miss and cost an origin
lookup.

Match on the version prefixes — `/v1/` and `/v2/` — rather than enumerating
routes. v2's paths are `/v2/<CODE>/<resource>`, so they share no resource prefix
to match on, and picking them out by shape needs a regex operator not every plan
offers.

Pick the threshold from how a cold client behaves, not from the steady state:
filling a history window on first boot takes several requests in quick
succession, and a limit of one per interval turns that into minutes of stalling.

Watch the provider's minimum counting period — some tie it to the plan, so a
longer window can mean an upgrade rather than a config change. And check what a
blocked request actually returns: it is usually the provider's own page, which
is not JSON, so clients must check the status code before parsing.

## License

AGPL-3.0-or-later. Running a **modified** version as a network service triggers
the §13 source-offer obligation — see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
