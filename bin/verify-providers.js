#!/usr/bin/env node
// Call every configured feed and report what came back.
//
//   node bin/verify-providers.js [--code DE] [--zones] [--json]
//
// measuredLastHour stops at the first feed that works, which is right for the
// pipeline and useless for answering "is this fallback real?". This calls them
// all, side by side, and prints the two numbers that answer it: how far behind
// each feed is, and whether two feeds describing the same grid agree.
//
// It exists because a fallback fails SAFE: a fetcher that 404s on every call is
// indistinguishable, from the pipeline's side, from a country that never had a
// fallback. Energy-Charts shipped with a start-parameter its API rejects and
// every call 404'd, unnoticed, because nothing ever asked a feed to prove
// itself. Run this from a machine with network access after touching a fetcher.
//
// Exit status: 1 if any configured feed failed, so CI can hold the line.

import { COUNTRIES, hourlyMeans } from "../src/data.js";
import { defaultFetchers, providersFor, zonesFor } from "../src/live.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

const only = arg("--code");
const withZones = process.argv.includes("--zones");
const asJson = process.argv.includes("--json");
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MINUTES_PER_HOUR = 60;
const PERCENT = 100;
// Column widths for the fixed-width report.
const LABEL_WIDTH = 10;
const PROVIDER_WIDTH = 14;
const NUMBER_WIDTH = 4;
const MINUTE_DIGITS = 2;
// Two feeds whose lag differs by under ten minutes are not independent enough
// to call a fallback, and a disagreement over 15% is worth naming.
const LAG_INDEPENDENCE_SEC = 600;
const SPREAD_ALARM = 0.15;

const now = Date.now();

const ago = (ms) => {
  const mins = Math.max(0, Math.round((now - ms) / MS_PER_MINUTE));
  return `${Math.floor(mins / MINUTES_PER_HOUR)}h${String(mins % MINUTES_PER_HOUR).padStart(MINUTE_DIGITS, "0")}m`;
};

// One feed, called directly rather than through the chain.
async function probe(code, zone, provider) {
  const fetch_ = defaultFetchers(code, process.env, zone)[provider];
  if (!fetch_) return { provider, ok: false, error: "no fetcher (missing token?)" };
  try {
    const s = await fetch_();
    if (!s?.points?.length) throw new Error("empty series");
    const means = hourlyMeans(s);
    const newest = Date.parse(s.points[s.points.length - 1].end);
    return {
      provider,
      ok: true,
      points: s.points.length,
      resolution_sec: s.resolution_sec,
      behind_seconds: Math.max(0, Math.round((now - newest) / MS_PER_SECOND)),
      complete_hours: means.filter((m) => m.complete).length,
      // The newest complete hour's mean, which is what /past-hour would serve.
      direct:
        means
          .filter((m) => m.complete)
          .map((m) => Math.round(m.direct))
          .pop() ?? null,
    };
  } catch (e) {
    return { provider, ok: false, error: e.message };
  }
}

const targets = [];
for (const code of Object.keys(COUNTRIES).sort()) {
  if (only && code !== only) continue;
  if (providersFor(code).length) targets.push([code, null]);
  if (withZones) for (const z of zonesFor(code)) if (providersFor(code, z).length) targets.push([code, z]);
}

const results = [];
for (const [code, zone] of targets) {
  const chain = providersFor(code, zone);
  const feeds = [];
  for (const p of chain) feeds.push(await probe(code, zone, p));
  results.push({ code, zone, feeds });
}

if (asJson) {
  console.log(JSON.stringify({ generated_at: new Date(now).toISOString(), results }, null, 2));
} else {
  for (const { code, zone, feeds } of results) {
    const label = zone ? `${code}/${zone}` : code;
    for (const f of feeds) {
      const line = f.ok
        ? `${String(f.direct ?? "—").padStart(NUMBER_WIDTH)} gCO2  ${String(f.points).padStart(NUMBER_WIDTH)} pts  ` +
          `${ago(now - f.behind_seconds * MS_PER_SECOND)} behind  ${f.complete_hours} complete hours`
        : `FAILED  ${f.error}`;
      console.log(`${label.padEnd(LABEL_WIDTH)} ${f.provider.padEnd(PROVIDER_WIDTH)} ${line}`);
    }
    // The two questions a chain has to answer: does the fallback work at all,
    // and is it actually independent of the primary?
    const ok = feeds.filter((f) => f.ok);
    if (ok.length > 1) {
      const [a, b] = ok;
      const lag = Math.abs(a.behind_seconds - b.behind_seconds);
      const spread =
        a.direct != null && b.direct != null ? Math.abs(a.direct - b.direct) / Math.max(a.direct, b.direct) : null;
      const notes = [];
      // A fallback that stops where the primary stops is downstream of it: it
      // covers the primary's API failing, not the primary's data going missing.
      if (lag < LAG_INDEPENDENCE_SEC)
        notes.push("lags track each other — check whether the fallback is downstream of the primary");
      if (spread != null && spread > SPREAD_ALARM) notes.push(`feeds disagree by ${(spread * PERCENT).toFixed(0)}%`);
      if (notes.length) console.log(`${" ".repeat(LABEL_WIDTH)} ${" ".repeat(PROVIDER_WIDTH)} ^ ${notes.join("; ")}`);
    }
    if (feeds.length === 1)
      console.log(`${" ".repeat(LABEL_WIDTH)} ${" ".repeat(PROVIDER_WIDTH)} ^ single feed, no fallback`);
  }
}

const failed = results.flatMap((r) =>
  r.feeds.filter((f) => !f.ok).map((f) => `${r.code}${r.zone ? `/${r.zone}` : ""}:${f.provider}`),
);
if (failed.length) {
  console.error(`\n${failed.length} configured feed(s) did not answer: ${failed.join(" ")}`);
  process.exit(1);
}
