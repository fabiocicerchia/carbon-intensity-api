// The v2 OpenAPI document, generated from the same data the pipeline serves.
//
// Generated rather than hand-written for one reason: the country and zone lists
// are the parts most worth having in a spec and the parts most certain to rot.
// Deriving them from COUNTRIES and ZONES means a dataset change updates the
// contract in the same commit that changes the data.
//
// Deliberately carries no timestamp. The spec describes the shape of the API,
// which does not change every twenty minutes, so leaving `generated_at` out
// keeps the object byte-identical between runs and out of the commit log.

import PKG from "../package.json" with { type: "json" };
import { COUNTRIES } from "./data.js";
import { ZONES, zonesFor } from "./live.js";

const SERVER = "https://ci-api.fabiocicerchia.it";
const SECONDS_PER_HOUR = 3600;

const ATTRIBUTION_SCHEMA = {
  type: "object",
  description: "Who computed the figure. Present on every document.",
  properties: {
    name: { type: "string" },
    author: { type: "string" },
    url: { type: "string", format: "uri" },
    repository: { type: "string", format: "uri" },
    license: { type: "string" },
  },
};

const DATA_SOURCE_SCHEMA = {
  type: "object",
  description:
    "Whose generation data the figure was computed from. Never the publisher of " +
    "the intensity itself — see `methodology`.",
  properties: {
    name: { type: "string", example: "ENTSO-E" },
    url: { type: "string", format: "uri" },
    realtime: { type: "boolean" },
    status: { type: "string" },
    ref: { type: "string", nullable: true },
  },
};

const FIGURES = {
  direct: "Operational emissions of the generation itself.",
  lifecycle: "`direct` plus upstream and embodied emissions.",
  consumption_direct: "`direct` adjusted for imports and exports. Countries only.",
  consumption_lifecycle: "Both adjustments. The most modelled of the four and the one to report. Countries only.",
};

function figureProps(zone = false) {
  const out = {};
  for (const [name, description] of Object.entries(FIGURES)) {
    if (zone && name.startsWith("consumption_")) continue;
    out[name] = { type: "integer", description };
  }
  return out;
}

const HOUR_READING = {
  type: "object",
  description:
    "One clock hour. `period_start`/`period_end` are always exactly an hour apart " +
    "and aligned to the hour, unlike v1's `hour_start`/`hour_end`, which were one " +
    "provider data point wide.",
  properties: {
    country: { type: "string" },
    country_code: { type: "string" },
    zone: { type: "string", description: "The zone code, or the country code for a country reading." },
    unit: { type: "string", enum: ["gCO2eq/kWh"] },
    period_start: { type: "string", format: "date-time" },
    period_end: { type: "string", format: "date-time" },
    resolution_sec: {
      type: "integer",
      description:
        "How wide the underlying provider points are. 900 for ENTSO-E, 1800 for " +
        "NESO, 3600 for a provider that publishes one snapshot per call.",
    },
    points: { type: "integer", description: "How many provider points the mean covers." },
    points_expected: { type: "integer", description: "`3600 / resolution_sec`." },
    complete: {
      type: "boolean",
      description:
        "Whether `points` reached `points_expected`. True on a measured /past-hour, " +
        "and false on an estimated one, which rests on no provider points at all.",
    },
    ...figureProps(),
    basis: {
      type: "string",
      enum: ["measured", "estimated"],
      description:
        "`measured` — computed from the mix the feed published for this hour. " +
        "`estimated` — the feed had not published this hour, so it was modelled " +
        "from the newest hour it did publish and this grid's own recent shape. " +
        "An estimate carries an `estimate` block and `points: 0`; /latest is " +
        "never estimated.",
    },
    estimate: {
      type: "object",
      description:
        "Present only when `basis` is `estimated`. The figure is this API's, not " +
        "the feed's, and `data_source` says so — `from_source` names the feed " +
        "whose history it was modelled from.",
      properties: {
        method: { type: "string", enum: ["diurnal-profile-anchored"] },
        anchor_hour: {
          type: "string",
          format: "date-time",
          description:
            "The newest hour the feed actually published — complete or not, since a " +
            "partly filled hour is still a measurement and is an hour closer to the " +
            "target, which shortens the extrapolation.",
        },
        anchor_complete: {
          type: "boolean",
          description:
            "False when the anchor hour was only partly published: its mean covers " +
            "just the part that arrived, while the ratio is taken against a " +
            "full-hour profile.",
        },
        hours_ahead: {
          type: "integer",
          description:
            "How far past the anchor this hour is. Bounded: wind is weather, the " +
            "anchor is what carries it, and that stops holding within a few " +
            "hours. Beyond the bound the route 404s instead.",
        },
        max_hours: {
          type: "integer",
          description:
            "The horizon actually applied this run — the larger of the country's " +
            "backtested figure and how far behind its provider is publishing, " +
            "capped at six. A feed three hours behind has to be reached across " +
            "three hours for /current-hour to exist at all, so the lag lifts the " +
            "horizon rather than the route disappearing.",
        },
        backtested_max_hours: {
          type: "integer",
          description:
            "How far this country's estimates were measured to stay within the " +
            "error bound (p90 within 30% or 20 gCO2eq/kWh). Where `hours_ahead` " +
            "exceeds it, the estimate was stretched to cover provider lag and is " +
            "outside what the backtest verified — filter on this to keep only " +
            "the estimates inside the measured bound.",
        },
        profile_days: { type: "integer" },
        profile_samples: {
          type: "integer",
          description: "Same-hour, same-day-type observations behind the shape used.",
        },
        from_source: { type: ["string", "null"] },
      },
    },
    generated_at: { type: "string", format: "date-time" },
    data_source: DATA_SOURCE_SCHEMA,
    data_year: { type: "integer" },
    methodology: { type: "string" },
    attribution: ATTRIBUTION_SCHEMA,
  },
};

