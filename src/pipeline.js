// Snapshot pipeline: build the last-hour reading for every country (live where
// a provider exists, annual snapshot otherwise) and persist it via an injected
// async `put(path, body)` — today always the filesystem, whose contents are
// then synced into the bucket by whatever invokes sync.sh — deliberately
// unnamed, so this file is identical in both repos.

import {
  ATTRIBUTION,
  COUNTRIES,
  currentHour,
  hourDocument,
  lastHour,
  listCountries,
  METHODOLOGY,
  ProviderlessZone,
  pastHour,
  yearlyDocument,
} from "./data.js";
import { measuredLastHour, newestReading, ZONES, zonesFor } from "./live.js";
import { buildSpec } from "./openapi.js";

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
  // v1 wants one point (`newestReading`), v2's hourly routes and history want
  // every point in the window. One fetch feeds both.
  const countrySeries = {};
  const readings = await Promise.all(
    codes.map(async (code) => {
      const s = useLive ? await measuredLastHour(code, { env }) : null;
      if (s) countrySeries[code] = s;
      return lastHour(code, { measured: newestReading(s) });
    }),
  );
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
  const zoneReadings = await Promise.all(
    pairs.map(async ([code, zone]) => {
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
    }),
  );
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
    // Not published: consumed by the v2 writers and by history accumulation.
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
const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;
const ANNUAL_REFRESH_SECONDS = DAYS_PER_WEEK * HOURS_PER_DAY * SECONDS_PER_HOUR;

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
  // `series` is working state for the v2 writers, not part of the published
  // snapshot — latest.json is v1 and frozen, so it must not gain a field.
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
        const age = (now - Date.parse(prev.generated_at)) / MS_PER_SECOND;
        if (sameExceptTimestamp(prev, doc) && Number.isFinite(age) && age < ANNUAL_REFRESH_SECONDS) return false;
      }
    }
    await put(path, pretty(doc));
    return true;
  };

  for (const code of codes) {
    const doc = docs[code];
    const path = `v1/last-hour/${code}`;
    if (!(await writeCountry(path, doc))) {
      skipped += 1;
      continue;
    }
    // ISO-3 alias. resolveCode() maps DEU -> DE in application code; a bucket
    // cannot, so the alias has to exist as its own object for the documented
    // alpha-3 lookups to keep working.
    const iso3 = COUNTRIES[code]?.iso3;
    if (iso3 && iso3 !== code) await writeCountry(`v1/last-hour/${iso3}`, doc);
  }

  const zoneKeys = Object.keys(snapshot.zones || {}).sort();
  for (const key of zoneKeys) {
    await put(
      `v1/zones/${key}`,
      pretty({
        generated_at: snapshot.generated_at,
        ...snapshot.zones[key],
        attribution: ATTRIBUTION,
      }),
    );
  }
  await put(
    "v1/countries",
    pretty({
      count: listCountries().length,
      attribution: ATTRIBUTION,
      countries: listCountries(),
    }),
  );
  await put(
    "v1/last-hour/index.json",
    pretty({
      generated_at: snapshot.generated_at,
      count: codes.length,
      countries: codes,
      zones: zoneKeys,
    }),
  );
  return { written: codes.length - skipped + zoneKeys.length, skipped };
}

