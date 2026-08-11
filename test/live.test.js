import { test } from "node:test";
import assert from "node:assert/strict";
import * as live from "../src/live.js";

const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < Math.max(eps, Math.abs(b) * 1e-4), `${a} ≈ ${b}`);

// --- ENTSO-E ---
const ENTSOE_XML = `<?xml version="1.0"?>
<GL_MarketDocument xmlns="urn:x">
  <TimeSeries>
    <inBiddingZone_Domain.mRID>10Y</inBiddingZone_Domain.mRID>
    <MktPSRType><psrType>B04</psrType></MktPSRType>
    <Period><timeInterval><start>2026-08-08T12:00Z</start><end>2026-08-08T14:00Z</end></timeInterval>
      <resolution>PT60M</resolution>
      <Point><position>1</position><quantity>800</quantity></Point>
      <Point><position>2</position><quantity>1000</quantity></Point></Period>
  </TimeSeries>
  <TimeSeries>
    <inBiddingZone_Domain.mRID>10Y</inBiddingZone_Domain.mRID>
    <MktPSRType><psrType>B16</psrType></MktPSRType>
    <Period><timeInterval><start>2026-08-08T12:00Z</start><end>2026-08-08T14:00Z</end></timeInterval>
      <resolution>PT60M</resolution>
      <Point><position>1</position><quantity>400</quantity></Point>
      <Point><position>2</position><quantity>500</quantity></Point></Period>
  </TimeSeries>
  <TimeSeries>
    <outBiddingZone_Domain.mRID>10Y</outBiddingZone_Domain.mRID>
    <MktPSRType><psrType>B10</psrType></MktPSRType>
    <Period><timeInterval><start>2026-08-08T12:00Z</start><end>2026-08-08T14:00Z</end></timeInterval>
      <resolution>PT60M</resolution>
      <Point><position>1</position><quantity>9999</quantity></Point>
      <Point><position>2</position><quantity>9999</quantity></Point></Period>
  </TimeSeries>
</GL_MarketDocument>`;

test("parseEntsoe: latest interval, load series ignored", () => {
  const [hs, he, direct] = live.parseEntsoe(ENTSOE_XML);
  approx(direct, 470000 / 1500);
  assert.equal(hs, "2026-08-08T13:00:00Z");
  assert.equal(he, "2026-08-08T14:00:00Z");
});

// --- EIA ---
const EIA_JSON = { response: { data: [
  { period: "2026-08-08T13", fueltype: "COL", value: "1000" },
  { period: "2026-08-08T13", fueltype: "NG", value: "1000" },
  { period: "2026-08-08T13", fueltype: "WND", value: "500" },
  { period: "2026-08-08T12", fueltype: "COL", value: "50000" },
] } };

test("parseEia: latest period only", () => {
  const [hs, he, direct] = live.parseEia(EIA_JSON);
  approx(direct, 1370000 / 2500);
  assert.equal(hs, "2026-08-08T13:00:00Z");
  assert.equal(he, "2026-08-08T14:00:00Z");
});

// --- UK NESO ---
test("parseUk: uses actual then forecast", () => {
  const [hs, he, d] = live.parseUk({ data: [{ from: "2026-08-08T13:00Z", to: "2026-08-08T13:30Z", intensity: { forecast: 120, actual: 133 } }] });
  assert.equal(d, 133);
  assert.equal(hs, "2026-08-08T13:00:00Z");
  assert.equal(he, "2026-08-08T13:30:00Z");
  const [, , d2] = live.parseUk({ data: [{ from: "2026-08-08T13:00Z", to: "2026-08-08T13:30Z", intensity: { forecast: 99, actual: null } }] });
  assert.equal(d2, 99);
});