const HISTORY_DAY = {
  type: "object",
  description:
    "One UTC day of hourly means, columnar. Every array is index-aligned to the " +
    "hour beginning `start + i*3600`. A missing hour is null and PRESENT — " +
    "dropping it would slide every later value into the wrong hour. Today's " +
    "document is truncated at the last hour seen; a closed day has 24 entries " +
    "and never changes again.",
  properties: {
    country_code: { type: "string" },
    zone: { type: "string" },
    unit: { type: "string", enum: ["gCO2eq/kWh"] },
    basis: { type: "string", enum: ["measured"] },
    date: { type: "string", format: "date" },
    start: { type: "string", format: "date-time", description: "Always midnight UTC." },
    step_sec: { type: "integer", enum: [SECONDS_PER_HOUR] },
    direct: { type: "array", items: { type: "integer", nullable: true } },
    lifecycle: { type: "array", items: { type: "integer", nullable: true } },
    consumption_direct: {
      type: "array",
      items: { type: "integer", nullable: true },
      description: "Countries only; absent on zone documents.",
    },
    consumption_lifecycle: {
      type: "array",
      items: { type: "integer", nullable: true },
      description: "Countries only; absent on zone documents.",
    },
    points: {
      type: "array",
      items: { type: "integer", nullable: true },
      description: "How many provider points each hour's mean covers.",
    },
    complete: {
      type: "array",
      items: { type: "boolean", nullable: true },
      description:
        "Decided per hour when the hour is written, against that hour's own " +
        "resolution. There is deliberately no day-level `resolution_sec` or " +
        "`points_expected`: a provider can change granularity mid-day, so a " +
        "single day-wide constant would mislabel every hour on one side of the " +
        "switch. Do not recompute this client-side.",
    },
    generated_at: { type: "string", format: "date-time" },
    attribution: ATTRIBUTION_SCHEMA,
  },
};

const YEARLY_READING = {
  type: "object",
  description: "The annual average. Every country has one, measured or not.",
  properties: {
    country: { type: "string" },
    country_code: { type: "string" },
    unit: { type: "string", enum: ["gCO2eq/kWh"] },
    basis: { type: "string", enum: ["annual-average"] },
    data_year: { type: "integer" },
    ...figureProps(),
    estimated: { type: "boolean" },
    generated_at: { type: "string", format: "date-time" },
    data_source: DATA_SOURCE_SCHEMA,
    methodology: { type: "string" },
    attribution: ATTRIBUTION_SCHEMA,
  },
};

