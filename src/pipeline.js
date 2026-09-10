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
  hourlyMeans,
  lastHour,
  listCountries,
  METHODOLOGY,
  ProviderlessZone,
  yearlyDocument,
} from "./data.js";
import {
  buildProfile,
  estimateHour,
  horizonFor,
  loadWindow,
  maxHoursFor,
  newestAnchor,
  PROFILE_DAYS,
} from "./estimate.js";
import { measuredLastHour, newestReading, providerFor, providersFor, redundancyFor, ZONES, zonesFor } from "./live.js";
import { buildSpec } from "./openapi.js";

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Where a day of history lives. Here rather than in history.js because writeV2
// reads history to build an estimate, and history.js already depends on this
// file — the other direction would close a cycle. history.js re-exports it.
export function historyPath(code, date, zone = null) {
  return zone ? `v2/${code}/${zone}/history/${date}` : `v2/${code}/history/${date}`;
}

// Every zone the API advertises, as [country, zone] pairs.
function knownZones() {
  return Object.keys(ZONES)
    .filter((c) => COUNTRIES[c])
    .flatMap((c) => zonesFor(c).map((z) => [c, z]));
}

// Every series the API could hold hourly data for, as [code, zone|null].
// Enumerated from the provider tables rather than from what a run happened to
// measure, so a country whose provider is down is still reachable — which is
// what lets the writers reconcile and expire the objects it left behind, and
// what lets history retire the days of a series that lost its provider for
// good.
export function knownSeries() {
  const out = [];
  for (const code of Object.keys(COUNTRIES)) {
    if (providerFor(code)) out.push([code, null]);
  }
  return [...out, ...knownZones()];
}

