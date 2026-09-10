# Development & Deployment

How to run, deploy, and operate carbon-intensity-api. See [`README.md`](./README.md)
for what the service is and its endpoints.

## This repo and the deployment repo

Everything that computes a number lives here: the pipeline, the providers, the
estimator, the site in [`site/`](./site) and the sync in [`sync.sh`](./sync.sh).
This repo builds `data/` on demand and does not commit it. It is the library and
the command line around it, and nothing else — no workflows, no scheduler, no
jobs that operate on published data.

The private
[carbon-intensity-api-data](https://github.com/fabiocicerchia/carbon-intensity-api-data)
repo is the **deployment**: it carries this repo as an `api/` submodule, runs
`api/sync.sh` from an hourly Action, and commits the `data/` that run produced
for audit. Everything that runs, on a schedule or in CI, is over there — the
hourly snapshot, the scheduler Worker that fires it, the lint and scan jobs that
read this source through the submodule, and the history backfill and estimator
backtest, which act on published data and so belong beside it.

The split used to be the other way round, with both repos holding the same code
and drifting — fixes landing on one and features on the other. The submodule
removes that outright: one copy of the code, named by commit wherever it runs.

So **all** code changes land here, and the deployment picks them up on its next
run. The only thing that belongs over there is how the run is wired: the
secrets, the schedule, and the commit of `data/`.

## Architecture recap — one source of truth

Compute happens **once**, in [`sync.sh`](./sync.sh), which runs the pipeline
into `data/` and syncs `data/` to the bucket — including the site pages, with
their own content types, and a check that the objects actually landed. The
deployment's Action does no work of its own: it supplies the environment (the
`R2_*` secrets as the `S3_*`/`AWS_*` ones) and commits `data/` for audit. The R2
bucket is **served directly** on the custom domain — no Worker, no application
in the request path. Nothing reads GitHub at runtime.

```
hourly Action ─► api/sync.sh ─► data/ ─► aws s3 sync ─► R2 bucket ─► clients
                                   └► committed in the deployment repo (audit)
```

Run by hand, it is the same script with the same result:

```
./sync.sh ─► data/ ─► aws s3 sync ─► bucket
```

## Local development

Requires Node ≥ 20. No dependencies, runtime or dev — there is nothing to
install before running any of this.

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

`./sync.sh` is the pipeline **plus** a push to the live bucket — it wants
`S3_BUCKET`, `S3_ENDPOINT` and AWS credentials and there is no dry-run. For a
local look use `npm run pipeline:offline` and `npm run serve`; leave `sync.sh`
to the scheduled run unless you mean to publish. `OUT_DIR` moves the build
somewhere other than `./data`, which is how the deployment repo has it write
into its own tree while running the script from the submodule.

## Cloudflare setup (R2, served directly)

1. **Create the bucket**
   ```bash
   npx wrangler r2 bucket create carbon-intensity-api
   ```
   Via `npx` — wrangler was the Worker's dev dependency and went with it. This
   is the only command that still wants it, and it runs once.

2. **Attach the custom domain to the bucket** — R2 → the bucket → Settings →
   Public access → Connect domain → `ci-api.fabiocicerchia.it`. The hostname can
   only point at one thing, so any Worker route on it has to be removed first.

3. **Rewrite `/` to the landing page.** Public buckets have no index document:
   the docs state plainly that they "do not let you list the bucket contents at
   the root of your (sub) domain", so `/` 404s. Rules → Transform Rules →
   Rewrite URL, when `http.request.uri.path eq "/"`, rewrite path to
   `/index.html`. Free, and no code.