// --- ONS ---
const ONS_JSON = {
  Data: "2026-08-08T13:20:00-03:00",
  sudesteECentroOeste: { geracao: { total: 40000, hidraulica: 24000, termica: 2500, eolica: 4, nuclear: 1800, solar: 3, itaipu60Hz: 6800 } },
  sul: { geracao: { total: 11000, hidraulica: 9000, termica: 800, eolica: 1300, nuclear: 0, solar: 0 } },
  nordeste: { geracao: { total: 7000, hidraulica: 1900, termica: 2700, eolica: 2800, nuclear: 0, solar: -0.1 } },
  norte: { geracao: { total: 11000, hidraulica: 9800, termica: 1300, eolica: 150, nuclear: 0, solar: 0 } },
};

test("parseOns: sums regions + hydro, blends thermal", () => {
  const [hs, he, direct] = live.parseOns(ONS_JSON);
  const total = 24000 + 2500 + 4 + 1800 + 3 + 6800 + 9000 + 800 + 1300 + 1900 + 2700 + 2800 + 9800 + 1300 + 150;
  approx(direct, (2500 + 800 + 2700 + 1300) * 550 / total);
  assert.equal(hs, "2026-08-08T16:00:00Z");
  assert.equal(he, "2026-08-08T17:00:00Z");
});

// --- OpenNEM ---
const OPENNEM_JSON = { data: [
  { type: "power", fuel_tech: null, history: { start: "2026-08-08T10:00:00+10:00", interval: "30m", data: [1, 2, 3] } },
  { type: "power", fuel_tech: "coal_black", history: { start: "2026-08-08T10:00:00+10:00", interval: "30m", data: [5000, 5200, 5400] } },
  { type: "power", fuel_tech: "wind", history: { start: "2026-08-08T10:00:00+10:00", interval: "30m", data: [1000, 1100, 1200] } },
  { type: "power", fuel_tech: "battery_discharging", history: { start: "2026-08-08T10:00:00+10:00", interval: "30m", data: [50, 60, 70] } },
] };

test("parseOpennem: latest interval, storage skipped", () => {
  const [hs, he, direct] = live.parseOpennem(OPENNEM_JSON);
  approx(direct, 5400 * 900 / (5400 + 1200));
  assert.equal(hs, "2026-08-08T01:00:00Z");
  assert.equal(he, "2026-08-08T02:00:00Z");
});

test("parseOpennem: trailing nulls skipped", () => {
  const [, , d] = live.parseOpennem({ data: [{ type: "power", fuel_tech: "coal_black", history: { start: "2026-08-08T10:00:00+10:00", interval: "30m", data: [5000, 5400, null] } }] });
  approx(d, 900);
});

// --- Singapore EMC ---
const SG_JSON = {
  Date: "08 Aug 2026", Period: "27",
  Sections: [
    { Name: "Energy", SectionData: [{ Label: "Demand", Value: "6,000MW" }, { Label: "System Loss", Value: "100MW" }] },
    { Name: "Generator Type Share", SectionData: [{ Label: "CCGT/COGEN/TRIGEN", Value: "95.00%" }, { Label: "GT", Value: "1.00%" }, { Label: "ST", Value: "4.00%" }] },
  ],
};

test("parseSg: shares applied to generation", () => {
  const [hs, he, direct] = live.parseSg(SG_JSON);
  const gen = 6100;
  approx(direct, (0.96 * gen * 470 + 0.04 * gen * 550) / gen);
  assert.equal(hs, "2026-08-08T05:00:00Z");
  assert.equal(he, "2026-08-08T06:00:00Z");
});

// --- Eskom ---
const ESKOM_LATEST = [25000, -5, 0, 0, -1000, 25000, 1800, 1000, 200, 50, 100, 600, 800, 0, 0, 0, 2500, 1500, 100, 50];
const ESKOM_EARLY = [30000, ...ESKOM_LATEST.slice(1)];
const cols = Array.from({ length: 20 }, (_, i) => `c${i}`);
const ESKOM_CSV = `Date_Time_Hour_Beginning,${cols.join(",")}\n`
  + `2026-08-08 12:00:00,${ESKOM_EARLY.join(",")}\n`
  + `2026-08-08 13:00:00,${ESKOM_LATEST.join(",")}\n`;

