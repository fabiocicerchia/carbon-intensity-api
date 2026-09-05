// Data layer: bundled annual snapshot + source registry, plus the last-hour
// reading builder. Data is bundled as JSON, so there is nothing to load.

import COUNTRIES_RAW from "./datasets/countries.json" with { type: "json" };
import CURATED_DELTAS from "./datasets/curated-deltas.json" with { type: "json" };
import SOURCES from "./datasets/sources.json" with { type: "json" };
import { pointsPerHour, zonesFor } from "./live.js";

const SOURCE = "Ember; Energy Institute (via OWID)";

// Names the computation as ours. `data_source` says whose generation data went
// in, and a reader could otherwise take the operator to have published the
// intensity itself — which none of them did, and which EIA's API terms
// specifically forbid claiming ("you may not modify or falsely represent
// content accessed through the API and still claim the source is the EIA").
//
// Hoisted out of lastHour() when v2's routes started emitting it too: three
// copies of a legal notice is three chances for them to drift apart.
export const METHODOLOGY =
  "Intensity computed by Carbon Intensity API from the data_source's " +
  "published generation mix; IPCC AR6 lifecycle factors; ECON-PowerCI " +
  "consumption accounting. Not published by, or endorsed by, the data source.";

// Project attribution, embedded in the served JSON so consumers can trace the
// data back to its home.
export const ATTRIBUTION = {
  name: "Carbon Intensity API",
  author: "Fabio Cicerchia",
  url: "https://ci-api.fabiocicerchia.it",
  repository: "https://github.com/fabiocicerchia/carbon-intensity-api",
  license: "AGPL-3.0-or-later",
};

// Modelled lifecycle uplift over operational intensity (~5% fuel-supply +
// ~25 gCO2/kWh embodied floor) for countries without a curated figure.
const FUEL_SUPPLY_UPLIFT = 0.05;
const EMBODIED_FLOOR_G = 25;
// "YYYY-MM-DDTHH" -- an ISO timestamp truncated to its hour.
const ISO_HOUR_PREFIX_LENGTH = 13;
const SECONDS_PER_HOUR = 3600;
const MS_PER_SECOND = 1000;
const MS_PER_HOUR = SECONDS_PER_HOUR * MS_PER_SECOND;

function modelledLifecycleDelta(direct) {
  return Math.round(direct * FUEL_SUPPLY_UPLIFT + EMBODIED_FLOOR_G);
}

// Curated [lifecycle_delta, consumption_delta] over the operational `direct`
// value, for the subset with IPCC AR6 / documented trade figures, lives in
// datasets/curated-deltas.json. It is hand-maintained -- unlike countries.json
// and sources.json beside it, which are regenerated from their .csv.

// Build the country table keyed by ISO2.
export const COUNTRIES = {};
for (const rec of COUNTRIES_RAW) {
  const curated = CURATED_DELTAS[rec.code];
  const lifeDelta = curated ? curated[0] : modelledLifecycleDelta(rec.direct);
  const consDelta = curated ? curated[1] : lifeDelta;
  COUNTRIES[rec.code] = {
    name: rec.name,
    iso3: rec.iso3,
    direct: rec.direct,
    lifecycleDelta: lifeDelta,
    consumptionDelta: consDelta,
    dataYear: rec.data_year,
    curated: Boolean(curated),
  };
}

const ISO3_INDEX = {};
for (const [code, rec] of Object.entries(COUNTRIES)) ISO3_INDEX[rec.iso3] = code;

export class UnknownCountry extends Error {}

// A known zone whose provider returned nothing this hour. Distinct from an
// unknown zone: the endpoint exists, the data does not.
export class ProviderlessZone extends Error {}

// ISO-3166 alpha-2 (canonical) or alpha-3. Country names are deliberately not
// accepted: the alias table they needed was English-only and never complete,
// and they gave every country several URLs with no canonical one.
export function resolveCode(country) {
  if (!country || !String(country).trim()) throw new UnknownCountry("country must not be empty");
  const upper = String(country).trim().toUpperCase();
  if (COUNTRIES[upper]) return upper;
  if (ISO3_INDEX[upper]) return ISO3_INDEX[upper];
  throw new UnknownCountry(country);
}

