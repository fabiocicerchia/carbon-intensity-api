import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, countryDocs, writeAll } from "../src/pipeline.js";
import { COUNTRIES } from "../src/data.js";

test("offline snapshot covers every country", async () => {
  const snap = await buildSnapshot({ useLive: false, generatedAt: "2026-08-08T14:00:00Z" });
  assert.equal(snap.generated_at, "2026-08-08T14:00:00Z");
  assert.equal(snap.count, Object.keys(COUNTRIES).length);
  assert.equal(snap.measured_count, 0);
  assert.equal(snap.countries.DE.basis, "annual-average");
});

test("countryDocs stamp generated_at + attribution", async () => {
  const snap = await buildSnapshot({ useLive: false, generatedAt: "t" });
  assert.match(snap.attribution.repository, /github\.com\/fabiocicerchia/);
  const docs = countryDocs(snap);
  assert.equal(docs.US.generated_at, "t");
  assert.equal(docs.US.country_code, "US");
  assert.equal(docs.US.attribution.url, "https://ci-api.fabiocicerchia.it");
  assert.match(docs.US.attribution.repository, /github\.com\/fabiocicerchia/);
});

test("writeAll emits latest + per-country + index", async () => {
  const snap = await buildSnapshot({ useLive: false, generatedAt: "t" });
  const files = {};
  const { written: n } = await writeAll(snap, async (path, body) => { files[path] = body; });
  assert.equal(n, snap.count);
  assert.ok(files["v1/latest.json"]);
  assert.ok(files["v1/last-hour/DE"]);
  const index = JSON.parse(files["v1/last-hour/index.json"]);
  assert.equal(index.count, n);
  assert.ok(index.countries.includes("FR"));
});


test("writeAll leaves an unchanged annual country alone until it is a week old", async () => {
  const files = {};
  const put = async (p, b) => { files[p] = b; };
  const get = async (p) => files[p] ?? null;
  const country = { country_code: "AF", basis: "annual-average", direct: 131, lifecycle: 156, consumption_direct: 158, consumption_lifecycle: 183 };
  const snap = (at) => ({ generated_at: at, unit: "gCO2eq/kWh", countries: { AF: country }, zones: {} });

  const first = await writeAll(snap("2026-08-01T00:00:00Z"), put, get);
  assert.equal(first.skipped, 0);
  const stamped = JSON.parse(files["v1/last-hour/AF"]).generated_at;

  // An hour later: nothing about a yearly figure has changed, so the file is not
  // rewritten and keeps its original timestamp.
  const second = await writeAll(snap("2026-08-01T01:00:00Z"), put, get);
  assert.equal(second.skipped, 1);
  assert.equal(JSON.parse(files["v1/last-hour/AF"]).generated_at, stamped);

  // Past a week it refreshes, so a stalled pipeline is still visible.
  const later = await writeAll(snap("2026-08-09T00:00:00Z"), put, get);
  assert.equal(later.skipped, 0);
  assert.equal(JSON.parse(files["v1/last-hour/AF"]).generated_at, "2026-08-09T00:00:00Z");
});

test("writeAll republishes an annual country the moment its figure changes", async () => {
  const files = {};
  const put = async (p, b) => { files[p] = b; };
  const get = async (p) => files[p] ?? null;
  const base = { country_code: "AF", basis: "annual-average", direct: 131, lifecycle: 156 };
  await writeAll({ generated_at: "2026-08-01T00:00:00Z", countries: { AF: base }, zones: {} }, put, get);
  const changed = { ...base, direct: 140 };
  const r = await writeAll({ generated_at: "2026-08-01T01:00:00Z", countries: { AF: changed }, zones: {} }, put, get);
  assert.equal(r.skipped, 0); // a new value does not wait a week
  assert.equal(JSON.parse(files["v1/last-hour/AF"]).direct, 140);
});

test("writeAll republishes when the document shape changes, not just its values", async () => {
  const files = {};
  const put = async (p, b) => { files[p] = b; };
  const get = async (p) => files[p] ?? null;
  const base = { country_code: "AF", basis: "annual-average", direct: 131, hour_start: "2026-08-01T00:00:00Z" };
  await writeAll({ generated_at: "2026-08-01T00:00:00Z", countries: { AF: base }, zones: {} }, put, get);
  // Same figures, different shape — the case that would otherwise sit behind the
  // week-long window and leave 176 countries on the old format.
  const reshaped = { country_code: "AF", basis: "annual-average", direct: 131, hour_start: null };
  const r = await writeAll({ generated_at: "2026-08-01T01:00:00Z", countries: { AF: reshaped }, zones: {} }, put, get);
  assert.equal(r.skipped, 0);
  assert.equal(JSON.parse(files["v1/last-hour/AF"]).hour_start, null);
});
