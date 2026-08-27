// Snapshot pipeline: build the last-hour reading for every country (live where
// a provider exists, annual snapshot otherwise) and persist it via an injected
// async `put(path, body)` — today always the filesystem, whose contents are
// then synced into the bucket by whatever invokes sync.sh — deliberately
// unnamed, so this file is identical in both repos.

import { ATTRIBUTION, COUNTRIES, ProviderlessZone, lastHour, listCountries } from "./data.js";
import { ZONES, measuredLastHour, newestReading, zonesFor } from "./live.js";

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Every zone the API advertises, as [country, zone] pairs.
function knownZones() {
  return Object.keys(ZONES)
    .filter((c) => COUNTRIES[c])
    .flatMap((c) => zonesFor(c).map((z) => [c, z]));
}

export async function buildSnapshot({ useLive = true, env = {}, generatedAt = null } = {}) {
  const codes = Object.keys(COUNTRIES).sort();
  // The provider series is kept alongside the v1 reading rather than discarded:
  // v1 wants one point (`newestReading`), later consumers want every point in
  // the window. One fetch feeds both.
  const countrySeries = {};
  const readings = await Promise.all(codes.map(async (code) => {
    const s = useLive ? await measuredLastHour(code, { env }) : null;
    if (s) countrySeries[code] = s;
    return lastHour(code, { measured: newestReading(s) });
  }));
  const countries = {};
  let measuredCount = 0;
  codes.forEach((code, i) => {
    countries[code] = readings[i];
    if (readings[i].basis === "measured") measuredCount += 1;
  });

  // Sub-country zones, keyed "IT/SICI". A zone with no live reading is simply
  // absent — there is no annual figure to stand in for it — so the set of keys
  // varies hour to hour.
  const pairs = useLive ? knownZones() : [];
  const zoneSeries = {};
  const zoneReadings = await Promise.all(pairs.map(async ([code, zone]) => {
    const key = `${code}/${zone}`;
    const s = await measuredLastHour(code, { env, zone });
    try {
      const reading = lastHour(code, { measured: newestReading(s), zone });
      if (s) zoneSeries[key] = s;
      return [key, reading];
    } catch (e) {
      if (e instanceof ProviderlessZone) return null;
      throw e;
    }
  }));
  const zones = Object.fromEntries(zoneReadings.filter(Boolean));

  return {
    generated_at: generatedAt || nowIso(),
    unit: "gCO2eq/kWh",
    count: codes.length,
    measured_count: measuredCount,
    zone_count: Object.keys(zones).length,
    attribution: ATTRIBUTION,
    countries,
    zones,
    // Not published: kept for consumers that need more than the newest point.
    series: { countries: countrySeries, zones: zoneSeries },
  };
}

// Split the snapshot into per-country docs + an index, for O(1) reads. Each doc
// is standalone, so it carries the timestamp and attribution.
export function countryDocs(snapshot) {
  const docs = {};
  for (const [code, reading] of Object.entries(snapshot.countries)) {
    docs[code] = { generated_at: snapshot.generated_at, ...reading, attribution: ATTRIBUTION };
  }
  return docs;
}

// Persist everything through `put(path, jsonString)`, under the v1/ prefix so
// static hosting serves the files at /v1/... matching the API routes.
// An annual-average country cannot change hour to hour — its figure is a yearly
// one — so rewriting its file every run churned 176 of 213 objects for nothing.
// Left alone unless the values actually differ or the stored copy has gone a
// week stale, so the timestamp still moves often enough to show the pipeline is
// alive. A changed value republishes immediately, whatever the age.
const ANNUAL_REFRESH_SECONDS = 7 * 24 * 3600;

// Everything but the timestamp. Comparing a named list of figures would have
// let a change of shape — a renamed or added field — sit unpublished behind the
// week-long window, which is exactly how the hour_start/hour_end change would
// have failed to reach 176 countries for a week.
export function sameExceptTimestamp(a, b) {
  const strip = ({ generated_at, ...rest }) => JSON.stringify(rest);
  return strip(a) === strip(b);
}

export async function writeAll(snapshot, put, get = null) {
  const pretty = (o) => `${JSON.stringify(o, null, 2)}\n`;
  // `series` is working state, not part of the published snapshot — latest.json
  // is a documented shape and must not gain a field.
  const { series, ...published } = snapshot;
  await put("v1/latest.json", pretty(published));
  const docs = countryDocs(snapshot);
  const codes = Object.keys(docs).sort();
  const now = Date.parse(snapshot.generated_at);
  let skipped = 0;
  // Keys carry no extension so the published URLs survive the move to serving
  // the bucket directly: object storage matches an exact key, and /v1/last-hour/DE is what
  // is documented. latest.json and index.json keep theirs, being documented
  // with them. Content types are set at sync time, not inferred from the name.
  //
  // Zones live under v1/zones/ rather than v1/last-hour/<CODE>/<ZONE>. Object keys
  // are flat strings and would take either, but the pipeline writes to a
  // directory before syncing, and a filesystem cannot have v1/last-hour/AU be
  // both the country's file and the folder holding its zones.
  const writeCountry = async (path, doc) => {
    if (doc.basis === "annual-average" && get) {
      const raw = await get(path);
      if (raw) {
        const prev = JSON.parse(raw);
        const age = (now - Date.parse(prev.generated_at)) / 1000;
        if (sameExceptTimestamp(prev, doc) && Number.isFinite(age) && age < ANNUAL_REFRESH_SECONDS) return false;
      }
    }
    await put(path, pretty(doc));
    return true;
  };

  for (const code of codes) {
    const doc = docs[code];
    const path = `v1/last-hour/${code}`;
    if (!await writeCountry(path, doc)) { skipped += 1; continue; }
    // ISO-3 alias. resolveCode() maps DEU -> DE in application code; a bucket
    // cannot, so the alias has to exist as its own object for the documented
    // alpha-3 lookups to keep working.
    const iso3 = COUNTRIES[code]?.iso3;
    if (iso3 && iso3 !== code) await writeCountry(`v1/last-hour/${iso3}`, doc);
  }

  const zoneKeys = Object.keys(snapshot.zones || {}).sort();
  for (const key of zoneKeys) {
    await put(`v1/zones/${key}`, pretty({
      generated_at: snapshot.generated_at, ...snapshot.zones[key], attribution: ATTRIBUTION,
    }));
  }
  await put("v1/countries", pretty({
    count: listCountries().length, attribution: ATTRIBUTION, countries: listCountries(),
  }));
  await put("v1/last-hour/index.json", pretty({
    generated_at: snapshot.generated_at, count: codes.length, countries: codes, zones: zoneKeys,
  }));
  return { written: codes.length - skipped + zoneKeys.length, skipped };
}