export function sourceFor(code) {
  return SOURCES[code.toUpperCase()] || { name: null, url: null, realtime: false, status: "none", ref: null };
}

// Provenance of the bundled annual snapshot. Most countries have no realtime
// provider, so for them this is the only attribution the reading carries —
// Ember and the Energy Institute both require credit.
const ANNUAL_SOURCE = {
  name: SOURCE,
  url: "https://ourworldindata.org/grapher/carbon-intensity-electricity",
  realtime: false,
  status: "annual-average",
  ref: null,
};

// Build the last-hour reading for `country`. `measured` (optional) is a
// provider reading { direct, hour_start, hour_end, source }.
// `zone` names a sub-country bidding zone or balancing region. Zone readings
// are measured-only: the annual dataset is country-level, so there is no
// per-zone number to fall back to, and the caller must supply `measured`.
export function lastHour(country, { measured = null, zone = null } = {}) {
  const code = resolveCode(country);
  const rec = COUNTRIES[code];
  if (zone && !(measured && measured.direct != null)) {
    throw new ProviderlessZone(`${code}/${zone}`);
  }

  // `data_source` describes where THIS reading came from, so it tracks the
  // branch taken below: the live provider when measured, the annual dataset
  // otherwise. It used to always name the registry's realtime provider, which
  // reported `realtime: true` on readings that were nothing of the sort.
  let direct, hourStart, hourEnd, dataSource, basis;
  if (measured && measured.direct != null) {
    direct = Math.round(measured.direct);
    hourStart = measured.hour_start;
    hourEnd = measured.hour_end;
    dataSource = { ...sourceFor(code), name: measured.source ?? sourceFor(code).name };
    basis = "measured";
  } else {
    // Null rather than the last completed hour: an annual average describes no
    // particular hour, and stamping one asserted a precision the figure does
    // not have — it also churned every annual country's file every hour for
    // three timestamps that could not mean anything.
    direct = rec.direct;
    hourStart = null;
    hourEnd = null;
    dataSource = ANNUAL_SOURCE;
    basis = "annual-average";
  }

  // Two independent axes: scope (`direct` -> `lifecycle`, adds upstream) and
  // boundary (`direct` -> `consumption_direct`, adds imports). All four
  // combinations are published; the suffix on the consumption pair says which
  // scope each is on, because the trade-adjusted operational figure is the
  // larger number for an importing country and was being read as the most
  // complete one.
  //
  // Omitted for zones rather than inherited: the import adjustment is a national
  // figure, and Sicily's import mix is not Italy's. `lifecycle` is a
  // generation-technology uplift, so it does carry over.
  return {
    country: rec.name,
    country_code: code,
    // A country reading's `zone` just repeats country_code, but it is always
    // present so a client can read one field whether or not it asked for a zone.
    zone: zone || code,
    hour_start: hourStart,
    hour_end: hourEnd,
    unit: "gCO2eq/kWh",
    direct,
    lifecycle: direct + rec.lifecycleDelta,
    ...(zone
      ? {}
      : {
          consumption_direct: direct + rec.consumptionDelta,
          // The fourth cell. Both deltas are defined over the operational value and
          // describe different things — upstream emissions per kWh generated, and
          // the trade adjustment to operational intensity — so summing them is not
          // double counting. The assumption is that imported power carries a
          // similar upstream intensity per kWh to domestic generation, since the
          // uplift is derived from the domestic mix and applied to the consumed
          // one. The most modelled of the four, and the one to report.
          consumption_lifecycle: direct + rec.consumptionDelta + rec.lifecycleDelta,
        }),
    basis,
    data_source: dataSource,
    data_year: rec.dataYear,
    // Redundant with `basis` — kept because clients predate it and read this.
    // Derived rather than set in both branches above, so the two cannot drift.
    estimated: basis !== "measured",
    methodology: METHODOLOGY,
  };
}

// --- v2 -----------------------------------------------------------------------
// v1 asks a provider for "the reading" and gets whatever point happened to be
// newest. v2 asks for hours: `hourlyMeans` folds a provider series into per-UTC
// -hour means, and the two routes below pick one of those hours.

