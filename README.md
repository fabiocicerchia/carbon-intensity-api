# carbon-intensity-api

Last-hour grid carbon intensity (gCO2eq/kWh) for **every country** with
published electricity data — 213 in total — as a static JSON API.
Real last-hour readings where a live grid feed exists; a labelled annual
snapshot everywhere else. Served as static objects straight from an
**S3-compatible bucket** — no application in the request path — with an
optional Node server for local use and self-hosting.

Every reading exposes four figures — `direct` (operational), `lifecycle`
(IPCC AR6 upstream), `consumption_direct` (trade-adjusted, still operational)
and `consumption_lifecycle` (both) — plus a `basis`
(`measured` | `annual-average`), a `data_source` and a `generated_at`.

## Architecture — one source of truth

Compute happens **once**, in [`sync.sh`](./sync.sh), which runs the pipeline
and writes `data/` (a combined `latest.json` plus one file per country under
`data/v1/last-hour/`, and the site pages copied in from [`site/`](./site))
before syncing it up. The bucket only **serves** those files — nothing
recomputes them, they go out verbatim. This keeps a single, auditable source of
truth and avoids double computation.

```
./sync.sh  ──compute──▶  data/  ──sync──▶  bucket ──serve──▶ CDN ──▶ clients
```

Run it by hand, or on a schedule for the hourly cadence the readings assume.
The deployment that backs the hosted API does the latter: it carries this repo
as a submodule, runs `./sync.sh` hourly from a GitHub Action, and commits the
`data/` it produced for audit. This repo holds the code; nothing about it
assumes that particular deployment.

## Endpoints

Lookups are path-based — the bucket is served directly, so there is nothing in
the request path to read a query string.

### v2 — use this