4. **Add GitHub Action secrets** — on the deployment repo, which is where the
   hourly run lives (Settings → Secrets and variables → Actions):

   | Secret                 | Purpose                                                        |
   | ---------------------- | -------------------------------------------------------------- |
   | `R2_ACCESS_KEY_ID`     | R2 API token (S3) — becomes `AWS_ACCESS_KEY_ID`                |
   | `R2_SECRET_ACCESS_KEY` | R2 API token secret — becomes `AWS_SECRET_ACCESS_KEY`          |
   | `R2_ACCOUNT_ID`        | Cloudflare account id — builds `S3_ENDPOINT`                   |
   | `R2_BUCKET`            | bucket name, e.g. `carbon-intensity-api` — becomes `S3_BUCKET` |
   | `CF_PURGE_TOKEN`       | Cloudflare API token with **Zone → Cache Purge**               |
   | `CF_ZONE_ID`           | zone id for `fabiocicerchia.it` (Overview → API section)       |
   | `ENTSOE_TOKEN`         | optional — unlock ~38 European zones                           |
   | `EIA_TOKEN`            | optional — unlock the US                                       |

   Create the R2 S3 credentials under **R2 → Manage R2 API Tokens**. The four
   `R2_*` secrets are required: the workflow fails if they are absent, rather
   than skipping the sync and leaving the bucket empty behind a green run.

5. **Seed the bucket** — on the deployment repo, Actions → hourly-snapshot →
   Run workflow. Until the first sync lands, every path 404s: there is no
   fallback layer any more.

6. **CORS**, if browsers on other origins will call it — R2 → the bucket →
   Settings → CORS policy. Same-origin calls from the landing page do not need
   it; a third-party web app does.

### Key layout

Keys carry **no extension** so that `/v1/last-hour/DE` — the published URL —
matches an object exactly. `sync.sh` sets `--content-type application/json`
explicitly; without it aws infers from the name and serves
`application/octet-stream`, which browsers download instead of display. That
blanket label would reach the three site files too, so they are excluded from
both JSON passes and uploaded in a third with their own types. That used to be
the deployment workflow's job, patching up afterwards what the sync had just
mislabelled; it is `sync.sh`'s now, so a hand-run publish produces the same
bucket a scheduled one does.

```
v2/DE/yearly             annual average, every country
v2/DE/past-hour          last completed clock hour
v2/DE/current-hour       hour in progress
v2/DE/latest             newest hour published, at any age
v2/DE/history/2026-08-27 one UTC day of hourly means
v2/IT/SICI/past-hour     a zone is just the next code down
v2/countries.json        catalogue + annual figures  (bulk -> keeps its extension)
v2/past-hour.json        measured countries, one document

v1/last-hour/DE          country (ISO-2)
v1/last-hour/DEU         ISO-3 alias, identical content
v1/zones/IT/SICI         zone
v1/latest.json           combined snapshot   (extension kept, it is documented)
v1/last-hour/index.json  directory listing   (ditto)
v1/countries             country list
index.html, docs.html    the site, copied in from site/
favicon.svg              (ditto)
```

**Two naming rules, both load-bearing.** An UPPERCASE segment is a code and a
lowercase-hyphenated one is a resource, which is what lets `v2/IT/SICI/past-hour`
be parsed without a `zones/` marker — checked against all 80 live zone codes,
every one uppercase alphanumeric. And a per-entity key carries no extension
while a bulk document ends `.json`, extending what v1 already did for
`latest.json` and `index.json`. Content types are set at sync time regardless;
the extension is for readers, not for `aws`.

The v1 layout put zones under `v1/zones/` rather than `v1/last-hour/<CODE>/<ZONE>`
because the pipeline writes to a directory before syncing, and a filesystem
cannot have `v1/last-hour/AU` be both the country's file and the folder holding
its zones. v2 sidesteps that: nothing is ever both, since `v2/IT` and
`v2/IT/SICI` are only ever directories. It is also why a date is a path segment
(`history/2026-08-27`) — the bucket is served directly, so `?start=&end=` has
nothing to parse it.

A day's history file is **not rewritten once the day closes**. `writeHistory`
compares the document it would write against the stored one and skips an
identical result, so a provider returning a long window costs a comparison
rather than a churned object. The immutable cache headers in `sync.sh` depend on
that holding.