// -> [{ hour, direct, points, complete }], oldest first.
export function hourlyMeans(series) {
  if (!series?.points?.length) return [];
  const expected = pointsPerHour(series.resolution_sec);
  const byHour = new Map();
  for (const p of series.points) {
    // A point is assigned by where it STARTS: one starting 06:45 covers
    // 06:45-07:00 and belongs to hour 06, not 07.
    const hour = `${p.start.slice(0, ISO_HOUR_PREFIX_LENGTH)}:00:00Z`;
    if (!byHour.has(hour)) byHour.set(hour, []);
    byHour.get(hour).push(p.direct);
  }
  return [...byHour.keys()].sort().map((hour) => {
    const vals = byHour.get(hour);
    return {
      hour,
      direct: vals.reduce((a, b) => a + b, 0) / vals.length,
      points: vals.length,
      // Compared against the resolution of THIS series. Recomputed on every
      // write rather than stored once per day, so a provider changing
      // granularity part-way through a day cannot mislabel the hours before it.
      complete: vals.length >= expected,
    };
  });
}

// The newest hour that holds all its points. Null when the window contains no
// complete hour — the caller then writes nothing and the sync drops any stale
// copy, the same "absence signals no data" rule zones already follow.
export function pastHour(series) {
  const means = hourlyMeans(series);
  for (let i = means.length - 1; i >= 0; i -= 1) if (means[i].complete) return means[i];
  return null;
}

// The newest hour with any data at all, complete or not. This is the one that
// moves between runs as the rest of the hour arrives.
export function currentHour(series) {
  const means = hourlyMeans(series);
  return means.length ? means[means.length - 1] : null;
}

// Build a v2 hourly document from one entry of hourlyMeans().
export function hourDocument(country, mean, { series, zone = null } = {}) {
  const code = resolveCode(country);
  const rec = COUNTRIES[code];
  const direct = Math.round(mean.direct);
  const startMs = Date.parse(mean.hour);
  return {
    country: rec.name,
    country_code: code,
    zone: zone || code,
    unit: "gCO2eq/kWh",
    // Always a true clock hour, unlike v1's hour_start/hour_end which were one
    // provider data point wide — 15 minutes for ENTSO-E — under hour-shaped names.
    period_start: mean.hour,
    period_end: new Date(startMs + MS_PER_HOUR).toISOString().replace(/\.\d{3}Z$/, "Z"),
    resolution_sec: series.resolution_sec,
    points: mean.points,
    points_expected: pointsPerHour(series.resolution_sec),
    complete: mean.complete,
    direct,
    lifecycle: direct + rec.lifecycleDelta,
    ...(zone
      ? {}
      : {
          consumption_direct: direct + rec.consumptionDelta,
          consumption_lifecycle: direct + rec.consumptionDelta + rec.lifecycleDelta,
        }),
    basis: "measured",
    data_source: { ...sourceFor(code), name: series.source ?? sourceFor(code).name },
    data_year: rec.dataYear,
    methodology: METHODOLOGY,
  };
}

// The annual average as its own resource. Every country has one; no provider
// needed. This is the figure v1 served from /last-hour with null hour bounds —
// giving it an honestly-named route is the point of v2.
export function yearlyDocument(country) {
  const code = resolveCode(country);
  const rec = COUNTRIES[code];
  const direct = rec.direct;
  return {
    country: rec.name,
    country_code: code,
    unit: "gCO2eq/kWh",
    basis: "annual-average",
    data_year: rec.dataYear,
    direct,
    lifecycle: direct + rec.lifecycleDelta,
    consumption_direct: direct + rec.consumptionDelta,
    consumption_lifecycle: direct + rec.consumptionDelta + rec.lifecycleDelta,
    estimated: true,
    data_source: ANNUAL_SOURCE,
    methodology: METHODOLOGY,
  };
}

export function listCountries() {
  return Object.entries(COUNTRIES)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([code, rec]) => ({
      country_code: code,
      country: rec.name,
      // Both echo constants — `zone` the country code, `source` the annual
      // dataset — but they keep every entry the same shape as a reading.
      zone: code,
      source: SOURCE,
      data_year: rec.dataYear,
      realtime_available: sourceFor(code).realtime,
      zones: zonesFor(code),
    }));
}
