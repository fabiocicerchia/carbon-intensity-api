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

Compute happens **once**, in [`sync.sh`](./sync.sh), which runs the pipeline and
writes `data/` (a combined `latest.json` plus one file per country under
`data/v1/last-hour/`) before syncing it up. The bucket only **serves** those
files — nothing recomputes them, they go out verbatim. This keeps a single,
auditable source of truth and avoids double computation.

```
./sync.sh  ──compute──▶  data/ (commit for audit)  ──sync──▶  bucket ──serve──▶ CDN ──▶ clients
```

Run it by hand, or from cron for the hourly cadence the readings assume.

## Endpoints

Lookups are path-based — the bucket is served directly, so there is nothing in
the request path to read a query string.

### v2 — use this

| Path | Returns |
|------|---------|
| `/v2/<CODE>/past-hour` | The last **completed** clock hour: the mean of every point in it. Immutable once published. |
| `/v2/<CODE>/current-hour` | The hour **in progress**: the mean of the points so far. Moves between runs. |
| `/v2/<CODE>/history/<YYYY-MM-DD>` | One UTC day of hourly means. |
| `/v2/<CODE>/yearly` | The annual average. Every country has one. |
| `/v2/<CODE>/<ZONE>/…` | The same three hourly routes for a bidding zone / balancing region — `/v2/IT/SICI/past-hour` |
| `/v2/countries.json` | Every country: metadata, zones, realtime availability **and** annual figures |
| `/v2/past-hour.json` | The measured countries' last completed hour, in one document |
| `/v2/openapi.json` | The contract, generated from the same data the API serves |

**Path grammar:** an UPPERCASE segment is a code, a lowercase-hyphenated one is
a resource. So `/v2/IT/SICI/past-hour` reads unambiguously as country, zone,
resource, and a zone is simply the next code down rather than needing a `zones/`
marker. ISO-2 only in v2 — the ISO-3 aliases are a v1 feature.

**Coverage.** The hourly routes exist only where a provider publishes live
generation. Everything else 404s, rather than serving a yearly constant under a
name that promises an hour:

| | `/yearly` | `/past-hour`, `/current-hour`, `/history` |
|---|---|---|
| countries with a live provider | yes | yes |
| countries without one | yes | **404** |
| zones | **404** | yes |

Zones have no annual figure because the annual dataset is country-level — the
same reason they are measured-only.

`/past-hour` additionally needs a **complete** hour — one holding all
`points_expected` of its points. How quickly that happens depends on how much
the provider hands over per call: ENTSO-E returns three hours at a time and IESO
the whole delivery day, so their hours complete as soon as they are over. A
provider that publishes one snapshot per call (OpenNEM, EMC, Eskom, ONS) reports
`resolution_sec: 3600`, so one point completes its hour — for those, `complete`
means "everything this provider gives for that hour", not "four samples".

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
  when the hour is written. Do not recompute it client-side.
- Zone documents carry `direct` and `lifecycle` only.
- **A closed day never changes again**, so it is safe to cache indefinitely.
- Treat a 404 for a date as *no data for that date*, not an error.

**Check the status code before parsing the body as JSON.** Depending on what
sits in front of the bucket, a 404 or a rate-limit response is likely to be HTML
or plain text rather than JSON — those are the edge's own responses, not this
API's. Feeding them to a JSON parser is the most likely way to break a client.

### v1 — frozen

Still served, still refreshed every run, unchanged in shape. It will be removed;
prefer v2 for anything new.

| Path | Returns |
|------|---------|
| `/v1/last-hour/<CODE>` | Newest **data point** for one country (ISO-2 or ISO-3) |
| `/v1/zones/<CODE>/<ZONE>` | Same for a bidding zone / balancing region — `IT/SICI`, `SE/SE3`, `US/TEX`, `AU/NSW1` |
| `/v1/latest.json` | All countries in one snapshot |
| `/v1/countries` | Supported countries (with `realtime_available`, `zones` + data source) |
| `/` | HTML landing page |