const NOT_JSON = {
  description:
    "No data. Served by the edge as HTML, NOT as JSON — check the status code " +
    "before parsing the body. For a history date this means no data for that " +
    "date, not an error; for an hourly route it means there is no such hour to " +
    "serve — either the code has no live provider at all, or its provider has " +
    "not published one recently enough. `/v2/countries.json` carries `routes` " +
    "and `data_lag_seconds` per country, which say which of the three answer " +
    "and how far behind that country's feed is running.",
  content: { "text/html": { schema: { type: "string" } } },
};

const RATE_LIMITED = {
  description:
    "Rate limited: 10 requests per 10 seconds per IP. The body is `text/plain` " +
    "(`error code: 1015`), not JSON — Cloudflare's own block page, which the " +
    "free plan cannot customise. Check the status before parsing.",
  content: { "text/plain": { schema: { type: "string" } } },
};

function ok(ref, description) {
  return {
    description,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } },
  };
}

const COMMON_ERRORS = {
  404: { $ref: "#/components/responses/NotFound" },
  429: { $ref: "#/components/responses/RateLimited" },
};

function op({ summary, description, tags, params, ref, okText }) {
  return {
    get: {
      summary,
      description,
      tags,
      parameters: params.map((p) => ({ $ref: `#/components/parameters/${p}` })),
      responses: { 200: ok(ref, okText), ...COMMON_ERRORS },
    },
  };
}

