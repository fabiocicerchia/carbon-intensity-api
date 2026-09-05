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
      description: "Whether `points` reached `points_expected`. Always true on /past-hour.",
    },
    ...figureProps(),
    basis: { type: "string", enum: ["measured"] },
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
    "date, not an error; for an hourly route it means that code has no live " +
    "provider. `/v2/countries.json` says which do.",
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
          "The newest hour holding all of its points. Immutable once published. Absent (404) until a complete hour exists in the provider's window.",
        tags: ["country"],
        params: ["code"],
        ref: "HourReading",
        okText: "A complete hour. `complete` is always true.",
      }),
      "/v2/{code}/current-hour": op({
        summary: "Hour in progress",
        description:
          "The newest hour with any data. Changes between runs as the rest of the hour arrives, so `complete` is usually false and `period_end` is in the future.",
        tags: ["country"],
        params: ["code"],
        ref: "HourReading",
        okText: "The hour in progress.",
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
                    description: "Whether the hourly routes answer for this country.",
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