`/v1/last-hour/` does not return an hour. It returns the newest point the
operator published, which is 15 minutes wide for ENTSO-E and an hour for EIA —
the name predates the providers moving to sub-hourly resolution. `hour_start`
and `hour_end` are that point's own bounds. v2's `period_start`/`period_end` are
always a true clock hour, with `resolution_sec` saying how wide the underlying
points were.

Each reading embeds its `data_source` (operator, URL, status), so a separate
sources endpoint isn't needed.

### Migrating

| v1 | v2 |
|----|----|
| `/v1/last-hour/IT` | `/v2/IT/current-hour` (partial, live) or `/v2/IT/past-hour` (complete) |
| `/v1/zones/IT/SICI` | `/v2/IT/SICI/current-hour` |
| `/v1/latest.json` | `/v2/countries.json` for the static picture, `/v2/past-hour.json` for live |
| `/v1/countries` | `/v2/countries.json` — same fields plus the four annual figures |
| `hour_start` / `hour_end` | `period_start` / `period_end` (+ `resolution_sec`) |
| annual figure via `/v1/last-hour/<CODE>` | `/v2/<CODE>/yearly` |

The four figures are the corners of two axes — scope (combustion only vs plus
upstream) and boundary (generated here vs consumed here):

|                     | Production-based | Consumption-based       |
|---------------------|------------------|-------------------------|
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
freshness at request time. Derive it from `generated_at` — the pipeline is meant
to run hourly, so more than ~65 minutes old means a refresh was missed — and from
`basis`, since `annual-average` is never a reading for the hour you asked for.
Note the age test binds **only** measured readings: annual ones carry
`hour_start: null`, are rewritten weekly rather than hourly, and an old
`generated_at` on one is expected:

```js
const stale = (Date.now() - Date.parse(r.generated_at)) > 3900e3
  || r.basis !== "measured";
```

Rate-limited to **1 request per 10s per IP**, returning `429` beyond that. It is
a CDN/WAF rule — there is no application code to put a limiter in. See
[`DEV.md`](./DEV.md).

Zones exist only where the provider publishes below national level: the ENTSO-E
bidding zones (IT, SE, NO, DK), the EIA-930 regions *and* balancing authorities
(US — `US/TEX` for the region, `US/ERCO` for ERCOT inside it), and the NEM
regions plus WEM (AU). They are **measured-only** — the annual dataset is
country-level, so a
zone with nothing stored and nothing live returns 404 rather than falling back.
They also omit both consumption figures, whose import adjustment is a national
figure that does not describe a single zone.

A zone whose provider fails is absent from that hour's snapshot and is dropped
from the bucket by the sync, so it 404s until a later run picks it up again —
nothing re-checks the provider at request time. Zone endpoints therefore come
and go with provider availability, by design.

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

| Provider | Countries | Token |
|----------|-----------|-------|
| UK NESO | `GB` | none |
| ONS | `BR` | none |
| OpenNEM / OpenElectricity | `AU` | none |
| EMC | `SG` | none |
| Eskom | `ZA` | none |
| ENTSO-E | ~38 European zones (incl. `LU`, `MK`, `BY`) | `ENTSOE_TOKEN` |
| EIA | `US` | `EIA_TOKEN` |

Set tokens in the environment you run the pipeline in (they're only needed there).
Mexico has no provider — CENACE publishes generation by technology only as a
monthly settled export, so there is no hourly feed to read. Countries without a provider — or when a fetch fails —
fall back to the annual snapshot.

## Deploy

Nothing runs at request time. [`sync.sh`](./sync.sh) writes `data/` and pushes it
into an S3-compatible bucket, served directly on a custom domain behind a CDN.
Any provider will do; `S3_BUCKET` and `S3_ENDPOINT` pick it.

**Keys have no extension** — `v1/last-hour/DE`, not `DE.json` — because a bucket
matches an exact key and `/v1/last-hour/DE` is the published URL. See
[`DEV.md`](./DEV.md) for the full key layout, cache headers and rate-limit rule.

**Self-hosting** — [`server.js`](./server.js) serves `data/` over Node with the
same routes (`PORT`, `DATA_DIR`), for local use or anywhere you would rather run
a process. It is not what production uses.

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
