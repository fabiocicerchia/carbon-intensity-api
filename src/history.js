// Hourly history, one object per series per UTC day.
//
// A day is written by folding the provider series into per-hour means and
// upserting them into that day's document. Because a fetch covers a window
// (three hours for ENTSO-E, the whole delivery day for IESO) and not a single
// instant, every run refills every hour it can see — so a dropped run heals
// itself on the next one instead of leaving a permanent gap.
//
// The load-bearing property for the caching design is that a CLOSED day is
// never rewritten. That is enforced by content, not by a time window: a day
// whose hours have not changed is skipped, so a provider that happens to
// return a long history costs a comparison rather than a churned object.

import { COUNTRIES, hourlyMeans } from "./data.js";
import { providerFor, ZONES, zonesFor } from "./live.js";
import { sameExceptTimestamp } from "./pipeline.js";

// A year, so seasonal and year-over-year comparison work. The oldest candidate
// for deletion is RETENTION_DAYS back; today and yesterday are never candidates
// whatever else happens.
export const RETENTION_DAYS = 365;

// Pruning computes its targets rather than listing the bucket, so a pipeline
// that was down for days would step straight over the dates that expired while
// it slept. Sweeping a tail past the boundary self-heals an outage up to a week
// long without persisting a "last pruned" marker anywhere.
//
// ponytail: gaps longer than a week leave those days behind until some later
// pause happens to cover them. A store.list() would close it; not worth one.
export const PRUNE_TAIL_DAYS = 7;

const FIGURES = ["direct", "lifecycle", "consumption_direct", "consumption_lifecycle"];

export function historyPath(code, date, zone = null) {
  return zone ? `v2/${code}/${zone}/history/${date}` : `v2/${code}/history/${date}`;
}

function dayOf(hourIso) {
  return hourIso.slice(0, 10);
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Zones carry direct/lifecycle only: the consumption adjustment is a national
// figure and one bidding zone's import mix is not the country's.
function figuresFor(zone) {
  return zone ? FIGURES.slice(0, 2) : FIGURES;
}

function freshDay(code, zone, date) {
  const doc = {
    country_code: code,
    zone: zone || code,
    unit: "gCO2eq/kWh",
    basis: "measured",
    date,
    start: `${date}T00:00:00Z`,
    step_sec: 3600,
  };
  for (const f of figuresFor(zone)) doc[f] = [];
  doc.points = [];
  doc.complete = [];
  return doc;
}

// Grow every array to cover `hour`, filling the skipped hours with null. Never
// shrinks: a delayed provider backfilling an earlier hour must not truncate the
// later ones, and "today, so far" falls out of only ever growing.
function grow(doc, hour, zone) {
  for (const key of [...figuresFor(zone), "points", "complete"]) {
    while (doc[key].length <= hour) doc[key].push(null);
  }
}

// Upsert the given hourly means into one day's document. `means` may span
// several days; only those on `date` are applied.
export function upsertDay(existingRaw, means, { code, zone = null, date, generatedAt }) {
  const rec = COUNTRIES[code];
  const doc = existingRaw ? JSON.parse(existingRaw) : freshDay(code, zone, date);
  for (const m of means) {
    if (dayOf(m.hour) !== date) continue;
    const hour = Number(m.hour.slice(11, 13));
    grow(doc, hour, zone);
    // Overwrite rather than merge. A later fetch has seen more of the hour, so
    // its mean is strictly better than the one computed from fewer points.
    const direct = Math.round(m.direct);
    doc.direct[hour] = direct;
    doc.lifecycle[hour] = direct + rec.lifecycleDelta;
    if (!zone) {
      doc.consumption_direct[hour] = direct + rec.consumptionDelta;
      doc.consumption_lifecycle[hour] = direct + rec.consumptionDelta + rec.lifecycleDelta;
    }
    doc.points[hour] = m.points;
    doc.complete[hour] = m.complete;
  }
  doc.generated_at = generatedAt;
  return doc;
}

// Every series the API could hold history for, as [code, zone|null]. Iterated
// for pruning rather than "whatever was measured this run", so a country that
// permanently loses its provider still has its old days expire instead of
// being orphaned in the bucket forever.
function knownSeries() {
  const out = [];
  for (const code of Object.keys(COUNTRIES)) {
    if (providerFor(code)) out.push([code, null]);
    if (ZONES[code]) for (const zone of zonesFor(code)) out.push([code, zone]);
  }
  return out;
}

export async function writeHistory(snapshot, put, get, del = null) {
  const pretty = (o) => `${JSON.stringify(o, null, 2)}\n`;
  const generatedAt = snapshot.generated_at;
  const today = dayOf(generatedAt);
  let written = 0;
  let skipped = 0;

  const entries = [
    ...Object.entries(snapshot.series?.countries || {}).map(([code, s]) => [code, null, s]),
    ...Object.entries(snapshot.series?.zones || {}).map(([key, s]) => {
      const [code, zone] = key.split("/");
      return [code, zone, s];
    }),
  ];

  for (const [code, zone, s] of entries) {
    const means = hourlyMeans(s);
    if (means.length === 0) continue;
    for (const date of [...new Set(means.map((m) => dayOf(m.hour)))]) {
      const path = historyPath(code, date, zone);
      const before = await get(path);
      const doc = upsertDay(before, means, { code, zone, date, generatedAt });
      // The immutability guarantee. A closed day whose hours are all already
      // recorded produces an identical document, so it is not rewritten, so the
      // sync leaves it alone and its `immutable` cache header stays honest.
      if (before && sameExceptTimestamp(JSON.parse(before), doc)) {
        skipped += 1;
        continue;
      }
      await put(path, pretty(doc));
      written += 1;
    }
  }

  let pruned = 0;
  if (del) {
    for (let back = RETENTION_DAYS; back <= RETENTION_DAYS + PRUNE_TAIL_DAYS; back += 1) {
      const stale = addDays(today, -back);
      for (const [code, zone] of knownSeries()) {
        if (await del(historyPath(code, stale, zone))) pruned += 1;
      }
    }
  }

  return { written, skipped, pruned };
}