// --- v2 -----------------------------------------------------------------------
// Written alongside v1, from the same snapshot. v1 above is frozen: it keeps
// getting fresh data but its paths, fields and semantics do not move, so the two
// trees are produced independently rather than one being derived from the other.
export async function writeV2(snapshot, put, get = null, del = null) {
  const pretty = (o) => `${JSON.stringify(o, null, 2)}\n`;
  const stamp = (doc) => ({ generated_at: snapshot.generated_at, ...doc, attribution: ATTRIBUTION });
  const codes = Object.keys(COUNTRIES).sort();
  let written = 0;
  let skipped = 0;

  // An annual figure changes about once a year, so rewriting 213 of them every
  // twenty minutes would churn the repo and the bucket for nothing — the same
  // reason writeAll leaves unchanged annual countries alone, and the same
  // week-long ceiling so the timestamp still moves often enough to show life.
  const now = Date.parse(snapshot.generated_at);
  for (const code of codes) {
    const path = `v2/${code}/yearly`;
    const doc = stamp(yearlyDocument(code));
    const raw = get ? await get(path) : null;
    if (raw) {
      const prev = JSON.parse(raw);
      const age = (now - Date.parse(prev.generated_at)) / MS_PER_SECOND;
      if (sameExceptTimestamp(prev, doc) && Number.isFinite(age) && age < ANNUAL_REFRESH_SECONDS) {
        skipped += 1;
        continue;
      }
    }
    await put(path, pretty(doc));
    written += 1;
  }

  // The hourly routes, for the countries and zones with a live provider. A
  // series with no complete hour yet yields no past-hour object at all, and any
  // previous one is removed rather than left to look current — an annual
  // constant behind a route named for a completed hour is the dishonesty v2
  // exists to remove, and so is last week's hour.
  const bulk = [];
  const series = snapshot.series || { countries: {}, zones: {} };
  const targets = [
    ...Object.entries(series.countries || {}).map(([code, s]) => [code, null, s]),
    ...Object.entries(series.zones || {}).map(([key, s]) => [...key.split("/"), s]),
  ];
  for (const [code, zone, s] of targets) {
    const prefix = zone ? `v2/${code}/${zone}` : `v2/${code}`;
    for (const [route, mean] of [
      ["past-hour", pastHour(s)],
      ["current-hour", currentHour(s)],
    ]) {
      const path = `${prefix}/${route}`;
      if (!mean) {
        if (del) await del(path);
        continue;
      }
      const doc = stamp(hourDocument(code, mean, { series: s, zone }));
      await put(path, pretty(doc));
      written += 1;
      if (route === "past-hour" && !zone) {
        // Only the fields that differ per country. `unit`, `methodology` and
        // `attribution` are identical for all of them and go in the envelope
        // once — repeating them per entry is precisely what made v1's
        // latest.json 246 KB. `source` stays because it varies and because the
        // methodology note is only meaningful next to whose data it describes.
        bulk.push({
          country_code: doc.country_code,
          period_start: doc.period_start,
          period_end: doc.period_end,
          direct: doc.direct,
          lifecycle: doc.lifecycle,
          consumption_direct: doc.consumption_direct,
          consumption_lifecycle: doc.consumption_lifecycle,
          points: doc.points,
          complete: doc.complete,
          source: doc.data_source.name,
        });
      }
    }
  }

  // The static catalogue. v1 split "what countries exist" from "what their
  // figures are" across `countries` and a 246 KB `latest.json`; the annual
  // figure is a static property of a country like its zones, so it belongs in
  // the one document rather than a second copy of every code and name.
  const catalogue = listCountries().map((c) => {
    const y = yearlyDocument(c.country_code);
    return {
      ...c,
      direct: y.direct,
      lifecycle: y.lifecycle,
      consumption_direct: y.consumption_direct,
      consumption_lifecycle: y.consumption_lifecycle,
    };
  });
  // The contract, generated from the same COUNTRIES/ZONES the documents are
  // built from. Carries no timestamp, so it is byte-identical between runs and
  // only shows up in the commit log when the API actually changes.
  await put("v2/openapi.json", pretty(buildSpec()));

  await put(
    "v2/countries.json",
    pretty({
      count: catalogue.length,
      generated_at: snapshot.generated_at,
      attribution: ATTRIBUTION,
      countries: catalogue,
    }),
  );

  // Bulk past-hour, but deliberately no bulk current-hour: completeness varies
  // by provider, so a cross-country table of hours-in-progress would compare a
  // finished EIA hour against a quarter of an ENTSO-E one.
  bulk.sort((a, b) => a.country_code.localeCompare(b.country_code));
  await put(
    "v2/past-hour.json",
    pretty({
      count: bulk.length,
      generated_at: snapshot.generated_at,
      unit: "gCO2eq/kWh",
      methodology: METHODOLOGY,
      attribution: ATTRIBUTION,
      countries: bulk,
    }),
  );

  return { written, skipped };
}