test("parseEskomCsv: latest row + index mapping", () => {
  const [hs, he, direct] = live.parseEskomCsv(ESKOM_CSV);
  const total = 25000 + 1800 + 300 + 50 + 600 + 2500 + 1600 + 50;
  approx(direct, (25000 * 900 + 300 * 720 + 50 * 470) / total);
  assert.equal(hs, "2026-08-08T11:00:00Z");
  assert.equal(he, "2026-08-08T12:00:00Z");
});

// --- orchestration ---
test("providerFor routing", () => {
  const expect = { GB: "NESO", US: "EIA", FR: "ENTSO-E", BR: "ONS", AU: "OpenNEM", SG: "EMC", ZA: "Eskom", LU: "ENTSO-E", MK: "ENTSO-E", BY: "ENTSO-E" };
  for (const [c, p] of Object.entries(expect)) assert.equal(live.providerFor(c), p, c);
  assert.equal(live.providerFor("NG"), null);
  // MX has no hourly source, so it must route nowhere rather than to a fetcher
  // that fails on every run.
  assert.equal(live.providerFor("MX"), null);
});

test("measuredLastHour: injected fetchers", async () => {
  const out = await live.measuredLastHour("FR", { fetchers: { "ENTSO-E": async () => ["2026-08-08T13:00:00Z", "2026-08-08T14:00:00Z", 313.3] } });
  assert.deepEqual(out, { direct: 313.3, hour_start: "2026-08-08T13:00:00Z", hour_end: "2026-08-08T14:00:00Z", source: "ENTSO-E" });
});

test("measuredLastHour: null for uncovered / failure", async () => {
  assert.equal(await live.measuredLastHour("NG", { fetchers: {} }), null);
  assert.equal(await live.measuredLastHour("GB", { fetchers: { NESO: async () => { throw new Error("down"); } } }), null);
});

// --- zones ---
test("parseOpennem: series aligned by timestamp, not array position", () => {
  // Rooftop solar starts an hour earlier and runs longer, so position 3 means a
  // different instant in each series. Aligning by index reads coal at an index
  // past the end of its array and reports solar alone.
  const [hs, , direct] = live.parseOpennem({ data: [
    { type: "power", fuel_tech: "solar_rooftop", history: { start: "2026-08-08T09:00:00+10:00", interval: "30m", data: [0, 0, 100, 200] } },
    { type: "power", fuel_tech: "coal_black", history: { start: "2026-08-08T10:00:00+10:00", interval: "30m", data: [5000, 5400] } },
  ] });
  // Newest instant both cover is 10:30+10:00 = 00:30Z: coal 5400, solar 200.
  approx(direct, 5400 * 900 / (5400 + 200));
  assert.equal(hs, "2026-08-08T00:00:00Z");
});

test("zonesFor: only zone-capable countries", () => {
  assert.deepEqual(live.zonesFor("DK"), ["DK1", "DK2"]);
  assert.equal(live.zonesFor("FR").length, 0);
  assert.equal(live.zonesFor("it").length, 7);
});

test("measuredLastHour: unknown zone is null, known zone reaches provider", async () => {
  assert.equal(await live.measuredLastHour("IT", { zone: "NOPE", fetchers: {} }), null);
  const r = await live.measuredLastHour("AU", {
    zone: "SA1",
    fetchers: { OpenNEM: async () => ["2026-08-08T01:00:00Z", "2026-08-08T02:00:00Z", 120] },
  });
  assert.equal(r.direct, 120);
});

test("measuredLastHour: retries a transient failure, gives up after attempts", async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls < 3) throw new Error("blip");
    return ["2026-08-08T01:00:00Z", "2026-08-08T02:00:00Z", 120];
  };
  const r = await live.measuredLastHour("AU", { zone: "SA1", attempts: 3, backoffMs: 1, fetchers: { OpenNEM: flaky } });
  assert.equal(r.direct, 120);
  assert.equal(calls, 3);

  calls = 0;
  const dead = async () => { calls += 1; throw new Error("down"); };
  assert.equal(await live.measuredLastHour("AU", { attempts: 2, backoffMs: 1, fetchers: { OpenNEM: dead } }), null);
  assert.equal(calls, 2);
});
