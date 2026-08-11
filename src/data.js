// Data layer: bundled annual snapshot + source registry, plus the last-hour
// reading builder. Data is bundled as JSON, so there is nothing to load.

import COUNTRIES_RAW from "./datasets/countries.json" with { type: "json" };
import SOURCES from "./datasets/sources.json" with { type: "json" };
import { zonesFor } from "./live.js";

const SOURCE = "Ember; Energy Institute (via OWID)";

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
function modelledLifecycleDelta(direct) {
  return Math.round(direct * 0.05 + 25);
}

// Curated (lifecycle_delta, consumption_delta) over the operational `direct`
// value, for the subset with IPCC AR6 / documented trade figures.
const CURATED_DELTAS = {
  AT: [48, 80], AU: [40, 40], BE: [27, 67], BG: [50, 35], BR: [25, 27],
  CA: [35, 40], CH: [35, 140], CL: [45, 45], CN: [45, 40], CZ: [50, 20],
  DE: [50, 40], DK: [35, 65], EE: [50, 20], ES: [40, 50], FI: [40, 80],
  FR: [34, 44], GB: [40, 55], GR: [50, 45], HU: [45, 80], IE: [45, 45],
  IN: [50, 45], IT: [45, 65], JP: [45, 45], KR: [45, 45], LT: [45, 130],
  LV: [40, 140], MX: [45, 45], NL: [45, 60], NO: [30, 65], NZ: [35, 35],
  PL: [50, 30], PT: [40, 60], RO: [45, 60], RS: [50, 30], SE: [30, 70],
  SG: [40, 40], SI: [45, 70], SK: [45, 100], TR: [45, 45], TW: [45, 45],
  UA: [50, 45], US: [45, 45], ZA: [45, 45], IS: [32, 32], HR: [45, 100],
  LU: [40, 230], AR: [45, 45], AE: [45, 45],
};

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
    // Only zone readings carry one; a country reading's would just repeat
    // country_code.
    ...(zone ? { zone } : {}),
    hour_start: hourStart,
    hour_end: hourEnd,
    unit: "gCO2eq/kWh",
    direct,
    lifecycle: direct + rec.lifecycleDelta,
    ...(zone ? {} : {
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
    // Names the computation as ours. `data_source` says whose generation data
    // went in, and a reader could otherwise take the operator to have published
    // the intensity itself — which none of them did, and which EIA's API terms
    // specifically forbid claiming ("you may not modify or falsely represent
    // content accessed through the API and still claim the source is the EIA").
    methodology: "Intensity computed by Carbon Intensity API from the data_source's "
      + "published generation mix; IPCC AR6 lifecycle factors; ECON-PowerCI "
      + "consumption accounting. Not published by, or endorsed by, the data source.",
  };
}

export function listCountries() {
  return Object.entries(COUNTRIES)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([code, rec]) => ({
      country_code: code,
      country: rec.name,
      source: SOURCE,
      data_year: rec.dataYear,
      realtime_available: sourceFor(code).realtime,
      zones: zonesFor(code),
    }));
}