| Path                              | Returns                                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/v2/<CODE>/past-hour`            | The last **completed** clock hour: the mean of every point in it. Immutable once published.         |
| `/v2/<CODE>/current-hour`         | The hour **in progress**: the mean of the points so far. Moves between runs.                        |
| `/v2/<CODE>/latest`               | The newest hour the provider has published, **however old**. Same shape as `/current-hour`.         |
| `/v2/<CODE>/history/<YYYY-MM-DD>` | One UTC day of hourly means.                                                                        |
| `/v2/<CODE>/yearly`               | The annual average. Every country has one.                                                          |
| `/v2/<CODE>/<ZONE>/…`             | The same three hourly routes for a bidding zone / balancing region — `/v2/IT/SICI/past-hour`        |
| `/v2/countries.json`              | Every country: metadata, zones, annual figures, **and which hourly routes it currently answers on** |
| `/v2/past-hour.json`              | The measured countries' last completed hour, in one document                                        |
| `/`                               | HTML landing page                                                                                   |

**Path grammar:** an UPPERCASE segment is a code, a lowercase-hyphenated one is
a resource. So `/v2/IT/SICI/past-hour` reads unambiguously as country, zone,
resource, and a zone is simply the next code down rather than needing a `zones/`
marker. ISO-2 only in v2 — the ISO-3 aliases are a v1 feature.

**Coverage.** The hourly routes exist only where a provider publishes live
generation. Everything else 404s, rather than serving a yearly constant under a
name that promises an hour:

|                                | `/yearly` | `/past-hour`, `/current-hour`, `/latest`, `/history` |
| ------------------------------ | --------- | ---------------------------------------------------- |
| countries with a live provider | yes       | yes                                                  |
| countries without one          | yes       | **404**                                              |
| zones                          | **404**   | yes                                                  |

Zones have no annual figure because the annual dataset is country-level — the
same reason they are measured-only.

`/past-hour` additionally needs a **complete** hour — one holding all
`points_expected` of its points. How quickly that happens depends on how much
the provider hands over per call: ENTSO-E returns twelve hours at a time and
IESO the whole delivery day, so their hours complete as soon as they are over. A
provider that publishes one snapshot per call (OpenNEM, EMC, Eskom, ONS) reports
`resolution_sec: 3600`, so one point completes its hour — for those, `complete`
means "everything this provider gives for that hour", not "four samples".

**When a provider goes down**, `/past-hour` and `/current-hour` 404 on the very
next run. There is no grace period and nothing is held back: they are named for
particular clock hours and mean them, so holding yesterday's under either name
for a few hours is the same untruth as holding it for a day, only shorter. The
same rule caps how far back they reach when a provider recovers — an hour that
ended long enough ago is not published as the last completed one, however
complete it is.

`/latest` is what carries a reading across the outage, and it carries it for as
long as the outage lasts.

### Estimated hours

`/past-hour` and `/current-hour` name particular clock hours. Most feeds publish
an hour or more behind, so the hour they name is often one the provider has not
sent yet. Where there is enough history, that hour is **estimated** rather than
skipped, and says so:

```json
{
  "period_start": "2026-08-31T11:00:00Z",
  "direct": 300,
  "basis": "estimated",
  "points": 0,
  "complete": false,
  "estimate": {
    "method": "diurnal-profile-anchored",
    "anchor_hour": "2026-08-31T09:00:00Z",
    "hours_ahead": 2,
    "profile_days": 28,
    "profile_samples": 20,
    "max_hours": 2,
    "backtested_max_hours": 6,
    "from_source": "EIA"
  }
}
```

The method is one line: take the newest hour the feed *did* publish, and scale it
by how this grid usually moves between that hour and the target — the median at
each hour over four weeks, weekdays pooled, Saturday and Sunday apart. The anchor
carries today's weather; the ratio carries the expected shape. It is
multiplicative because intensity is a ratio: +80 gCO2eq/kWh is meaningless on a
70 grid and trivial on a 500 one.

**It is deliberately short-range.** A calendar profile captures solar and demand,
which are diurnal. It cannot capture wind, which is weather — the anchor is what
carries wind, and that correlation decays within hours. Past the bound the
estimate would be a climatological average dressed as a reading, so the route
404s instead. A provider down for half a day is a redundancy problem, not an
arithmetic one.

How far it stays *useful* is measured per country rather than assumed, by
backtesting the estimator against two months of real history and reading the
**ninetieth percentile** rather than the median — on a wind grid the worst hours
are ramps, which is exactly what an estimate needs to survive.

A country is allowed a horizon if its p90 error there is within 30%, or within
20 gCO2eq/kWh. Both tests, because the grids differ by thirty times: on Poland
the percentage is what matters, while Finland reads 100% wrong and is three
grams out, which nothing downstream could act on differently.

That gives six hours to `BG`, `DK`, `FI`, `FR`, `LV`, `NO`, `PL`, `RS`, `SI` and
`US`, and less to the rest, down to one hour for `BE`, `MK` and `NL`. `AT`, `EE`,
`HR`, `LU` and `SK` were measured and pass at no horizon at all. Switzerland
cannot be estimated at all: its direct intensity is 0 in every hour, so there is
nothing for a ratio to scale.

**That measured number is a floor, not a ceiling.** How far an estimate has to
reach is not the estimator's choice — it is however far behind the feed is
publishing. `/current-hour` names the hour in progress, so a country whose
provider runs three hours behind must reach three hours to answer at all, and a
two-hour horizon does not make that route more accurate, it deletes it. So the
horizon each run is `max(backtested, hours the provider is behind)`. Germany,
measured at two hours behind a feed that publishes at about three, is why: its
`/current-hour` used to 404 on every green run while `/past-hour` and `/latest`
answered beside it.

The hard stop is six hours past the anchor, which no country's measurement can
raise. Beyond it only the ratio term is left and the figure is a climatological
average, so the route 404s — a feed further behind than that is a redundancy
problem, as it always was.

Both numbers are in every estimated document: `max_hours` is the horizon actually
applied and `backtested_max_hours` what the country was measured at. A consumer
that wants only estimates inside the measured error bound keeps the ones where
`hours_ahead <= backtested_max_hours`.

Three things it never does: estimate `/latest`, which means the newest *real*
reading; write an estimate into `/history`, which is the data the profile is
built from; or publish at all without enough history to support the shape — a
fresh deployment estimates nothing until four weeks have accumulated.

`basis` is the field to check. `/v2/past-hour.json` carries it per country too.

### Which countries answer on which route

Not every measured country answers on all three, and it is the **provider's
publication lag** that decides — not the country. `/v2/countries.json` carries
the live answer per country, so check it rather than assuming:

```json
{ "country_code": "GB", "provider": "NESO",   "routes": ["past-hour","current-hour","latest"], "data_lag_seconds": 1020,   "stale": false }
{ "country_code": "US", "provider": "EIA",    "routes": ["latest"],                            "data_lag_seconds": 107220, "stale": true  }
{ "country_code": "DE", "provider": "ENTSO-E","routes": [],                                    "data_lag_seconds": null,   "stale": false }
{ "country_code": "AF", "provider": null,     "routes": [],                                    "data_lag_seconds": null,   "stale": false }
```

- **`routes`** — which of the three answered as of `generated_at`.
- **`data_lag_seconds`** — how far behind that timestamp the country's newest
  hour reaches, measured to the end of that hour. A live feed sits near zero.
- **`stale`** — ⚠️ the warning flag: the lag is past the bound the hour-named
  routes are held to, so only `/latest` answers and the figures are a *recent*
  reading rather than a current one.

All three are recomputed every run from what was actually published, so a feed
that falls behind or comes back is reflected without anyone editing a table.
`realtime_available` only says a provider exists; these say what came of it.

**The fallback chains themselves** live in `FALLBACK_PROVIDERS`
([`src/live.js`](./src/live.js)), but reading that file shows a loop rather than
a list — the ENTSO-E chains are derived from `ENTSOE_DOMAIN` so a country added
to the primary table gets its fallback in the same commit. The readable form is
the `providers` array in `/v2/countries.json`, one entry per country, primary
first:

```json
{ "country_code": "DE", "providers": ["ENTSO-E", "Energy-Charts"] }
{ "country_code": "US", "providers": ["EIA"] }
```

Today that is **3 countries of 37** with a second feed: DE and CH via
Energy-Charts, GB via Elexon. `provider` is the primary; `data_source.name` on an
hourly document says which feed actually replied, and the two differ exactly when
a fallback carried the country.

Each entry also carries **`redundancy`**, which is `independent` or `none` and
nothing in between:

| `redundancy`  | Meaning                                                                                      | Countries                |
| ------------- | -------------------------------------------------------------------------------------------- | ------------------------ |
| `independent` | a second feed with its own path to the meters — covers the primary going down for any reason | **3** — DE, CH, GB       |
| `none`        | one feed, or none                                                                            | **34** — everything else |

**A feed that re-publishes the primary is not configured as a fallback at all.**
Energy-Charts was listed for all 30 ENTSO-E countries until it was measured:
during the 2026-08-29 publication outage it ran 6.1 h behind for DE and 4.9 h for
CH — its own path — but 17.1 h for FR, 16.6 h for IT and 15.9 h for PL, the last
stopping exactly where ENTSO-E stopped. For those 28 it is downstream of the
primary and goes down with it, so it was removed rather than left standing as
cover that is not there. The rule is enforced in `providersFor()`, not left to
whoever edits the table: a fallback is reachable only while it is declared
independent.

That is deliberately strict. It gives up cover for one real failure — the
primary's *API* going down while its data still exists, which is what the
ENTSO-E timeouts on 2026-08-30 were — in exchange for `redundancy: "independent"`
meaning exactly one thing.

Closing the gap for the other 34 needs a TSO-level feed each — SMARD, RTE, Terna
— rather than an aggregator downstream of the same source. Those would also be
the way to cover **bidding zones**, which have no fallback at all: a national
feed cannot answer for one, so `/v2/IT/SICI/…` is ENTSO-E or nothing.

Who serves whom is fixed:

| Provider | Countries                                 | Observed lag        | Usually answers |
| -------- | ----------------------------------------- | ------------------- | --------------- |
| OpenNEM  | AU + NEM regions                          | minutes             | all three       |
| NESO     | GB                                        | ~15 min             | all three       |
| ONS      | BR                                        | minutes             | all three       |
| EMC      | SG                                        | minutes             | all three       |
| IESO     | CA — Ontario zone only                    | ~2 h                | all three       |
| ENTSO-E  | 30 European countries + all bidding zones | 1–4 h               | all three       |
| EIA      | US + 55 balancing authorities             | ⚠️ **~1 day**       | `latest` only   |
| Eskom    | ZA                                        | ⚠️ **several days** | `latest` only   |

Everything else is annual-average and answers on `/yearly` alone.

⚠️ **These lags are observed, not contractual.** They are what each feed was
doing when this was written, and they move — a platform outage or a changed
publication schedule shifts a provider between rows without warning. That is
exactly why the per-country answer is generated into `countries.json` every run
rather than fixed in this table: treat the table as orientation and
`routes` / `data_lag_seconds` / `stale` as the truth.

EIA and Eskom are the standing warning cases. Both publish real measured data,
just far enough behind that no recent clock hour exists to serve — so their
countries carry `latest`, 404 on the other two, and are flagged `stale`.
ENTSO-E's 1–4 h sits close enough to the bound that a bad day pushes its 30
countries the same way. A country whose provider is down carries an empty
`routes` and 404s on all three until it returns.

`/latest` is the other question — *what is the newest reading you have at all* —
and it has no age bound. Some feeds run a day or more behind by design (EIA
about a day, Eskom several), and for those it is the only reading there is. It
is not rewritten while a provider is quiet, so its `generated_at` stands still
and its age shows in the document rather than being hidden by a moving
timestamp. Read `period_start` and `generated_at` before using it for anything
time-sensitive. A provider publishes with its own
lag and skips runs, so blanking a route the first time a fetch comes back empty
would have `/past-hour` flickering in and out all day; leaving the documents up
indefinitely would have `/current-hour` answering with an hour from yesterday.
Read `generated_at` if you need to know how long ago the run behind a document
was, and `period_start`/`period_end` for which hour it actually describes.

### v1 — frozen

Still served, still refreshed every run, unchanged in shape. It will be removed;
prefer v2 for anything new.

| Path                      | Returns                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `/v1/last-hour/<CODE>`    | Newest **data point** for one country (ISO-2 or ISO-3)                 |
| `/v1/zones/<CODE>/<ZONE>` | Same for a bidding zone / balancing region                             |
| `/v1/latest.json`         | All countries in one snapshot                                          |
| `/v1/countries`           | Supported countries (with `realtime_available`, `zones` + data source) |

`/v1/last-hour/` does not return an hour. It returns the newest point the
operator published, which is 15 minutes wide for ENTSO-E and an hour for EIA —
the name predates the providers moving to sub-hourly resolution. `hour_start`
and `hour_end` are that point's own bounds. v2's `period_start`/`period_end` are
always a true clock hour, with `resolution_sec` saying how wide the underlying
points were.

Each reading embeds its `data_source` (operator, URL, status), so a separate
sources endpoint isn't needed.

### Migrating

| v1                                       | v2                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `/v1/last-hour/IT`                       | `/v2/IT/current-hour` (partial, live) or `/v2/IT/past-hour` (complete)     |
| `/v1/zones/IT/SICI`                      | `/v2/IT/SICI/current-hour`                                                 |
| `/v1/latest.json`                        | `/v2/countries.json` for the static picture, `/v2/past-hour.json` for live |
| `/v1/countries`                          | `/v2/countries.json` — same fields plus the four annual figures            |
| `hour_start` / `hour_end`                | `period_start` / `period_end` (+ `resolution_sec`)                         |
| annual figure via `/v1/last-hour/<CODE>` | `/v2/<CODE>/yearly`                                                        |

The four figures are the corners of two axes — scope (combustion only vs plus
upstream) and boundary (generated here vs consumed here):

|                     | Production-based | Consumption-based       |
| ------------------- | ---------------- | ----------------------- |
| **Combustion only** | `direct`         | `consumption_direct`    |
| **Plus upstream**   | `lifecycle`      | `consumption_lifecycle` |

Production-based counts what a country generates, exports included;
consumption-based counts what is drawn from a socket there, adjusted for trade.
They diverge wherever trade is heavy — Switzerland generates at 39 and consumes
at 179.

They are **not** a ladder: for an importing country `consumption_direct`
exceeds `lifecycle` while counting less of the supply chain. Report with
`consumption_lifecycle`, which is also the most modelled — its upstream uplift
is derived from the domestic generation mix and applied to the consumed one, so
it assumes imports carry a similar upstream intensity per kWh.

All four are `direct` plus a per-country constant, so **within one country**
they rank the hours identically — for time-shifting, any of them will do.
**Across countries they do not**: the constants differ, and the ordering flips.
Switzerland beats France on `direct` (39 vs 41) and loses badly on
`consumption_direct` (179 vs 85). For placement, the figure decides the answer.

**There is no `stale` flag.** Responses are static objects, so nothing evaluates
freshness at request time. Derive it from `generated_at` — the pipeline runs
hourly, so more than ~65 minutes old means a refresh was missed — and from
`basis`, since `annual-average` is never a reading for the hour you asked for.
Note the age test binds **only** measured readings: annual ones carry
`hour_start: null`, are rewritten weekly rather than hourly, and an old
`generated_at` on one is expected:

```js
const stale = (Date.now() - Date.parse(r.generated_at)) > 3900e3
  || r.basis !== "measured";
