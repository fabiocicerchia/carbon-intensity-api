import assert from "node:assert/strict";
import { test } from "node:test";
import { COUNTRIES, lastHour, listCountries, resolveCode, sourceFor, UnknownCountry } from "../src/data.js";

test("covers all countries", () => {
  assert.ok(Object.keys(COUNTRIES).length >= 200);
  for (const c of ["DE", "US", "CN", "IN", "BR", "ZA", "AU", "NG", "EG", "SA", "ID", "AR"]) {
    assert.ok(COUNTRIES[c], c);
  }
});

test("resolveCode by iso2 / iso3, either case, trimmed", () => {
  assert.equal(resolveCode("de"), "DE");
  assert.equal(resolveCode(" FR "), "FR");
  assert.equal(resolveCode("DEU"), "DE");
  assert.equal(resolveCode("usa"), "US");
});

test("resolveCode rejects names and aliases", () => {
  // ISO codes only: one canonical URL per country, and no English-only alias
  // table to keep complete.
  for (const name of ["Germany", "united kingdom", "South Korea", "Vietnam", "Atlantis", ""]) {
    assert.throws(() => resolveCode(name), UnknownCountry, `expected ${JSON.stringify(name)} to be rejected`);
  }
});

test("annual reading shape", () => {
  const r = lastHour("DE");
  assert.equal(r.country, "Germany");
  assert.equal(r.country_code, "DE");
  assert.equal(r.unit, "gCO2eq/kWh");
  // No hour window: a yearly figure describes no particular hour, and stamping
  // one claimed a precision it does not have.
  assert.equal(r.hour_start, null);
  assert.equal(r.hour_end, null);
  assert.equal(r.basis, "annual-average");
  assert.equal(r.direct, COUNTRIES.DE.direct);
  // An annual-average reading names the annual dataset, not DE's realtime
  // provider — that provider produced none of this number.
  assert.equal(r.data_source.realtime, false);
  assert.equal(r.data_source.status, "annual-average");
  assert.match(r.data_source.name, /Ember/);
});

test("estimated tracks basis; zone is always present", () => {
  const measured = {
    direct: 90,
    hour_start: "2026-08-08T13:00:00Z",
    hour_end: "2026-08-08T14:00:00Z",
    source: "ENTSO-E",
  };
  // `estimated` is derived from `basis`, so the two cannot disagree — which is
  // the only reason it is safe to publish both.
  const annual = lastHour("DE");
  assert.equal(annual.estimated, true);
  assert.equal(annual.zone, "DE"); // country reading: echoes country_code
  const live = lastHour("DE", { measured });
  assert.equal(live.estimated, false);
  assert.equal(lastHour("IT", { zone: "SICI", measured }).zone, "SICI");
  assert.equal(listCountries().find((c) => c.country_code === "DE").zone, "DE");
});

test("measured reading uses provider values + deltas", () => {
  const rec = COUNTRIES.DE;
  const r = lastHour("DE", {
    measured: { direct: 90.4, hour_start: "2026-08-08T13:00:00Z", hour_end: "2026-08-08T14:00:00Z", source: "ENTSO-E" },
  });
  assert.equal(r.direct, 90);
  assert.equal(r.lifecycle, 90 + rec.lifecycleDelta);
  assert.equal(r.consumption_direct, 90 + rec.consumptionDelta);
  // Trade-adjusted but still operational: the import delta applies to `direct`,
  // not to `lifecycle`, which is what the field name has to say out loud.
  assert.equal(r.consumption_direct, r.direct + rec.consumptionDelta);
  assert.notEqual(r.consumption_direct, r.lifecycle + rec.consumptionDelta);
  assert.equal(r.basis, "measured");
  assert.equal(r.data_source.name, "ENTSO-E");
  assert.equal(r.data_source.realtime, true);
});

test("lifecycle >= direct for every country", () => {
  for (const code of Object.keys(COUNTRIES)) {
    const r = lastHour(code);
    assert.ok(r.direct >= 0);
    assert.ok(r.lifecycle >= r.direct, code);
  }
});

test("sources registry: shape + proposed + none", () => {
  for (const code of Object.keys(COUNTRIES)) {
    const rec = sourceFor(code);
    assert.deepEqual(Object.keys(rec).sort(), ["name", "realtime", "ref", "status", "url"]);
    assert.ok(["operational", "proposed", "none"].includes(rec.status));
  }
  // AL is still a proposed-but-unbuilt source. MX is not: CENACE publishes
  // generation by technology only as a monthly settled export, so there is no
  // hourly feed to build, and advertising realtime for it was a promise the
  // pipeline could not keep.
  const al = sourceFor("AL");
  assert.equal(al.realtime, true);
  assert.equal(al.status, "proposed");
  // Host-checked rather than substring-matched: `.includes("github.com")` is
  // also true of "github.com.example.net" (CodeQL js/incomplete-url-substring-sanitization).
  assert.ok(al.ref && new URL(al.ref).hostname === "github.com");
  assert.equal(sourceFor("MX").realtime, false);
  assert.equal(sourceFor("AF").realtime, false);
});

test("listCountries exposes realtime_available", () => {
  const cs = listCountries();
  assert.ok(cs.length >= 200);
  assert.equal(cs.find((c) => c.country_code === "DE").realtime_available, true);
});

test("the four figures are the corners of the two axes", () => {
  const rec = COUNTRIES.CH; // a heavy importer, where the corners differ most
  const r = lastHour("CH");
  assert.equal(r.lifecycle, r.direct + rec.lifecycleDelta); // scope
  assert.equal(r.consumption_direct, r.direct + rec.consumptionDelta); // boundary
  assert.equal(r.consumption_lifecycle, r.direct + rec.lifecycleDelta + rec.consumptionDelta);
  // Not a ladder: for an importer the trade-adjusted operational figure exceeds
  // the production lifecycle one while counting less of the supply chain.
  assert.ok(r.consumption_direct > r.lifecycle);
  assert.ok(r.consumption_lifecycle > r.consumption_direct);
});

test("zone readings carry neither consumption figure", () => {
  const measured = {
    direct: 100,
    hour_start: "2026-08-08T13:00:00Z",
    hour_end: "2026-08-08T14:00:00Z",
    source: "ENTSO-E",
  };
  const r = lastHour("IT", { zone: "SICI", measured });
  assert.equal(r.consumption_direct, undefined);
  assert.equal(r.consumption_lifecycle, undefined);
  assert.equal(r.lifecycle, 100 + COUNTRIES.IT.lifecycleDelta);
});
