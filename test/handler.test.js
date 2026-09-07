import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest } from "../src/handler.js";

const req = (path) => new Request(`https://x.local${path}`);
const body = async (res) => JSON.parse(await res.text());

test("/v1/countries carries realtime_available", async () => {
  const b = await body(await handleRequest(req("/v1/countries")));
  assert.ok(b.count >= 200);
  assert.ok(b.countries.find((c) => c.country_code === "DE").realtime_available);
});

test("/v1/last-hour/<CODE> fallback compute (no store)", async () => {
  const b = await body(await handleRequest(req("/v1/last-hour/DE")));
  assert.equal(b.country_code, "DE");
  assert.equal(b.data_source.realtime, false);
  assert.equal(b.basis, "annual-average");
  // Freshness is the caller's to derive, so nothing claims it for them.
  assert.equal(b.stale, undefined);
  assert.equal(b.age_seconds, undefined);
  assert.match(b.attribution.repository, /github\.com\/fabiocicerchia/);
});

test("/v1/last-hour by iso3; names are not accepted", async () => {
  assert.equal((await body(await handleRequest(req("/v1/last-hour/DEU")))).country_code, "DE");
  assert.equal((await body(await handleRequest(req("/v1/last-hour/deu")))).country_code, "DE");
  assert.equal((await handleRequest(req("/v1/last-hour/Germany"))).status, 404);
  assert.equal((await handleRequest(req("/v1/last-hour/south%20korea"))).status, 404);
});

test("/v1/last-hour unknown -> 404", async () => {
  assert.equal((await handleRequest(req("/v1/last-hour/Narnia"))).status, 404);
});

test("/v1/last-hour serves the precomputed snapshot verbatim", async () => {
  const doc = '{"country_code":"DE","basis":"measured","generated_at":"2026-08-08T13:00:00Z"}';
  const store = { get: async (k) => (k === "v1/last-hour/DE" ? doc : null) };
  // Byte-identical to the stored object, so the answer does not depend on
  // whether this handler or the bucket served it.
  const b = await body(await handleRequest(req("/v1/last-hour/DE"), {}, store, Date.parse("2026-08-08T15:00:00Z")));
  assert.deepEqual(b, JSON.parse(doc));
  // No .json variant — the bucket has no such key, so neither does this.
  assert.equal((await handleRequest(req("/v1/last-hour/DE.json"), {}, store)).status, 404);
});

test("/v1/latest.json from store; 503 without", async () => {
  const store = {
    get: async (k) => (k === "v1/latest.json" ? '{"count":213,"generated_at":"2026-08-08T13:00:00Z"}' : null),
  };
  const b = await body(await handleRequest(req("/v1/latest.json"), {}, store, Date.parse("2026-08-08T13:10:00Z")));
  assert.equal(b.count, 213);
  assert.equal(b.stale, undefined);
  assert.equal((await handleRequest(req("/v1/latest.json"))).status, 503);
});

test("landing page served from store", async () => {
  const store = { get: async (k) => (k === "index.html" ? "<!doctype html><h1>hi</h1>" : null) };
  const res = await handleRequest(req("/"), {}, store);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
});

test("/v1/last-hour/<CODE>/<ZONE> served from store, no consumption_direct", async () => {
  const doc =
    '{"country_code":"IT","zone":"SICI","basis":"measured","direct":300,"generated_at":"2026-08-08T13:00:00Z"}';
  const store = { get: async (k) => (k === "v1/zones/IT/SICI" ? doc : null) };
  const res = await handleRequest(req("/v1/zones/IT/SICI"), {}, store, Date.parse("2026-08-08T13:10:00Z"));
  const b = await body(res);
  assert.equal(res.status, 200);
  assert.equal(b.zone, "SICI");
  assert.equal(b.consumption_direct, undefined);
});

test("zone routes: unknown zone, zoneless country, no live data", async () => {
  assert.equal((await handleRequest(req("/v1/zones/IT/NOPE"))).status, 404);
  const none = await handleRequest(req("/v1/zones/FR/SICI"));
  assert.equal(none.status, 404);
  assert.deepEqual((await body(none)).zones, []);
  // Known zone, no provider reading and no annual fallback to stand in.
  assert.equal((await handleRequest(req("/v1/zones/IT/SICI"))).status, 404);
});

test("/v1/countries advertises zones", async () => {
  const b = await body(await handleRequest(req("/v1/countries")));
  assert.deepEqual(b.countries.find((c) => c.country_code === "DK").zones, ["DK1", "DK2"]);
  assert.deepEqual(b.countries.find((c) => c.country_code === "FR").zones, []);
});

test("zone blip: stale snapshot served rather than 404", async () => {
  const doc =
    '{"country_code":"IT","zone":"SICI","basis":"measured","direct":300,"generated_at":"2026-08-09T10:00:00Z"}';
  const store = { get: async (k) => (k === "v1/zones/IT/SICI" ? doc : null) };
  // Two hours on, the hourly run has missed this zone and no token is bound,
  // so the live retry fails too. The old reading is still the best answer.
  const res = await handleRequest(req("/v1/zones/IT/SICI"), {}, store, Date.parse("2026-08-09T12:00:00Z"));
  const b = await body(res);
  assert.equal(res.status, 200);
  assert.equal(b.direct, 300);
  // Two hours old, and it says so — that is the whole staleness contract now.
  assert.equal(b.generated_at, "2026-08-09T10:00:00Z");
});

test("zone blip: a fresh snapshot is served without touching the provider", async () => {
  // The mirror of the test above: while the snapshot is inside the freshness
  // window the provider is never consulted, so only a stale one can trigger
  // the live retry that would otherwise run on every zone request.
  let reads = 0;
  const doc =
    '{"country_code":"AU","zone":"SA1","basis":"measured","direct":300,"generated_at":"2026-08-09T11:50:00Z"}';
  const store = {
    get: async (k) => {
      reads += 1;
      return k === "v1/zones/AU/SA1" ? doc : null;
    },
  };
  const b = await body(await handleRequest(req("/v1/zones/AU/SA1"), {}, store, Date.parse("2026-08-09T12:00:00Z")));
  assert.equal(b.direct, 300);
  assert.equal(reads, 1);
});
