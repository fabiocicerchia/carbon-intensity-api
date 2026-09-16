#!/usr/bin/env node

// Pipeline runner: build the snapshot and write v1/latest.json plus per-country
// files (v1/last-hour/<CODE>, no extension) under a directory.
//
//   node bin/pipeline.js [--out data] [--no-live]

import { cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeHistory } from "../src/history.js";
import { buildSnapshot, writeAll, writeV2 } from "../src/pipeline.js";
import { fsStore } from "../src/storage.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;

const outDir = arg("--out", "data");
const useLive = !process.argv.includes("--no-live");

// Provider failures are collected rather than swallowed: a country that falls
// back to its annual figure still publishes, so the run is green either way,
// and until this was reported there was no line anywhere saying which provider
// had stopped answering or why.
const failures = [];
const snapshot = await buildSnapshot({
  useLive,
  env: process.env,
  onFailure: (f) => failures.push(f),
});
const out = fsStore(outDir);

// The landing page, the docs page and the icon are hand-written source, not
// pipeline output, so they live in site/ and are copied into the build rather
// than being edited in place under the output directory. Resolved from this
// file rather than from the working directory so the copy still happens when
// the runner is invoked from somewhere else -- which is exactly what the
// deployment repo does, calling it from a submodule checkout.
//
// They are copied before the writes so a run that fails part-way leaves a
// directory the bucket can still serve a page from.
const siteDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "site");
await cp(siteDir, outDir, { recursive: true });

const { written, skipped } = await writeAll(snapshot, out.put, out.get);
// v2 and history are siblings of writeAll, not steps inside it: v1 publishes a
// snapshot by overwriting, history merges into a day, and mixing the two write
// strategies in one function is what keeps writeAll readable by staying out.
const v2 = await writeV2(snapshot, out.put, out.get, out.del, { reconcile: useLive });
const hist = await writeHistory(snapshot, out.put, out.get, out.del);
console.error(
  `wrote ${outDir}/latest.json + ${written} files (${skipped} annual unchanged) — ` +
    `${snapshot.count} countries, ${snapshot.measured_count} measured, ` +
    `generated_at=${snapshot.generated_at}`,
);
console.error(
  `v2: ${v2.written} files (${v2.skipped} annual unchanged); ` +
    `history: ${hist.written} days written, ${hist.skipped} unchanged, ${hist.pruned} pruned`,
);

// Token-gated providers, checked by variable name rather than inferred from a
// provider that produced nothing: a provider can also be zone-only by design
// (IESO answers for CA/ON and not for CA), and that is not a misconfiguration.
if (useLive) {
  for (const [provider, vars] of [
    ["ENTSO-E", ["ENTSOE_TOKEN", "ENTSOE_API_KEY"]],
    ["EIA", ["EIA_TOKEN", "EIA_API_KEY"]],
  ]) {
    if (vars.some((v) => process.env[v])) continue;
    console.error(`provider ${provider}: no token (set ${vars[0]}) — its countries serve annual figures`);
  }
}

// Per-provider health, one line each and on every run, so a run's log answers
// "is anything down, and how close is it?" without diffing committed data.
//
// The lag — how far the newest point a provider returned sits behind the run —
// is the number that matters, because it is what has to stay inside the fetch
// window. When it crosses the window the provider stops answering entirely and
// nothing distinguishes that from an outage. ENTSO-E's lag reached 3h against a
// 3h window on 2026-08-29 and took the hourly routes of all 30 of its countries
// with it, behind twenty consecutive green runs, with this number visible
// nowhere.
const health = new Map();
const of_ = (provider) => {
  if (!health.has(provider)) health.set(provider, { ok: 0, failed: 0, newest: null, error: null });
  return health.get(provider);
};
for (const s of [...Object.values(snapshot.series.countries), ...Object.values(snapshot.series.zones)]) {
  const h = of_(s.source);
  h.ok += 1;
  const end = Date.parse(s.points[s.points.length - 1].end);
  if (Number.isFinite(end) && (h.newest === null || end > h.newest)) h.newest = end;
}
for (const f of failures) {
  const h = of_(f.provider);
  h.failed += 1;
  h.error = f.error;
}

const since = (ms) => {
  const mins = Math.max(0, Math.round((Date.parse(snapshot.generated_at) - ms) / MS_PER_MINUTE));
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}m`;
};
for (const [provider, h] of [...health].sort((a, b) => a[0].localeCompare(b[0]))) {
  const lag = h.newest === null ? "no data" : `newest data ${since(h.newest)} behind`;
  const why = h.error ? ` (last error: ${h.error})` : "";
  const line = `provider ${provider}: ${h.ok}/${h.ok + h.failed} series, ${lag}${why}`;
  // GitHub renders ::warning:: as an annotation on the run; anywhere else it is
  // just a prefix on a line that was going to stderr regardless.
  if (h.ok === 0 && process.env.GITHUB_ACTIONS) console.error(`::warning::${line} — provider is dark`);
  else console.error(line);
}