export function buildSpec({ version = PKG.version } = {}) {
  const codes = Object.keys(COUNTRIES).sort();
  const allZones = [...new Set(Object.keys(ZONES).flatMap((c) => zonesFor(c)))].sort();

  return {
    openapi: "3.0.3",
    info: {
      title: "Carbon Intensity API",
      version,
      description:
        "Grid carbon intensity by country and bidding zone, as static JSON.\n\n" +
        "Every route is an unauthenticated GET of a fixed key: the bucket is served " +
        "directly with nothing in the request path, so there are no query strings " +
        "and a date is a path segment.\n\n" +
        "**Path grammar.** An UPPERCASE segment is a code and a lowercase-hyphenated " +
        "one is a resource, which is what lets `/v2/IT/SICI/past-hour` be read as " +
        "country, zone, resource without a `zones/` marker.\n\n" +
        "**Coverage.** Every country answers on `/yearly`. The hourly routes exist " +
        "only where a provider publishes live generation — everything else 404s " +
        "rather than serving a yearly constant under a name promising an hour. The " +
        "measured set changes as providers come and go, so it is not enumerable " +
        "here; read `realtime_available` from `/v2/countries.json`.\n\n" +
        "**Staleness** is the caller's to derive, from `generated_at` and `basis`. " +
        "Nothing evaluates freshness at request time because nothing runs at request " +
        "time.",
      license: { name: "AGPL-3.0-or-later", url: "https://www.gnu.org/licenses/agpl-3.0.html" },
      contact: { name: "Source", url: "https://github.com/fabiocicerchia/carbon-intensity-api" },
    },
    servers: [{ url: SERVER }],
    tags: [
      { name: "country", description: "One country." },
      {
        name: "zone",
        description: `Bidding zones and balancing regions, for the ${Object.keys(ZONES).length} countries that publish below national level.`,
      },
      { name: "bulk", description: "Every country in one request." },
    ],
    paths: {
      "/v2/{code}/yearly": op({
        summary: "Annual average for one country",
        description:
          "Available for every country. Rewritten at most weekly, so `generated_at` moves rarely — correct for a figure that changes once a year.",
        tags: ["country"],
        params: ["code"],
        ref: "YearlyReading",
        okText: "The annual average.",
      }),
      "/v2/{code}/past-hour": op({
        summary: "Last completed clock hour",
        description:
          "The newest hour holding all of its points. Immutable once published. Absent (404) whenever no such hour exists — until the provider has published a complete one, and again on the very next run once it stops. Nothing is held back during an outage and the route will not reach back more than a few hours for an older complete hour; `/latest` is what carries a reading across a gap.",
        tags: ["country"],
        params: ["code"],
        ref: "HourReading",
        okText: "A complete hour. `complete` is always true.",
      }),
      "/v2/{code}/current-hour": op({
        summary: "Hour in progress",
        description:
          "The newest hour with any data. Changes between runs as the rest of the hour arrives, so `complete` is usually false and `period_end` is in the future. 404s on the next run if the provider stops answering, rather than being held back — use `/latest` for the last reading across a gap.",
        tags: ["country"],
        params: ["code"],
        ref: "HourReading",
        okText: "The hour in progress.",
      }),
      "/v2/{code}/latest": op({
        summary: "Newest hour with data, however old",
        description:
          "The newest hour the provider has published, with no bound on its age — " +
          "read `period_start` and `generated_at` to see how old it is. The two " +
          "routes above are named for particular clock hours and mean them, so " +
          "they 404 when the provider has not published one; this route answers " +
          "for feeds that run a day or more behind by design, where it is the " +
          "only reading there is. Identical in shape to `/current-hour`.",
        tags: ["country"],
        params: ["code"],
        ref: "HourReading",
        okText: "The newest hour the provider has published.",
      }),
      "/v2/{code}/history/{date}": op({
        summary: "One UTC day of hourly means",
        description:
          "Retained for 365 days. A day whose date is in the past will never be rewritten and is safe to cache indefinitely.",
        tags: ["country"],
        params: ["code", "date"],
        ref: "HistoryDay",
        okText: "One day, columnar.",
      }),
      "/v2/{code}/{zone}/past-hour": op({
        summary: "Last completed clock hour for a zone",
        description:
          "Zone documents omit both consumption figures: the import adjustment is a national figure and one bidding zone's import mix is not the country's.",
        tags: ["zone"],
        params: ["code", "zone"],
        ref: "HourReading",
        okText: "A complete hour for the zone.",
      }),
      "/v2/{code}/{zone}/current-hour": op({
        summary: "Hour in progress for a zone",
        description:
          "A zone whose provider failed this run is absent until the next one — treat a zone 404 as *ask the country instead*.",
        tags: ["zone"],
        params: ["code", "zone"],
        ref: "HourReading",
        okText: "The hour in progress for the zone.",
      }),
      "/v2/{code}/{zone}/latest": op({
        summary: "Newest hour with data for a zone, however old",
        description: "As the country route: unbounded in age, and the only reading for a slow feed.",
        tags: ["zone"],
        params: ["code", "zone"],
        ref: "HourReading",
        okText: "The newest hour for the zone.",
      }),
      "/v2/{code}/{zone}/history/{date}": op({
        summary: "One UTC day of hourly means for a zone",
        description: "As the country route, without the consumption arrays.",
        tags: ["zone"],
        params: ["code", "zone", "date"],
        ref: "HistoryDay",
        okText: "One day for the zone, columnar.",
      }),
      "/v2/countries.json": {
        get: {
          summary: "The catalogue: every country, its metadata and its annual figures",
          description:
            "One static document rather than a country list and a separate figures " +
            "file: an annual average is a property of a country like its zones. " +
            "`realtime_available` tells you whether the hourly routes will answer.",
          tags: ["bulk"],
          responses: { 200: ok("CountriesDocument", `All ${codes.length} countries.`), 429: COMMON_ERRORS[429] },
        },
      },
      "/v2/past-hour.json": {
        get: {
          summary: "Last completed hour for every measured country",
          description:
            "The bulk form of `/v2/{code}/past-hour`, for cross-country comparison " +
            "without one request per country. There is deliberately no bulk " +
            "`current-hour`: completeness varies by provider, so a table of " +
            "hours-in-progress would compare a finished hour against a quarter of one.",
          tags: ["bulk"],
          responses: { 200: ok("PastHourDocument", "Every country with a complete hour."), 429: COMMON_ERRORS[429] },
        },
      },
    },
    components: {
      parameters: {
        code: {
          name: "code",
          in: "path",
          required: true,
          description: "ISO 3166-1 alpha-2. v2 has no alpha-3 aliases; v1 does.",
          schema: { type: "string", enum: codes },
        },
        zone: {
          name: "zone",
          in: "path",
          required: true,
          description:
            "Bidding zone or balancing region. The enum lists every zone across all " +
            "countries, so it over-permits — `IT/NO1` validates and 404s. Read the " +
            "`zones` array in /v2/countries.json for the pairs that exist.",
          schema: { type: "string", enum: allZones },
        },
        date: {
          name: "date",
          in: "path",
          required: true,
          description: "UTC day, `YYYY-MM-DD`. Retained for 365 days.",
          schema: { type: "string", format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          example: "2026-08-27",
        },
      },
      responses: { NotFound: NOT_JSON, RateLimited: RATE_LIMITED },
      schemas: {
        HourReading: HOUR_READING,
        HistoryDay: HISTORY_DAY,
        YearlyReading: YEARLY_READING,
        CountriesDocument: {
          type: "object",
          properties: {
            count: { type: "integer" },
            generated_at: { type: "string", format: "date-time" },
            attribution: ATTRIBUTION_SCHEMA,
            countries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  country_code: { type: "string" },
                  country: { type: "string" },
                  zone: { type: "string" },
                  source: { type: "string" },
                  data_year: { type: "integer" },
                  realtime_available: {
                    type: "boolean",
                    description:
                      "Whether a live provider exists for this country. It does not " +
                      "promise that every hourly route answers — read `routes` for that.",
                  },
                  provider: {
                    type: ["string", "null"],
                    description:
                      "The feed behind the hourly routes: ENTSO-E, EIA, NESO, ONS, " +
                      "OpenNEM, EMC, Eskom, IESO. Null where there is none and only " +
                      "`/yearly` answers.",
                  },
                  routes: {
                    type: "array",
                    items: { type: "string", enum: ["past-hour", "current-hour", "latest"] },
                    description:
                      "Which hourly routes answered as of `generated_at` — the list to " +
                      "check before requesting one. It is a property of how far behind " +
                      "the provider is publishing, not of the country, so it moves: a " +
                      "feed running a day behind carries `latest` alone, a live one " +
                      "carries all three, and a country whose provider is down carries " +
                      "none. Zones are not covered here; ask the zone route directly.",
                  },
                  data_lag_seconds: {
                    type: ["integer", "null"],
                    description:
                      "How far behind `generated_at` the newest hour this country has " +
                      "is — measured to the end of that hour, so a live feed sits near " +
                      "zero. Observed this run, not a guarantee: it moves with the " +
                      "provider. Null where nothing has been published at all.",
                  },
                  stale: {
                    type: "boolean",
                    description:
                      "True when `data_lag_seconds` is past the bound the hour-named " +
                      "routes are held to, so `/past-hour` and `/current-hour` do not " +
                      "answer and only `/latest` does. Treat the figures as a recent " +
                      "reading rather than a current one, and read `period_start` " +
                      "before using them for anything time-sensitive.",
                  },
                  providers: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "The feed chain, primary first. `data_source.name` on an hourly document says which one actually replied.",
                  },
                  redundancy: {
                    type: "string",
                    enum: ["none", "independent"],
                    description:
                      "`independent` — a second feed with its own path to the meters, " +
                      "covering the primary going down for any reason. `none` — one " +
                      "feed, or none. There is no middle value on purpose: a feed " +
                      "that re-publishes the primary goes down with it, so it is not " +
                      "configured as a fallback at all rather than counted as partial " +
                      "cover.",
                  },
                  zones: { type: "array", items: { type: "string" } },
                  ...figureProps(),
                },
              },
            },
          },
        },
        PastHourDocument: {
          type: "object",
          description:
            "`unit`, `methodology` and `attribution` are identical for every entry " +
            "and sit in the envelope once; entries carry only what varies.",
          properties: {
            count: { type: "integer" },
            generated_at: { type: "string", format: "date-time" },
            unit: { type: "string", enum: ["gCO2eq/kWh"] },
            methodology: { type: "string" },
            attribution: ATTRIBUTION_SCHEMA,
            countries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  country_code: { type: "string" },
                  period_start: { type: "string", format: "date-time" },
                  period_end: { type: "string", format: "date-time" },
                  ...figureProps(),
                  points: { type: "integer" },
                  complete: { type: "boolean" },
                  source: { type: "string", description: "Which provider the figure came from." },
                },
              },
            },
          },
        },
      },
    },
  };
}