```

Rate-limited to **10 requests per 10s per IP**, returning `429` beyond that. It
is a CDN/WAF rule — there is no application code to put a limiter in — and 10s
is the longest counting period the hosted deployment's plan allows. That plan
also allows exactly **one** rule, so v1 and v2 share a counter; the threshold is
10 rather than 1 so that a client filling a history window on first boot
finishes inside a single interval. See [`DEV.md`](./DEV.md).

**Check the status code before parsing the body as JSON.** Neither error a
client will actually hit is JSON: a `429` is `text/plain` and a `404` is the
edge's own HTML page. Both are the edge's responses, not this API's, and on the
hosted deployment neither can be changed. Feeding them to a JSON parser is the
most likely way to break a client.

### Reading the v2 history shape

`/v2/<CODE>/history/<date>` is columnar: one array per figure, plus `points`
and `complete`, all index-aligned to the hour beginning `start + i*3600`.

- **A missing hour is `null`, never omitted.** Dropping it would slide every
  later value into the wrong hour.
- Today's document is **truncated** at the last hour seen; a closed day has all
  24 entries.
- `points[i]` is how many source points the mean covers; `complete[i]` says
  whether that was all of them. Both describe the hour, not a figure, so there
  is one of each rather than one per figure.
- There is deliberately **no day-level `resolution_sec`/`points_expected`**: a
  provider can change granularity mid-day, so completeness is decided per hour
  when the hour is written. Do not recompute it client-side from a constant.
- Zone documents carry `direct` and `lifecycle` only.
- **A closed day never changes again**, so it is safe to cache indefinitely — a
  day whose date is in the past will not be rewritten. Retention is 365 days.
- Treat a 404 for a date as *no data for that date*, not an error.

Zones exist only where the provider publishes below national level: the ENTSO-E
bidding zones (IT, SE, NO, DK), the EIA-930 regions *and* balancing authorities
(US — `US/TEX` for the region, `US/ERCO` for ERCOT inside it), and the NEM
regions plus WEM (AU). They are **measured-only** — the annual dataset is
country-level, so a
zone with nothing stored and nothing live returns 404 rather than falling back.
They also omit both consumption figures, whose import adjustment is a national
figure that does not describe a single zone.

A zone whose provider fails is absent from that hour's snapshot and is dropped
from the bucket by the sync, so the next request retries the provider directly
and either self-heals or 404s. Zone endpoints therefore come and go with
provider availability, by design.

**Clients should treat a zone 404 as "ask the country instead."** A zone can
vanish for an hour whenever its provider has a bad minute, so
`/v1/last-hour/IT/SICI` failing over to `/v1/last-hour/IT` is the expected
pattern — coarser, but always answerable.

```bash
curl https://ci-api.fabiocicerchia.it/v1/last-hour/DE
```

## Run locally

```bash
npm test                 # node:test — pure parsers, data layer, handler, pipeline
npm run pipeline:offline # build data/ with the annual snapshot (no network)
npm run serve            # Node server on :8000, serving data/
```

`npm run pipeline` (no `:offline`) also fetches the live providers (see below).

## Real-time providers

Live readings compute operational intensity from each grid's generation mix
(`Σ MWh_fuel × factor_fuel / Σ MWh`); lifecycle/consumption are layered on per
country. Each provider is a pure `parse*` function (unit-tested) + a thin
`fetch*` wrapper.

| Provider                  | Countries                             | Token          |
| ------------------------- | ------------------------------------- | -------------- |
| UK NESO                   | `GB`                                  | none           |
| ONS                       | `BR`                                  | none           |
| OpenNEM / OpenElectricity | `AU`                                  | none           |
| EMC                       | `SG`                                  | none           |
| Eskom                     | `ZA`                                  | none           |
| ENTSO-E                   | ~38 European zones (incl. `LU`, `MK`) | `ENTSOE_TOKEN` |
| EIA                       | `US`                                  | `EIA_TOKEN`    |

Tokens are only ever read by the pipeline, so they belong wherever `sync.sh`
runs — an Action secret store for a scheduled deployment, the environment for a
hand-run build.
Mexico has no provider — CENACE publishes generation by technology only as a
monthly settled export, so there is no hourly feed to read. Countries without a provider — or when a fetch fails —
fall back to the annual snapshot.

## Deploy

Nothing runs at request time. `./sync.sh` writes `data/` and syncs it into the
bucket, which is served directly on a custom domain. The hosted deployment runs
exactly that script from an hourly Action; anything that can run a shell script
on a schedule does as well.

**Keys have no extension** — `v1/last-hour/DE`, not `DE.json` — because a bucket
matches an exact key and `/v1/last-hour/DE` is the published URL. Content types are set
by the sync (`--content-type application/json`), not inferred from the name.
`latest.json` and `index.json` keep their extensions, being documented with them.
Zones live under `v1/zones/`, not inside `v1/last-hour/`: a bucket would take
either, but the pipeline writes to a directory first and a filesystem cannot
have `v1/last-hour/AU` be both the country's file and the folder of its zones.

The landing page, the docs page and the icon are the exception to "everything
under `data/` is output": they are hand-written, they live in [`site/`](./site),
and the pipeline copies them into the build so the sync publishes them with the
rest. `sync.sh` uploads those three with their own content types — labelling the
landing page `application/json` makes a browser download it instead of rendering
it.

ISO-3 lookups are real objects: `v1/last-hour/DEU` is written alongside
`v1/last-hour/DE` with identical content, since a bucket cannot map one to the
other the way `resolveCode()` does.

See [`DEV.md`](./DEV.md) for the bucket, custom domain, cache and rate-limit
setup.

**Self-hosting** — [`server.js`](./server.js) serves `data/` over Node with the
same routes, for local use or anywhere you would rather run a process. It is not
what production uses.

## Accuracy

`direct` on grids with a clean fuel-split feed is typically within ~5–15% of a
reference like Electricity Maps; grids with lumped thermal (e.g. Brazil, Japan)
drift more; the consumption figures are per-country delta proxies, not
flow-traced.
Good for a free, self-hosted signal — not a like-for-like EM replacement.

## License

**AGPL-3.0-or-later** © Fabio Cicerchia. See [`LICENSE`](./LICENSE) and
[`NOTICE`](./NOTICE). Because this is a network service, AGPL §13 applies: if you
run a **modified** version so users interact with it over a network, you must
offer them its complete corresponding source. Data attributions: OWID/Ember
(CC-BY 4.0); electricitymaps-contrib (source catalogue, partially compiled from
and cross-checked against it); IPCC AR6 (factors); ENTSO-E Transparency Platform
(CC BY 4.0, adapted); U.S. Energy Information Administration (generation data via
the EIA API). Intensity figures are computed here and are not published or
endorsed by those operators — see [`NOTICE`](./NOTICE).

## Make targets

`make help` lists them. Every repository in this estate exposes the same eight
verbs, so you do not have to read a Makefile to find out how to build or run it
(FC-GEN-057).

| Verb     | What it does here                                          |
| -------- | ---------------------------------------------------------- |
| `build`  | `npm run pipeline:offline` — `data/` from the snapshot     |
| `run`    | `npm run serve` — the Node server on `PORT` (default 8000) |
| `test`   | `npm test` — `node:test`                                   |
| `lint`   | biome, at the version the Makefile pins                    |
| `format` | the same biome, writing instead of complaining             |

Beyond the eight: `sync` runs the live pipeline and pushes `data/` to the
bucket, and `verify` checks every provider still answers as the pipeline
expects. The history backfill and the estimator backtest are maintenance jobs
that operate on published data, so they live with it, in the deployment repo.

### Not applicable

Three verbs have nothing to do here. They exit 0 and say why rather than
pretending to work (FC-GEN-058):

- `setup` — Node >= 20 is the only requirement, and there is no pre-commit
  config in this repo.
- `install` — `package.json` declares no dependencies and no dev dependencies,
  on purpose.
- `analyze` — nothing to scan for dependency vulnerabilities. There are no
  dependencies, and CI for this code runs from the deployment repo, which
  checks this repo out as a submodule.