export async function buildSnapshot({ useLive = true, env = {}, generatedAt = null, onFailure = null } = {}) {
  const codes = Object.keys(COUNTRIES).sort();
  // The provider series is kept alongside the v1 reading rather than discarded:
  // v1 wants one point (`newestReading`), v2's hourly routes and history want
  // every point in the window. One fetch feeds both.
  const countrySeries = {};
  const readings = await Promise.all(
    codes.map(async (code) => {
      const s = useLive ? await measuredLastHour(code, { env, onFailure }) : null;
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
      const s = await measuredLastHour(code, { env, zone, onFailure });
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
const MS_PER_HOUR = SECONDS_PER_HOUR * MS_PER_SECOND;

// How far back /past-hour and /current-hour will reach. An hour whose period
// ended longer ago than this is not published under either name, however
// complete it is — they are named for particular clock hours, and an hour from
// half a day ago is not one of them.
//
// Nothing is held across an outage on the strength of this: a route with no
// hour to serve 404s on the same run. The bound governs only which freshly
// computed hour may be published, and it is measured against the hour itself
// rather than against the run, because a provider's ordinary publication lag
// already puts `period_end` a few hours back.
//
// It doubles as the `stale` line in the catalogue, which is the same question
// asked of a country: past this, only /latest answers.
const HOURLY_MAX_AGE_HOURS = 6;
export const HOURLY_MAX_AGE_SECONDS = HOURLY_MAX_AGE_HOURS * SECONDS_PER_HOUR;

// The three hourly routes, in the order the catalogue reports them: most
// specific promise first.
const HOURLY_ROUTES = ["past-hour", "current-hour", "latest"];

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
// `reconcile` walks the series that produced nothing this run and expires what
// they left behind. It is off for an offline build (`--no-live`), where no
// provider was asked at all: "we did not try" and "we tried and got nothing"
// look identical in the snapshot, and only the second is grounds for deleting
// anything.
export async function writeV2(snapshot, put, get = null, del = null, { reconcile = true } = {}) {
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
  //
  // Series that produced NOTHING this run are walked too, not just the measured
  // ones. A provider that goes dark drops its countries out of the snapshot
  // altogether, and a loop over the snapshot alone never reaches them again: no
  // write, no delete, and whatever they last held is served forever. That is
  // how /v2/DE/current-hour kept answering with an hour from the previous day
  // while /v2/DE/past-hour stayed 404 through twenty green runs.
  const bulk = [];
  // Which hourly routes each country actually ends this run with. Recorded as
  // the objects are written rather than asserted anywhere, because it is not a
  // property of the country: it falls out of how far behind that country's
  // provider is publishing, and EIA at a day behind answers on fewer routes
  // than NESO at seventeen minutes. `realtime_available` says a provider
  // exists; this says what came of it.
  const answered = new Map();
  // How far behind this run the newest hour a country has actually reaches. Two
  // countries can both carry `latest` alone and be an hour and a week behind
  // respectively, and a bare route list cannot tell them apart — so the number
  // is published rather than left for a reader to infer from period_end.
  const lag = new Map();
  const record = (code, zone, route, doc) => {
    if (zone) return;
    if (!answered.has(code)) answered.set(code, new Set());
    answered.get(code).add(route);
    if (route !== "latest" || !doc) return;
    const behind = Math.round((now - Date.parse(doc.period_end)) / MS_PER_SECOND);
    if (Number.isFinite(behind)) lag.set(code, Math.max(0, behind));
  };
  const series = snapshot.series || { countries: {}, zones: {} };
  const measured = new Map([
    ...Object.entries(series.countries || {}).map(([code, s]) => [code, [code, null, s]]),
    ...Object.entries(series.zones || {}).map(([key, s]) => [key, [...key.split("/"), s]]),
  ]);
  const targets = [...measured.values()];
  if (reconcile) {
    for (const [code, zone] of knownSeries()) {
      const key = zone ? `${code}/${zone}` : code;
      if (!measured.has(key)) targets.push([code, zone, null]);
    }
  }

  // Only the fields that differ per country. `unit`, `methodology` and
  // `attribution` are identical for all of them and go in the envelope once —
  // repeating them per entry is precisely what made v1's latest.json 246 KB.
  // `source` stays because it varies and because the methodology note is only
  // meaningful next to whose data it describes.
  const bulkEntry = (doc) => ({
    country_code: doc.country_code,
    period_start: doc.period_start,
    period_end: doc.period_end,
    direct: doc.direct,
    lifecycle: doc.lifecycle,
    consumption_direct: doc.consumption_direct,
    consumption_lifecycle: doc.consumption_lifecycle,
    points: doc.points,
    complete: doc.complete,
    basis: doc.basis,
    source: doc.data_source.name,
  });

  // How old a published hour may be. The fetch window used to bound this by
  // accident — against a three-hour window /past-hour could only ever be two
  // hours behind — and widening that window to twelve to survive provider lag
  // quietly loosened the bound to eleven. So it is stated here instead of
  // inherited: an hour whose period ended longer ago than HOURLY_MAX_AGE_SECONDS
  // is not published, however complete it is, and the same rule then covers both
  // ways a route can go stale. It matters most while a provider is recovering —
  // one that comes back by backfilling only old hours would otherwise republish
  // a half-day-old hour every run, with a moving generated_at making it look
  // current.
  // The clock hour each route names, relative to this run.
  const hourOf = (route) => {
    const d = new Date(now);
    d.setUTCMinutes(0, 0, 0);
    if (route === "past-hour") d.setUTCHours(d.getUTCHours() - 1);
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
  };

  // The hour a route names, taken from the provider's window if it is there.
  // /past-hour is the hour that just closed and /current-hour the one running —
  // those specific hours, not "the newest one we happen to have". A provider
  // three hours behind has not published the hour that just closed, and saying
  // so is what lets the estimator fill it and /latest carry the real reading.
  //
  // /past-hour additionally requires the hour to be complete: an hour is only
  // "completed" once all of its points are in.
  const namedMean = (route, means) => {
    const m = means.get(hourOf(route));
    if (!m) return null;
    return route === "past-hour" && !m.complete ? null : m;
  };

  // Estimating is only ever reached when a route has no measured hour to serve,
  // and it reads 28 days of history to do it — so the profile is built lazily,
  // once per series, and not at all on a normal run where every feed answered.
  const today = snapshot.generated_at.slice(0, 10);
  const profiles = new Map();
  const profileFor = async (code, zone) => {
    const key = zone ? `${code}/${zone}` : code;
    if (!profiles.has(key)) {
      const samples = get
        ? await loadWindow(
            async (date) => {
              const raw = await get(historyPath(code, date, zone));
              return raw ? JSON.parse(raw) : null;
            },
            today,
            PROFILE_DAYS,
          )
        : [];
      profiles.set(key, { profile: buildProfile(samples), anchor: newestAnchor(samples) });
    }
    return profiles.get(key);
  };

  for (const [code, zone, s] of targets) {
    const prefix = zone ? `v2/${code}/${zone}` : `v2/${code}`;
    // `latest` is deliberately NOT passed through fresh(). The two hourly routes
    // are named for particular clock hours and mean them: when the provider has
    // not published one, the hour is missing and they 404. `latest` is the other
    // question — "what is the newest reading you have at all" — and for a
    // provider that publishes a day behind by design (EIA) or several days
    // (Eskom) it is the only answer there is. Splitting them is what lets both
    // be honest; one route cannot be both.
    const byHour = new Map(s ? hourlyMeans(s).map((m) => [m.hour, m]) : []);
    const means = s
      ? [
          ["past-hour", namedMean("past-hour", byHour)],
          ["current-hour", namedMean("current-hour", byHour)],
          // Unchanged: the newest hour with any data, at any age.
          ["latest", currentHour(s)],
        ]
      : [
          ["past-hour", null],
          ["current-hour", null],
          ["latest", null],
        ];
    for (const [route, mean] of means) {
      const path = `${prefix}/${route}`;
      if (!mean) {
        // An hour-named route with no such hour is a 404, immediately. There is
        // no grace period and nothing is held: /past-hour and /current-hour name
        // particular clock hours, and holding yesterday's under either of those
        // names for a few hours is the same untruth as holding it for a day,
        // only shorter. Whether the provider answered with a window holding no
        // usable hour or did not answer at all makes no difference to whether
        // the hour exists.
        //
        // `latest` is what carries a reading across an outage, and it carries it
        // for as long as the outage lasts: the newest reading we have does not
        // stop being the newest reading we have because the provider went quiet.
        // It stops being rewritten instead, so its `generated_at` stands still
        // and its age shows in the document rather than hiding behind a moving
        // timestamp.
        if (route !== "latest") {
          // No measured hour for this route. Before publishing the absence, see
          // whether it can be estimated: the newest hour the provider DID give
          // us, scaled by how this grid usually moves between then and now.
          // Bounded hard — see src/estimate.js — so a long outage still 404s
          // rather than dressing a climatological average as a reading.
          //
          // The anchor comes from this run's window when there is one, because
          // history has not been written yet at this point in the pipeline and
          // would be an hour behind whatever the provider just handed over.
          const { profile, anchor: stored } = await profileFor(code, zone);
          // The newest hour the provider gave us, complete or not: a partly
          // filled hour is a real measurement and an hour closer to the target,
          // which shortens the extrapolation. History is the fallback, and is an
          // hour behind whatever this run just fetched because writeHistory has
          // not run yet.
          const live = s ? currentHour(s) : null;
          const anchor = live || stored;
          // How far behind the provider actually is, measured to the hour now
          // running rather than to this route's hour, so both routes are judged
          // by the same distance: the backtested horizon is a floor and this
          // lifts it (src/estimate.js). Reaching /current-hour costs exactly
          // this many hours, and refusing to spend them is refusing the route.
          const behind = anchor
            ? Math.round((Date.parse(hourOf("current-hour")) - Date.parse(anchor.hour)) / MS_PER_HOUR)
            : 0;
          const backtested = maxHoursFor(code);
          const maxHours = horizonFor(code, behind);
          const est = estimateHour(hourOf(route), anchor, profile, { maxHours });
          if (est) {
            const { hour, direct, ...how } = est;
            const doc = stamp(
              hourDocument(
                code,
                { hour, direct },
                {
                  zone,
                  estimate: {
                    method: "diurnal-profile-anchored",
                    profile_days: PROFILE_DAYS,
                    from_source: s?.source ?? null,
                    ...how,
                    // Both numbers, always, so an estimate stretched past what the
                    // backtest measured is visible in the document instead of only
                    // in this file. A consumer that wants the measured error bound
                    // keeps hours_ahead <= backtested_max_hours and drops the rest.
                    max_hours: maxHours,
                    backtested_max_hours: backtested,
                  },
                },
              ),
            );
            await put(path, pretty(doc));
            written += 1;
            record(code, zone, route, doc);
            if (route === "past-hour" && !zone) bulk.push(bulkEntry(doc));
            continue;
          }
          if (del) await del(path);
          continue;
        }
        if (s) {
          if (del) await del(path);
          continue;
        }
        const raw = get ? await get(path) : null;
        if (raw) record(code, zone, route, JSON.parse(raw));
        continue;
      }
      const doc = stamp(hourDocument(code, mean, { series: s, zone }));
      await put(path, pretty(doc));
      written += 1;
      record(code, zone, route, doc);
      if (route === "past-hour" && !zone) bulk.push(bulkEntry(doc));
    }
  }

  // The static catalogue. v1 split "what countries exist" from "what their
  // figures are" across `countries` and a 246 KB `latest.json`; the annual
  // figure is a static property of a country like its zones, so it belongs in
  // the one document rather than a second copy of every code and name.
  const catalogue = listCountries().map((c) => {
    const y = yearlyDocument(c.country_code);
    const routes = answered.get(c.country_code);
    return {
      ...c,
      // Who is behind the hourly routes, and which of them answered this run.
      // A reader asking "can I call /past-hour for DE" gets the answer from the
      // catalogue instead of from a table in the docs that would be wrong the
      // first time a provider's lag changed.
      provider: providerFor(c.country_code),
      // The whole chain as configured, primary first. `provider` above is the
      // primary; `data_source.name` on an hourly document says which one
      // actually replied, and they differ exactly when a fallback carried it.
      providers: providersFor(c.country_code),
      // What the chain actually protects against, not how long it is. A second
      // feed that re-publishes the first covers its API failing and nothing
      // else, and saying so is the difference between redundancy and the
      // appearance of it.
      redundancy: redundancyFor(c.country_code),
      routes: routes ? HOURLY_ROUTES.filter((r) => routes.has(r)) : [],
      data_lag_seconds: lag.has(c.country_code) ? lag.get(c.country_code) : null,
      // The warning flag. Past this bound the hour-named routes stop answering,
      // which is precisely the point where a reading is still real data but no
      // longer a current one — EIA a day behind, Eskom several.
      stale: (lag.get(c.country_code) ?? 0) >= HOURLY_MAX_AGE_SECONDS,
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