`v1/countries` and the ISO-3 aliases are objects because the removed Worker
used to compute them. A bucket cannot run `resolveCode()`, so `DEU` has to exist.

### What serving statically gives up

- **No computed staleness.** Already true before the move — see below.
- **No provider retry.** A zone missed by a run serves its last file until the
  next one; nothing re-checks the provider on request — bounded by the expiry
  below: an hour-named route 404s on the next run rather than serving a stale
  file, and only `/latest` carries a reading across the gap.
- **Cloudflare's 404 page**, not `{"detail": "...", "zones": [...]}`.

## Self-hosting

[`server.js`](./server.js) serves `data/` over plain Node with the same routes
(`PORT`, `DATA_DIR`). Useful locally and for anywhere you would rather run a
process than a bucket; it is not what production uses.

## Provider tokens

Live readings need no token for GB, BR, AU, SG, ZA. ENTSO-E (~38 zones) needs
`ENTSOE_TOKEN` (free — transparency.entsoe.eu) and the US needs `EIA_TOKEN`
(free — eia.gov/opendata). Without a token those countries fall back to the
annual snapshot.

Mexico has no provider: CENACE publishes generation by technology only as a
monthly settled export (June's file appears in mid-July), and its real-time web
services carry prices, not the generation mix. There is no hourly feed to
consume, so MX is annual-average and says so. Tokens are only needed by the
hourly Action; nothing runs at request time.

## Operational notes

- **Staleness:** not a field — a static object cannot evaluate freshness when
  it is fetched. Callers derive it from `generated_at` and `basis`. The >65 min
  age test applies only where `basis` is `measured`; see below.
- **Verifying a chain:** `npm run verify` (`bin/verify-providers.js`) calls every
  feed in every chain — not just the first that works, which is what
  `measuredLastHour` does — and prints each one's point count, lag, and the
  intensity its newest complete hour would produce. `--zones` includes bidding
  zones, `--code XX` narrows to one country, `--json` for machine output. It
  exits non-zero if any configured feed failed.

  It exists because **a fallback fails safe, which means a broken one is
  invisible**: a fetcher that 404s on every call looks exactly like a country
  that never had a fallback. Energy-Charts shipped with a `start` parameter its
  API rejects and every call 404'd unnoticed, because nothing ever asked a feed
  to prove itself. Run it from a machine with network access after touching any
  fetcher. It also prints the two numbers that decide whether a fallback is real
  redundancy or an aggregator: whether the two feeds' lags track each other, and
  whether they disagree on the same hour.
- **Only independent fallbacks are configured, and the rule is structural.**
  `providersFor()` filters the chain through `FALLBACK_COVERAGE`, so a feed is
  reachable only while it is declared independent of the primary — removing that
  entry retires the feed, and listing one in `FALLBACK_PROVIDERS` without it does
  nothing. A feed that re-publishes the primary goes down with it, so it buys the
  appearance of cover and no cover. Redundancy is only real if the second feed has
  its own path to the meters. Measured on 2026-08-30, while ENTSO-E was recovering
  from a publication outage, Energy-Charts was behind by 6.1 h for DE and 4.9 h
  for CH but **17.1 h for FR, 16.6 h for IT and 15.9 h for PL** — the latter
  stopping exactly where ENTSO-E stopped. For most of Europe Energy-Charts
  re-publishes ENTSO-E and inherits its outages; only DE and CH showed a
  separate path. It still covers the case the primary's *API* fails while the
  data exists, which is a real and distinct failure, but it is not cover for a
  publication outage. A country needing true redundancy needs a TSO-level feed
  (SMARD, RTE, Terna), not an aggregator downstream of the same source.
- **GB's two feeds disagree by design.** The primary passes NESO's own published
  intensity through — `parseUk` reads `intensity.actual`, it does not compute
  from a mix — while Elexon is metered generation run through this repo's own
  factors. Live on 2026-08-30 the same hour read 79 against 63, about 20 %.
  Elexon also has no solar row at all: GB solar is distribution-connected and
  invisible to transmission metering. Both are real measured readings and each
  document names the feed it came from, but they are not interchangeable to the
  decimal, which is why history records `source` per hour.

  Related, and not yet fixed: the `methodology` string says the intensity is
  "computed by Carbon Intensity API from the data_source's published generation
  mix", which is untrue for GB on the primary path — that number is NESO's, not
  ours. It predates the fallback work.
- **Route coverage is published, not documented.** `writeV2` records which
  hourly routes each country actually ended the run with, and how far behind
  `generated_at` its newest hour reaches, into `countries.json` as `routes`,
  `data_lag_seconds` and `stale`. Which routes a country answers on is a
  property of its provider's publication lag, not of the country — EIA runs
  about a day behind and Eskom several, so US and ZA carry `latest` alone and
  are flagged `stale`, while GB carries all three. A table in the docs would be
  wrong the first time a feed slipped; the catalogue cannot be, because it is
  built from what was written. `realtime_available` is kept, but it only says a
  provider exists.
- **Estimated hours.** `/past-hour` and `/current-hour` name particular clock
  hours, and most feeds publish an hour or more behind, so the named hour is
  often one the provider has not sent. `src/estimate.js` fills it: take the
  newest hour the feed did publish and scale it by the median shape of the last
  28 days at that hour and day type (weekdays pooled, Sat and Sun apart).
  Multiplicative, because intensity is a ratio — +80 gCO2eq/kWh is meaningless on
  a 70 grid and trivial on a 500 one.

  The anchor is the newest hour with ANY data, partial included: a partly filled
  hour is a real measurement and an hour closer to the target, and shortening the
  extrapolation is the only thing that meaningfully limits the error. Completeness
  still governs the *profile*, where a partial hour would bias the shape toward
  whichever part of the hour arrived. `estimate.anchor_complete` discloses which
  kind it was. Stepping hour by hour would give the identical answer — the ratios
  telescope — so the single ratio is the same method written once.

  **Bounded, and the bound is the design.** A calendar profile captures solar and
  demand, which are diurnal. It cannot capture wind, which is weather: the anchor
  is what carries wind, and that correlation decays within hours. Past the bound
  the estimate is a climatological average dressed as a reading, so the route
  404s. `bin/backtest-estimates.js` measures the error curve per country by
  rebuilding the profile from days strictly before each hour tested — no leakage
  — and the knee in that curve is where `ESTIMATE_MAX_HOURS` belongs. It differs
  per country because the error tracks the wind share of the grid. Until those
  numbers exist the conservative `DEFAULT_MAX_HOURS` stands, so a missing
  backtest under-serves rather than over-claims.

  **What it measured, on two months of real history**, across the 30 countries
  with a profile. p90 error, relative and absolute, hours past the anchor:

  |     | +1h         | +2h         | +3h         | +4h          | cap |
  | --- | ----------- | ----------- | ----------- | ------------ | --- |
  | US  | 1.4% / 5g   | 2.3% / 9g   | 3.0% / 11g  | 3.7% / 13g   | 6   |
  | PL  | 7.5% / 34g  | 11.4% / 55g | 13.8% / 73g | 16.5% / 83g  | 6   |
  | NO  | 16.7% / 1g  | 20.0% / 1g  | 22.2% / 2g  | 25.0% / 2g   | 6   |
  | FI  | 100% / 2g   | 100% / 3g   | 100% / 3g   | 100% / 2g    | 6   |
  | IT  | 9.8% / 23g  | 15.7% / 35g | 21.7% / 44g | 26.3% / 54g  | 4   |
  | DE  | 14.0% / 35g | 24.5% / 64g | 32.0% / 85g | 38.1% / 106g | 2   |
  | GB  | 17.5% / 25g | 28.6% / 42g | 37.0% / 55g | 46.6% / 65g  | 2   |
  | AT  | 100% / 23g  | 111% / 30g  | 138% / 32g  | 149% / 36g   | —   |

  The rule, stated once in `ESTIMATE_MAX_HOURS` and re-appliable when these are
  re-measured: a horizon is allowed if its p90 relative error is at most 30%, or
  its p90 absolute error is at most 20 gCO2eq/kWh.

  **Both tests are needed because the grids differ by thirty times.** On PL the
  percentage is the meaningful number. On FI it is an artifact of dividing by
  something near zero — 100% wrong and three grams out, which nothing downstream
  could act on differently. 20 g is the escape hatch because it is below the
  spread between published emission factors for the same fuel: an error smaller
  than the inputs' own disagreement is not worth withholding a figure over.

  The median is deliberately not part of the rule. It decides nothing the p90
  has not already decided, and it hid the cases that mattered: DE reads 4.0% at
  one hour and 14.0% at the same horizon on the p90, because a wind grid's worst
  hours are ramps rather than glitches — the phenomenon the estimate exists to
  track, not noise to trim.

  Five countries were measured and rejected: **AT, EE, HR, LU, SK** fail both
  tests at every horizon. Absent from the map by measurement, not by omission.

  `DEFAULT_MAX_HOURS` is 1, down from 3, and covers those five plus anything not
  yet measured.

  Two countries the method cannot serve at all, for reasons worth knowing before
  reaching for more history: **CH** publishes 0 gCO2/kWh direct in every hour —
  hydro and nuclear, no combustion — so a multiplicative ratio has nothing to
  scale and `estimateHour` refuses on `pAnchor > 0`. The number worth estimating
  for such a grid is lifecycle, which this method does not produce. **AU** and
  **ZA** cannot accumulate a profile from backfill, because OpenNEM and Eskom
  expose only their own short spans (7 and 4 days); theirs has to build up from
  the hourly pipeline over four weeks.

  Three things it never does: estimate `/latest`, which means the newest *real*
  reading; write an estimate into `history/`, which is what the profile is built
  from — estimates training on estimates is the one failure that compounds
  quietly; or publish without enough support, so a fresh deployment estimates
  nothing until four weeks have accumulated. It ships inert.
- **Backfilling history:** `bin/backfill-history.js` in the deployment repo
  fetches real past hours and writes them as history documents, so the estimator
  has a profile and `bin/backtest-estimates.js` has something to measure. Both
  run there because both act on published data; both import this repo's modules
  through the submodule. Needs network and
  `ENTSOE_TOKEN`; the hourly Action does not run it. Only feeds that accept an
  arbitrary window can be backfilled — ENTSO-E (A75 takes up to a year per
  request) and Energy-Charts — which covers 48 series, the 30 ENTSO-E countries
  and their 18 zones. Everything else publishes a snapshot of now and can only
  accumulate one run at a time. That is not much of a limit: the countries whose
  publication lag makes estimation worth having are exactly the ENTSO-E ones.

  Coverage is **113 of the 117 series**:

  | Feed           | Series                  | How far back                                  |
  | -------------- | ----------------------- | --------------------------------------------- |
  | ENTSO-E        | 30 countries + 18 zones | the window asked for (A75 takes up to a year) |
  | EIA            | US + 55 respondents     | the window asked for                          |
  | Elexon         | GB                      | the window asked for                          |
  | Energy-Charts  | DE, CH                  | the window asked for                          |
  | OpenNEM        | AU + 6 regions          | ⚠️ its own 7 days, whatever the window says   |
  | Eskom          | ZA                      | ⚠️ its own month, whatever the window says    |
  | ONS, EMC, IESO | BR, SG, CA/ON           | **cannot** — snapshot of now only             |

  The last two publish a fixed span in one document, so `rangedFetcher` marks
  them `windowed: false` and the script fetches once instead of pulling the same
  bytes for every window. Their parsers — `parseEskomCsvAll`, `parseOpennemAll` —
  read the documents the live path already fetches, whole rather than for their
  tail, which is what the "ponytail" notes in those parsers asked for. No new
  endpoint is involved, so the only risk is in the parsing, and the backfill
  reports every failed window rather than failing into silence.

  It paces itself and retries: `--delay` (1s between requests), `--attempts` (4,
  jittered backoff on 5xx, 429 and timeouts, never on a 4xx or an ENTSO-E
  acknowledgement), `--timeout` (60s against the live path's 15s), and
  `--skip-existing` to resume a run that died partway. The first version had none
  of these, fired 513 requests as fast as it could, and ENTSO-E answered 503 to
  every window — comfortably under its documented 400/minute, but a backfill has
  no business finding the limit.

  It shares its two load-bearing pieces with the pipeline rather than copying
  them: `upsertDays()` in history.js folds means into day documents, and the
  immutability rule that keeps closed days byte-stable lives there and nowhere
  else — it was written twice, and it only has to be got wrong in one place for
  the `immutable` cache headers to become a lie. `retrying()` in live.js is the
  one implementation of which failures are worth a second attempt, so the live
  path and the backfill cannot disagree about it. A dry run is a `put` that does
  nothing, not a flag inside the writer.

  A backfilled day is therefore identical in shape to one accumulated live.
  `--dry-run` reports what it would write.
  The result belongs in the repo and the bucket: those are real measured hours,
  and they make `/v2/<CODE>/history/<date>` answer for two months back.
- **When a provider goes dark:** the two hourly routes are the only objects with
  an expiry. `writeV2` walks every series the provider tables know about, not
  just the ones a run measured — a country that drops out of the snapshot is
  otherwise never reached again, so nothing overwrites its objects and nothing
  deletes them. A series that returned nothing loses both
  hour-named routes on that run: no grace period, nothing held back, because the
  routes name clock hours and there is no such hour to serve. Whether the
  provider answered with a window holding no usable hour or did not answer at
  all makes no difference to whether the hour exists.

  `/latest` is exempt from both halves of that: no age bound when it is written,
  and never expired when a series returns nothing. It answers "the newest
  reading you have at all", which does not stop being true because the provider
  went quiet — it simply stops being rewritten, so its `generated_at` stands
  still and the staleness is visible instead of hidden. This is what keeps the
  two hour-named routes able to mean the hours they name: EIA publishes about a
  day behind and Eskom several, so without a separate route those feeds would
  force `/past-hour` to mean "the last hour we happen to have", which is a
  different promise.

  `HOURLY_MAX_AGE_SECONDS` (6h) governs one thing only: how old a *freshly
  computed* hour may be before it stops being one of the hours those routes name.
  It is measured against the hour itself rather than against the run, because a
  provider's ordinary publication lag already puts `period_end` a few hours back,
  and it draws the `stale` line in the catalogue too. Note that: the fetch window used
  to do that by accident — against a three-hour window `/past-hour` could only
  ever be two hours behind — so widening it to twelve would have loosened the
  route to eleven. A provider recovering by backfilling only old hours would then
  republish a half-day-old hour every run, with a moving `generated_at` making it
  look current.
  `--no-live` reconciles nothing at all — it asks no provider anything, and "we
  did not try" is not grounds for expiring an object.
- **Provider health is logged on every run.** `measuredLastHour` reports a
  give-up through `onFailure` instead of swallowing it, and `bin/pipeline.js`
  prints one line per provider:

  ```
  provider ENTSO-E: 2/3 series, newest data 3h01m behind (last error: HTTP 400 for …periodStart=…&securityToken=***)
  provider NESO: 1/1 series, newest data 0h16m behind
  ```

  The lag is the number to watch: it has to stay inside the provider's fetch
  window, and when it crosses, the provider stops answering at all and nothing
  distinguishes that from an outage. The error carries the status and the
  window actually requested, which is what separates a 400 (the provider holds
  nothing for that window) from a 401 (the token). Credentials in the query
  string are blanked first — Actions masks its own secrets, a local run does
  not. A provider with zero successful series also gets a `::warning::`
  annotation on the Action. Runs stay green regardless: a failed provider falls
  back to the annual figure and the rest of the data still publishes — but a
  30-country outage no longer looks identical to a quiet hour.
- **ENTSO-E returns curveType A03**, "variable sized blocks": a point holds
  until the *next* position, so a series that changes slowly is published
  sparsely while solar reports every quarter hour. `parseEntsoe` fills each
  point forward to the position after it, bounded by the Period's own end. Under
  A01, where every position is present, filling forward is a no-op — which is
  why it is unconditional rather than behind a `curveType` check. Reading only
  the positions present computed the mix at 21:15 from whichever fuels happened
  to report there, which for a mostly-renewable instant is a few gCO2 where the
  truth is a few hundred.
- **Retries are for dropped connections, not refusals.** An acknowledgement
  (`999 No matching data found`) or the HTML maintenance page is what the
  platform *means*; it will say the same thing one and three seconds later, so
  those are thrown with `retryable: false` and tried once. What rides out a long
  outage is the 20-minute schedule plus `/latest` holding the last reading
  meanwhile — during the 2026-08-29 maintenance the retries turned 48
  pointless requests per run into 144, three times an hour, against a service
  that was down.
- **Provider fetch windows:** ENTSO-E is asked for `ENTSOE_WINDOW_HOURS` (12) up
  to now. The platform runs one to four hours behind real time and answers a
  window it has no data for with HTTP 400, not an empty document, so a window
  narrower than the lag is indistinguishable from an outage. The three-hour
  window this started with is what turned an ENTSO-E publication stop on
  2026-08-29 into 30 countries silently dropping to their annual figures, with
  `/v2/DE/past-hour` deleted on the way out.
- **Write cadence:** measured countries are rewritten every run. Annual-average
  countries are left alone unless their figures change or the stored copy is a
  week old — a yearly figure cannot change hour to hour, and rewriting all 176
  of them every run churned the repo and the bucket for three timestamps. They
  also carry `hour_start`/`hour_end` as `null`, since an annual average
  describes no particular hour.
- **Refreshing bundled annual data:** re-run the extraction from the OWID energy
  dataset into `src/datasets/countries.csv`, regenerate `countries.json`, and
  commit. Sources live in `src/datasets/sources.csv`.
- **Attribution URL:** the `attribution` block in responses is defined in
  [`src/data.js`](./src/data.js) (`ATTRIBUTION`). Update it if the site URL or
  repository location changes.
- **What triggers the hourly run:** a Cloudflare Worker in the deployment
  repo's `trigger/`, which dispatches that repo's workflow once an hour. The
  cron inside that workflow is a fallback only — GitHub drops scheduled runs in
  correlated bursts, so a denser cron does not survive them, and `*/20` delivered
  as few as 2 runs a day against 72 requested. Its `trigger/README.md` has the
  token scopes and the deploy steps.
- **Adding a provider:** add a pure `parse*` + `fetch*` in
  [`src/live.js`](./src/live.js), map its fuels in
  [`src/factors.js`](./src/factors.js), route it in `providerFor`, and add a
  fixture test. `measured_count` rises automatically.

## Edge caching

`sync.sh` runs **three passes**, because closed history days, everything else,
and the site pages want different lifetimes and content types, and `aws s3 sync`
takes one of each per invocation:

| Objects                                              | Cache-Control                                            |
| ---------------------------------------------------- | -------------------------------------------------------- |
| everything mutable (all of v1, v2 minus closed days) | `public, max-age=60, s-maxage=1200`                      |
| `*/history/<a past date>`                            | `public, max-age=31536000, s-maxage=31536000, immutable` |
| `index.html`, `docs.html`, `favicon.svg`             | `public, max-age=60, s-maxage=3600`                      |

The split works because the pipeline never rewrites a day once it closes, so
those objects genuinely cannot go stale. `--exclude` also protects them from
`--delete` in the first pass — AWS excludes filtered paths from deletion, not
just from upload — while the second pass's `--delete` is what carries retention
through: a day pruned locally disappears from the bucket on the next sync.

**There is no purge step any more, and no `CF_PURGE_TOKEN`.** It had to go:
`purge_everything` evicts objects whether or not they changed, so it would have
thrown away the immutable days three times an hour and made their long TTL
decorative — and since v2 keeps history under each `v2/{CC}/` prefix beside the
mutable objects, no prefix purges one without the other. So `s-maxage` came down
to the run cadence instead, which is the trade this section always prescribed:
drop the purge, drop the TTL with it. The edge now trails by at most one cycle,
on data whose own publication lag is 27–64 minutes (median 40) — the purge was
buying freshness the upstream data never had. `max-age` stays at 60 because a
purge could never reach a browser cache anyway.

`sync.sh` keeps an optional `CDN_PURGE_CMD` hook for self-hosting. If you use
it, purge specific prefixes — a blanket purge re-breaks the above.

Cache hits never reach R2, so they cost no Class B operation and are answered
from the local colo. WAF sits ahead of the cache in the traffic sequence, so
rate limiting still counts requests that never touch the bucket.

## Rate limiting

A WAF **rate limiting rule**. There is no application code to put a limiter
in, and the rule runs at the edge before the bucket is read.

```
Expression:  (http.host eq "ci-api.fabiocicerchia.it"
              and (starts_with(http.request.uri.path, "/v1/")
                or starts_with(http.request.uri.path, "/v2/")))
Requests:    10
Period:      10 seconds
Action:      Block
```

**10 seconds is the ceiling on the free plan** — periods go up to 300s (5 min)
and beyond, but Free allows only 10s, Pro 60s, Business 10 min. A longer window
means upgrading the zone, not changing anything here.

**Free also allows exactly one rule per zone**, and that is why the threshold is
10 rather than the 1 it used to be. v2's paths have no shared resource prefix to
match on — `/v2/IT/past-hour` and `/v2/FR/history/…` have only `/v2/` in common,
and matching `^/v2/[A-Z]{2}/` needs a regex operator Free does not have — so the
rule widened to the whole of `/v1/` and `/v2/`, and everything shares one
counter. At 1/10s a client filling a history window on first boot would take
minutes; at 10/10s it finishes in one interval. 60 req/min/IP is still far below
anything that dents the 10M Class B/month free tier. The widening also brings
in `/v1/countries` and `/v1/last-hour/index.json`, which the previous expression
missed — it named `last-hour/`, `zones/` and `latest.json` and stopped there.

A blocked request gets Cloudflare's built-in page: `429`, `content-type:
text/plain`, body `error code: 1015`. Custom response bodies for rate-limiting
rules are Pro-and-above, so clients must check the status before parsing.

## Emergency stop

Cloudflare has no spend cap, so an abusive caller turns into an invoice rather
than an outage. There is no automatic backstop — set a billing alert, and keep a
way to cut traffic by hand. (R2 gives 10 GB storage and 10M class-B reads a
month free, and cache hits are not reads at all, so this is headroom rather than
an imminent bill.)

**Available today — WAF custom rule.** Security → WAF → Custom rules:

```
Expression:  (http.host eq "ci-api.fabiocicerchia.it")
Action:      Block
```

Create it and leave it **disabled**, so pulling the plug is one toggle with no
deploy and no propagation wait. The free plan includes five custom rules.

This is the only layer available: with the bucket served directly there is no
code in the request path to refuse anything. WAF custom rules run early in the
traffic sequence (DDoS → URL rewrites → Page Rules → IP access → Bots → WAF →
origin), so a block never reads an object. The cost is that callers get
Cloudflare's generic 403 page, not a useful body.

Blocking at the WAF is now the whole story: the Worker-level kill switch that
was noted here has nowhere to live, since no code runs in front of the bucket.
A gentler alternative, if you ever want a maintenance message rather than a 403,
is a Transform Rule rewriting `/v1/*` to a static `maintenance.json` in the
bucket.

## License

AGPL-3.0-or-later. Running a **modified** version as a network service triggers
the §13 source-offer obligation — see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
