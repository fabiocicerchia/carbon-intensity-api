import assert from "node:assert/strict";
import { test } from "node:test";
import { energyChartsFuel } from "../src/factors.js";
import * as live from "../src/live.js";

// Every parser now returns a series; v1 is defined as its newest point. Reading
// the existing assertions through `v1()` keeps them as the guard that widening
// the parsers did not move the v1 objects.
const hourly = (direct) => ({
  resolution_sec: 3600,
  points: [{ start: "2026-08-08T01:00:00Z", end: "2026-08-08T02:00:00Z", direct }],
});

const v1 = (s) => {
  const r = live.newestReading(s);
  return [r.hour_start, r.hour_end, r.direct];
};

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

// The real DE reply of 2026-08-30T09:45Z, trimmed to the fields the parser
// reads: curveType A03, one point per fuel, and the pumped-storage consumption
// series last. What ENTSO-E published as it came back from maintenance.
const A03_SERIES = (mRID, psr, qty, dir = "in") => `
  <TimeSeries><mRID>${mRID}</mRID><businessType>A01</businessType>
    <${dir}BiddingZone_Domain.mRID codingScheme="A01">10Y1001A1001A83F</${dir}BiddingZone_Domain.mRID>
    <curveType>A03</curveType><MktPSRType><psrType>${psr}</psrType></MktPSRType>
    <Period><timeInterval><start>2026-08-29T21:00Z</start><end>2026-08-29T21:15Z</end></timeInterval>
      <resolution>PT15M</resolution>
      <Point><position>1</position><quantity>${qty}</quantity></Point></Period>
  </TimeSeries>`;

const ENTSOE_A03 = `<?xml version="1.0" encoding="utf-8"?>
<GL_MarketDocument xmlns="urn:x"><type>A75</type>
${[
  ["1", "B01", 3975.30173],
  ["2", "B02", 5383.24911],
  ["3", "B03", 492.08296],
  ["4", "B04", 2226.29828],
  ["5", "B05", 1914.74533],
  ["6", "B06", 385.2039],
  ["7", "B09", 19.24709],
  ["8", "B10", 3669.4013],
  ["9", "B11", 1136.4492],
  ["10", "B12", 51.8561],
  ["11", "B15", 70.451],
  ["12", "B16", 0],
  ["13", "B17", 893.5191],
  ["14", "B18", 2840.844],
  ["15", "B19", 20817.14803],
  ["16", "B20", 137.55243],
]
  .map(([m, psr, q]) => A03_SERIES(m, psr, q))
  .join("")}
${A03_SERIES("17", "B10", 13.0604, "out")}
</GL_MarketDocument>`;

test("parseEntsoe: the real A03 reply parses to one quarter-hour of the true mix", () => {
  const s = live.parseEntsoe(ENTSOE_A03);
  assert.equal(s.resolution_sec, 900);
  assert.equal(s.points.length, 1);
  assert.equal(s.points[0].start, "2026-08-29T21:00:00Z");
  assert.equal(s.points[0].end, "2026-08-29T21:15:00Z");

  // Computed from the document rather than asserted as a magic number: lignite
  // and hard coal against 23 GW of wind. The band is what matters — a mix this
  // wind-heavy but still burning lignite cannot be near zero or near coal.
  const fossil =
    5383.24911 * 1150 +
    1914.74533 * 900 +
    2226.29828 * 470 +
    492.08296 * 700 +
    385.2039 * 720 +
    893.5191 * 300 +
    19.24709 * 40;
  const total =
    3975.30173 +
    5383.24911 +
    492.08296 +
    2226.29828 +
    1914.74533 +
    385.2039 +
    19.24709 +
    3669.4013 +
    1136.4492 +
    51.8561 +
    70.451 +
    893.5191 +
    2840.844 +
    20817.14803 +
    137.55243;
  approx(s.points[0].direct, fossil / total);

  // The pumped-storage CONSUMPTION series must not have been counted as hydro
  // generation: it would have moved the denominator by 13 MW.
  assert.ok(s.points[0].direct > 200 && s.points[0].direct < 300);
});

test("parseEntsoe: a sparse A03 series holds until its next position", () => {
  // Nuclear reported once, solar every quarter hour — which is exactly what
  // "variable sized blocks" means. Reading only the positions present would
  // leave positions 2-4 as solar alone, near 0 gCO2 instead of near nuclear's
  // share of a mostly-nuclear grid.
  const xml = `<?xml version="1.0"?>
<GL_MarketDocument xmlns="urn:x">
  <TimeSeries><inBiddingZone_Domain.mRID>10Y</inBiddingZone_Domain.mRID>
    <curveType>A03</curveType><MktPSRType><psrType>B05</psrType></MktPSRType>
    <Period><timeInterval><start>2026-08-29T21:00Z</start><end>2026-08-29T22:00Z</end></timeInterval>
      <resolution>PT15M</resolution>
      <Point><position>1</position><quantity>1000</quantity></Point></Period>
  </TimeSeries>
  <TimeSeries><inBiddingZone_Domain.mRID>10Y</inBiddingZone_Domain.mRID>
    <curveType>A03</curveType><MktPSRType><psrType>B16</psrType></MktPSRType>
    <Period><timeInterval><start>2026-08-29T21:00Z</start><end>2026-08-29T22:00Z</end></timeInterval>
      <resolution>PT15M</resolution>
      <Point><position>1</position><quantity>1000</quantity></Point>
      <Point><position>2</position><quantity>1000</quantity></Point>
      <Point><position>3</position><quantity>1000</quantity></Point>
      <Point><position>4</position><quantity>1000</quantity></Point></Period>
  </TimeSeries>
</GL_MarketDocument>`;
  const s = live.parseEntsoe(xml);
  assert.equal(s.points.length, 4);
  // Hard coal 1000 + solar 1000 at every position: 900 * 1000 / 2000 = 450.
  for (const p of s.points) approx(p.direct, 450);
});

test("measuredLastHour: a refusal is not retried, a dropped connection is", async () => {
  const ack =
    '<?xml version="1.0"?><Acknowledgement_MarketDocument><Reason>' +
    "<code>999</code><text>No matching data found</text></Reason></Acknowledgement_MarketDocument>";
  let calls = 0;
  // The fetcher is the real parser, so the test exercises the flag the parser
  // actually sets rather than a stand-in for it.
  const refuse = async () => {
    calls += 1;
    return live.parseEntsoe(ack);
  };
  await live.measuredLastHour("FR", { attempts: 3, backoffMs: 1, fetchers: { "ENTSO-E": refuse } });
  assert.equal(calls, 1, "the platform answered; asking again changes nothing");

  calls = 0;
  const flaky = async () => {
    calls += 1;
    throw new Error("socket hang up");
  };
  await live.measuredLastHour("FR", { attempts: 3, backoffMs: 1, fetchers: { "ENTSO-E": flaky } });
  assert.equal(calls, 3);
});

test("an HTML error body is summarised, and not retried", async () => {
  // ENTSO-E's maintenance page arrived with a 200 in August and with a 503 in
  // September. parseEntsoe caught the first; get() has to catch the second, or
  // 300 characters of stylesheet lands in the log for every failed request and
  // the run retries a page that will be identical eight seconds later.
  const page =
    '<!doctype html><html lang="en"><head><title>Transparency Platform</title>' +
    "<style>:root{--header-height:70px;--page-bg:linear-gradient(to right,rgb(142,196,182));}</style>" +
    "</head><body><div>Service Temporarily Unavailable</div></body></html>";
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(page, { status: 503 });
  try {
    await live.fetchEnergyCharts("de");
    assert.fail("should have thrown");
  } catch (e) {
    assert.match(e.message, /HTML page "Transparency Platform", not data: provider maintenance\?/);
    assert.equal(e.message.includes("--header-height"), false, "no stylesheet in the log");
    assert.equal(e.retryable, false, "the platform will serve the same page again");
  } finally {
    globalThis.fetch = real;
  }
});

test("a non-HTML error body is kept, since that is where the reason lives", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response("Rate limit exceeded: 400 requests per minute", { status: 429 });
  try {
    await live.fetchEnergyCharts("de");
    assert.fail("should have thrown");
  } catch (e) {
    assert.match(e.message, /Rate limit exceeded/);
    assert.equal(e.retryable, true);
  } finally {
    globalThis.fetch = real;
  }
});

test("parseEntsoe: a refusal and a maintenance page each say so", () => {
  // The platform is up and telling us it holds nothing for the window. This is
  // the reply that took a day to find by hand; it belongs in the run log.
  const ack = `<?xml version="1.0"?>
<Acknowledgement_MarketDocument xmlns="urn:x">
  <Reason><code>999</code><text>No matching data found for Data item AGGREGATED_GENERATION_PER_TYPE_R3 [16.1.B&amp;C] (10Y1001A1001A83F) and interval 2026-08-29T21:00:00Z/2026-08-30T09:00:00Z.</text></Reason>
</Acknowledgement_MarketDocument>`;
  assert.throws(() => live.parseEntsoe(ack), /acknowledgement 999: No matching data found/);

  // The platform is down. Its maintenance page is HTML and is not always served
  // with a 5xx, so it can reach the parser looking like a successful fetch.
  const page = `<!doctype html>
<html lang="en"><head><title>Transparency Platform</title></head>
<body><div class="main-heading">Service Temporarily Unavailable</div></body></html>`;
  assert.throws(() => live.parseEntsoe(page), /no market document \(an HTML page: "Transparency Platform"\)/);

  // A real document with nothing usable in it keeps the old message: that one
  // is about the data, not about reaching the provider.
  const empty = `<?xml version="1.0"?><GL_MarketDocument xmlns="urn:x"></GL_MarketDocument>`;
  assert.throws(() => live.parseEntsoe(empty), /contained no usable generation data/);
});

test("parseEntsoe: latest interval, load series ignored", () => {
  const [hs, he, direct] = v1(live.parseEntsoe(ENTSOE_XML));
  approx(direct, 470000 / 1500);
  assert.equal(hs, "2026-08-08T13:00:00Z");
  assert.equal(he, "2026-08-08T14:00:00Z");
});

test("parseEntsoe: every point is returned, not just the newest", () => {
  const s = live.parseEntsoe(ENTSOE_XML);
  assert.equal(s.resolution_sec, 3600);
  assert.equal(s.points.length, 2);
  // Position 1 was being discarded entirely: gas 800 + solar 400.
  approx(s.points[0].direct, (800 * 470) / 1200);
  assert.equal(s.points[0].start, "2026-08-08T12:00:00Z");
  assert.equal(s.points[0].end, "2026-08-08T13:00:00Z");
  approx(s.points[1].direct, 470000 / 1500);
  // Oldest first, so the newest point is the last one.
  assert.ok(s.points[0].start < s.points[1].start);
});

// PT15M: the resolution Italy actually publishes at, and the reason an hourly
// mean was not computable before — four points per hour, one kept.
const ENTSOE_15M = `<?xml version="1.0"?>
<GL_MarketDocument xmlns="urn:x">
  <TimeSeries>
    <inBiddingZone_Domain.mRID>10Y</inBiddingZone_Domain.mRID>
    <MktPSRType><psrType>B04</psrType></MktPSRType>
    <Period><timeInterval><start>2026-08-08T12:00Z</start><end>2026-08-08T13:00Z</end></timeInterval>
      <resolution>PT15M</resolution>
      <Point><position>1</position><quantity>1000</quantity></Point>
      <Point><position>2</position><quantity>1000</quantity></Point>
      <Point><position>3</position><quantity>1000</quantity></Point>
      <Point><position>4</position><quantity>1000</quantity></Point></Period>
  </TimeSeries>
  <TimeSeries>
    <inBiddingZone_Domain.mRID>10Y</inBiddingZone_Domain.mRID>
    <MktPSRType><psrType>B16</psrType></MktPSRType>
    <Period><timeInterval><start>2026-08-08T12:00Z</start><end>2026-08-08T13:00Z</end></timeInterval>
      <resolution>PT15M</resolution>
      <Point><position>1</position><quantity>0</quantity></Point>
      <Point><position>2</position><quantity>1000</quantity></Point>
      <Point><position>3</position><quantity>3000</quantity></Point>
      <Point><position>4</position><quantity>1000</quantity></Point></Period>
  </TimeSeries>
</GL_MarketDocument>`;

test("parseEntsoe: PT15M yields four points with the mix summed per position", () => {
  const s = live.parseEntsoe(ENTSOE_15M);
  assert.equal(s.resolution_sec, 900);
  assert.equal(live.pointsPerHour(s.resolution_sec), 4);
  assert.equal(s.points.length, 4);
  assert.deepEqual(
    s.points.map((p) => p.start),
    ["2026-08-08T12:00:00Z", "2026-08-08T12:15:00Z", "2026-08-08T12:30:00Z", "2026-08-08T12:45:00Z"],
  );
  assert.equal(s.points[0].end, "2026-08-08T12:15:00Z");
  // Solar rises across the hour, so intensity falls — the whole point of
  // keeping every position rather than the last.
  approx(s.points[0].direct, 470); // 1000 gas, no solar
  approx(s.points[1].direct, (1000 * 470) / 2000);
  approx(s.points[2].direct, (1000 * 470) / 4000);
  approx(s.points[3].direct, (1000 * 470) / 2000);
  // The hour's true mean, and the number v1 reported for the same hour by
  // keeping only the last point. 264.375 vs 235 — a 12% error, which is what
  // taking a sample for a mean costs.
  const mean = s.points.reduce((a, p) => a + p.direct, 0) / 4;
  approx(mean, 264.375);
  approx(s.points[3].direct, 235);
});

test("parseEntsoe: a point with nothing usable is skipped, not zero-filled", () => {
  const s = live.parseEntsoe(
    ENTSOE_15M.replace(
      "<Point><position>1</position><quantity>1000</quantity></Point>\n      <Point><position>2</position><quantity>1000</quantity></Point>",
      "<Point><position>2</position><quantity>1000</quantity></Point>",
    ),
  );
  // Position 1 now has only solar (0 MW) -> no usable generation -> dropped,
  // and the remaining positions keep their own instants rather than shifting up.
  assert.equal(s.points.length, 3);
  assert.equal(s.points[0].start, "2026-08-08T12:15:00Z");
});

// --- EIA ---
const EIA_JSON = {
  response: {
    data: [
      { period: "2026-08-08T13", fueltype: "COL", value: "1000" },
      { period: "2026-08-08T13", fueltype: "NG", value: "1000" },
      { period: "2026-08-08T13", fueltype: "WND", value: "500" },
      { period: "2026-08-08T12", fueltype: "COL", value: "50000" },
    ],
  },
};

test("parseEia: latest period only", () => {
  const [hs, he, direct] = v1(live.parseEia(EIA_JSON));
  approx(direct, 1370000 / 2500);
  assert.equal(hs, "2026-08-08T13:00:00Z");
  assert.equal(he, "2026-08-08T14:00:00Z");
});

test("parseEia: one point per period, hourly, ascending", () => {
  const s = live.parseEia(EIA_JSON);
  assert.equal(s.resolution_sec, 3600);
  assert.equal(live.pointsPerHour(s.resolution_sec), 1); // an hourly feed fills an hour with one point
  assert.equal(s.points.length, 2);
  assert.deepEqual(
    s.points.map((p) => p.start),
    ["2026-08-08T12:00:00Z", "2026-08-08T13:00:00Z"],
  );
  approx(s.points[0].direct, 900); // the 12:00 row: 50000 MW of coal alone
});

test("parseIeso: every reporting hour is a point", () => {
  const s = live.parseIeso(
    ieso("2026-08-15", [
      [
        "NUCLEAR",
        [
          [5, 9000],
          [6, 9000],
        ],
      ],
      [
        "GAS",
        [
          [5, 1000],
          [6, 2000],
        ],
      ],
    ]),
  );
  assert.equal(s.resolution_sec, 3600);
  assert.equal(s.points.length, 2);
  assert.equal(s.points[0].start, "2026-08-15T08:00:00Z");
  assert.equal(s.points[1].start, "2026-08-15T09:00:00Z");
  approx(s.points[0].direct, (1000 * 470) / 10000);
  approx(s.points[1].direct, (2000 * 470) / 11000);
});

test("a snapshot provider reports one point covering its clock hour", () => {
  // OpenNEM/EMC/Eskom/ONS give one value per fetch, so resolution_sec is 3600
  // and that point stands for the whole hour. Declaring their true sub-hourly
  // granularity would leave every hour permanently incomplete instead.
  for (const s of [
    live.parseOpennem(OPENNEM_JSON),
    live.parseSg(SG_JSON),
    live.parseEskomCsv(ESKOM_CSV),
    live.parseOns(ONS_JSON),
  ]) {
    assert.equal(s.resolution_sec, 3600);
    assert.equal(s.points.length, 1);
    const p = s.points[0];
    assert.ok(p.start.endsWith("00:00Z"), p.start);
    assert.equal(Date.parse(p.end) - Date.parse(p.start), 3600 * 1000);
  }
});

// --- UK NESO ---
test("parseUk: uses actual then forecast", () => {
  const [hs, he, d] = v1(
    live.parseUk({
      data: [{ from: "2026-08-08T13:00Z", to: "2026-08-08T13:30Z", intensity: { forecast: 120, actual: 133 } }],
    }),
  );
  assert.equal(d, 133);
  assert.equal(hs, "2026-08-08T13:00:00Z");
  assert.equal(he, "2026-08-08T13:30:00Z");
  const [, , d2] = v1(
    live.parseUk({
      data: [{ from: "2026-08-08T13:00Z", to: "2026-08-08T13:30Z", intensity: { forecast: 99, actual: null } }],
    }),
  );
  assert.equal(d2, 99);
});

test("parseUk: the day feed completes an hour the current period cannot", () => {
  // /intensity is one period; the settled day feed carries the other half. The
  // real payloads: the day feed lags a period and its tail is future forecasts.
  const now = {
    data: [{ from: "2026-08-27T09:30Z", to: "2026-08-27T10:00Z", intensity: { forecast: 127, actual: 126 } }],
  };
  const dayFeed = {
    data: [
      { from: "2026-08-27T08:30Z", to: "2026-08-27T09:00Z", intensity: { forecast: 120, actual: 118 } },
      { from: "2026-08-27T09:00Z", to: "2026-08-27T09:30Z", intensity: { forecast: 124, actual: 130 } },
      { from: "2026-08-27T09:30Z", to: "2026-08-27T10:00Z", intensity: { forecast: 127, actual: null } },
      { from: "2026-08-27T22:30Z", to: "2026-08-27T23:00Z", intensity: { forecast: 208, actual: null } },
    ],
  };
  const s = live.parseUk(now, dayFeed);
  assert.equal(s.resolution_sec, 1800);
  assert.equal(live.pointsPerHour(s.resolution_sec), 2);
  // The 22:30 forecast is 12 hours in the future and must never appear.
  assert.deepEqual(
    s.points.map((p) => p.start),
    ["2026-08-27T08:30:00Z", "2026-08-27T09:00:00Z", "2026-08-27T09:30:00Z"],
  );
  // The day feed had no actual for 09:30; the current period supplies it, and
  // keying by start means it replaces rather than duplicates.
  assert.equal(s.points[2].direct, 126);
  // v1 still reads the current period, unchanged by the widening.
  assert.deepEqual(v1(s), ["2026-08-27T09:30:00Z", "2026-08-27T10:00:00Z", 126]);
  // Hour 09 now holds both of its halves, which is what lets it complete:
  // two points is exactly pointsPerHour(1800).
  const hour09 = s.points.filter((p) => p.start.startsWith("2026-08-27T09"));
  assert.equal(hour09.length, live.pointsPerHour(s.resolution_sec));
  assert.equal(hour09.reduce((a, p) => a + p.direct, 0) / hour09.length, 128);
});

test("parseUk: without the day feed it degrades to the single period", () => {
  const s = live.parseUk({
    data: [{ from: "2026-08-27T09:30Z", to: "2026-08-27T10:00Z", intensity: { actual: 126 } }],
  });
  assert.equal(s.points.length, 1);
  assert.deepEqual(v1(s), ["2026-08-27T09:30:00Z", "2026-08-27T10:00:00Z", 126]);
});

// --- ONS ---
const ONS_JSON = {
  Data: "2026-08-08T13:20:00-03:00",
  sudesteECentroOeste: {
    geracao: { total: 40000, hidraulica: 24000, termica: 2500, eolica: 4, nuclear: 1800, solar: 3, itaipu60Hz: 6800 },
  },
  sul: { geracao: { total: 11000, hidraulica: 9000, termica: 800, eolica: 1300, nuclear: 0, solar: 0 } },
  nordeste: { geracao: { total: 7000, hidraulica: 1900, termica: 2700, eolica: 2800, nuclear: 0, solar: -0.1 } },
  norte: { geracao: { total: 11000, hidraulica: 9800, termica: 1300, eolica: 150, nuclear: 0, solar: 0 } },
};

test("parseOns: sums regions + hydro, blends thermal", () => {
  const [hs, he, direct] = v1(live.parseOns(ONS_JSON));
  const total = 24000 + 2500 + 4 + 1800 + 3 + 6800 + 9000 + 800 + 1300 + 1900 + 2700 + 2800 + 9800 + 1300 + 150;
  approx(direct, ((2500 + 800 + 2700 + 1300) * 550) / total);
  assert.equal(hs, "2026-08-08T16:00:00Z");
  assert.equal(he, "2026-08-08T17:00:00Z");
});

// --- OpenNEM ---
const OPENNEM_JSON = {
  data: [
    {
      type: "power",
      fuel_tech: null,
      history: { start: "2026-08-08T10:00:00+10:00", interval: "30m", data: [1, 2, 3] },
    },
    {
      type: "power",
      fuel_tech: "coal_black",
      history: { start: "2026-08-08T10:00:00+10:00", interval: "30m", data: [5000, 5200, 5400] },
    },
    {
      type: "power",
      fuel_tech: "wind",
      history: { start: "2026-08-08T10:00:00+10:00", interval: "30m", data: [1000, 1100, 1200] },
    },
    {
      type: "power",
      fuel_tech: "battery_discharging",
      history: { start: "2026-08-08T10:00:00+10:00", interval: "30m", data: [50, 60, 70] },
    },
  ],
};

test("parseOpennem: latest interval, storage skipped", () => {
  const [hs, he, direct] = v1(live.parseOpennem(OPENNEM_JSON));
  approx(direct, (5400 * 900) / (5400 + 1200));
  assert.equal(hs, "2026-08-08T01:00:00Z");
  assert.equal(he, "2026-08-08T02:00:00Z");
});

test("parseOpennem: trailing nulls skipped", () => {
  const [, , d] = v1(
    live.parseOpennem({
      data: [
        {
          type: "power",
          fuel_tech: "coal_black",
          history: { start: "2026-08-08T10:00:00+10:00", interval: "30m", data: [5000, 5400, null] },
        },
      ],
    }),
  );
  approx(d, 900);
});

// --- Singapore EMC ---
const SG_JSON = {
  Date: "08 Aug 2026",
  Period: "27",
  Sections: [
    {
      Name: "Energy",
      SectionData: [
        { Label: "Demand", Value: "6,000MW" },
        { Label: "System Loss", Value: "100MW" },
      ],
    },
    {
      Name: "Generator Type Share",
      SectionData: [
        { Label: "CCGT/COGEN/TRIGEN", Value: "95.00%" },
        { Label: "GT", Value: "1.00%" },
        { Label: "ST", Value: "4.00%" },
      ],
    },
  ],
};

test("parseSg: shares applied to generation", () => {
  const [hs, he, direct] = v1(live.parseSg(SG_JSON));
  const gen = 6100;
  approx(direct, (0.96 * gen * 470 + 0.04 * gen * 550) / gen);
  assert.equal(hs, "2026-08-08T05:00:00Z");
  assert.equal(he, "2026-08-08T06:00:00Z");
});

// --- Eskom ---
const ESKOM_LATEST = [25000, -5, 0, 0, -1000, 25000, 1800, 1000, 200, 50, 100, 600, 800, 0, 0, 0, 2500, 1500, 100, 50];
const ESKOM_EARLY = [30000, ...ESKOM_LATEST.slice(1)];
const cols = Array.from({ length: 20 }, (_, i) => `c${i}`);
const ESKOM_CSV =
  `Date_Time_Hour_Beginning,${cols.join(",")}\n` +
  `2026-08-08 12:00:00,${ESKOM_EARLY.join(",")}\n` +
  `2026-08-08 13:00:00,${ESKOM_LATEST.join(",")}\n`;

test("parseEskomCsv: latest row + index mapping", () => {
  const [hs, he, direct] = v1(live.parseEskomCsv(ESKOM_CSV));
  const total = 25000 + 1800 + 300 + 50 + 600 + 2500 + 1600 + 50;
  approx(direct, (25000 * 900 + 300 * 720 + 50 * 470) / total);
  assert.equal(hs, "2026-08-08T11:00:00Z");
  assert.equal(he, "2026-08-08T12:00:00Z");
});

// --- orchestration ---
// The fuel rows Elexon's FUELINST returned live on 2026-08-30, one instant's
// worth. The INT* rows are interconnector flows, not GB generation, and two of
// them are negative exports.
const FUELINST_ROWS = [
  ["BIOMASS", 3213],
  ["CCGT", 1912],
  ["COAL", 0],
  ["INTELEC", 959],
  ["INTEW", -531],
  ["INTFR", 1963],
  ["INTGRNL", -513],
  ["INTIFA2", 991],
  ["INTIRL", -452],
  ["INTNED", 1039],
  ["INTNEM", 852],
  ["INTNSL", 0],
  ["NPSHYD", 186],
  ["NUCLEAR", 4950],
  ["OCGT", 50],
  ["OIL", 0],
  ["OTHER", 684],
  ["PS", 834],
  ["WIND", 1952],
];

test("parseElexon: interconnectors are not generation", () => {
  const at = (t) =>
    FUELINST_ROWS.map(([fuelType, generation]) => ({
      startTime: t,
      fuelType,
      generation,
    }));
  const s = live.parseElexon({ data: [...at("2026-08-30T10:45:00Z"), ...at("2026-08-30T10:50:00Z")] });

  assert.equal(s.resolution_sec, 300); // read off the five-minute spacing
  assert.equal(s.points.length, 2);

  // Only the domestic rows count. Imports carry their own grids' intensity and
  // the exports are negative, so folding INT* in would corrupt both the
  // numerator and the denominator.
  const gen = {
    biomass: 3213,
    gas: 1912 + 50,
    hard_coal: 0,
    hydro: 186 + 834,
    nuclear: 4950,
    oil: 0,
    other: 684,
    wind: 1952,
  };
  const total = Object.values(gen).reduce((a, b) => a + b, 0);
  const weighted = 1962 * 470 + 684 * 0; // gas is the only emitter left alight
  approx(s.points[0].direct, weighted / total);

  // Sanity against the live reading this fixture was taken from: a GB grid on
  // nuclear and wind with one CCGT sits in the tens, not the hundreds.
  assert.ok(s.points[0].direct > 30 && s.points[0].direct < 120, "plausible GB figure");
});

test("parseElexon: a payload of nothing but interconnectors is refused", () => {
  assert.throws(
    () => live.parseElexon({ data: [{ startTime: "2026-08-30T10:45:00Z", fuelType: "INTFR", generation: 1963 }] }),
    /no recognised generation rows/,
  );
  assert.throws(() => live.parseElexon({ data: [] }), /no data rows/);
});

// Every series name the live DE feed returned on 2026-08-30, in its own order.
// Pinned because the mapping is matched on prose the feed is free to reword, and
// a silent reclassification here moves a whole country's figures.
const ENERGY_CHARTS_NAMES = [
  "Hydro pumped storage consumption",
  "Cross border electricity trading",
  "Hydro Run-of-River",
  "Biomass",
  "Fossil brown coal / lignite",
  "Fossil hard coal",
  "Fossil oil",
  "Fossil coal-derived gas",
  "Fossil gas",
  "Geothermal",
  "Hydro water reservoir",
  "Hydro pumped storage",
  "Others",
  "Waste",
  "Wind offshore",
  "Wind onshore",
  "Solar",
  "Load",
  "Residual load",
  "Renewable share of load",
  "Renewable share of generation",
];

test("energyChartsFuel: every live series is classified, and the traps are dropped", () => {
  const got = Object.fromEntries(ENERGY_CHARTS_NAMES.map((n) => [n, energyChartsFuel(n)]));

  // Load, residual load, trading, the share percentages and pumped-storage
  // demand are not generation. Counting "Load" would put demand in the
  // denominator and roughly halve the intensity.
  for (const n of [
    "Load",
    "Residual load",
    "Renewable share of load",
    "Renewable share of generation",
    "Cross border electricity trading",
    "Hydro pumped storage consumption",
  ]) {
    assert.equal(got[n], null, n);
  }

  // Coal-derived gas is ENTSO-E's B03 and must not be read as hard coal: 700
  // against 900, on a series that runs to hundreds of MW.
  assert.equal(got["Fossil coal-derived gas"], "other_fossil");
  assert.equal(got["Fossil hard coal"], "hard_coal");
  assert.equal(got["Fossil brown coal / lignite"], "lignite");
  assert.equal(got["Fossil gas"], "gas");
  // "Others" is this feed's B20 — mapped, not dropped, so it lands in the
  // denominator exactly as it does on the primary.
  assert.equal(got.Others, "other");
  assert.equal(got["Hydro pumped storage"], "hydro");
  assert.equal(got["Wind offshore"], "wind");

  // Nothing in the live payload may go unclassified without being a known trap.
  const unmapped = ENERGY_CHARTS_NAMES.filter((n) => got[n] === null);
  assert.equal(unmapped.length, 6, `unexpected unmapped series: ${unmapped}`);
});

test("parseEnergyCharts: fuels are summed per instant, non-generation dropped", () => {
  const s = live.parseEnergyCharts({
    unix_seconds: [1756500000, 1756500900],
    production_types: [
      { name: "Fossil hard coal", data: [1000, 1000] },
      { name: "Solar", data: [1000, 0] },
      { name: "Load", data: [50000, 50000] },
      { name: "Residual load", data: [40000, 40000] },
      { name: "Cross border electricity trading", data: [-2000, -2000] },
      { name: "Renewable share of generation", data: [55, 55] },
      { name: "Hydro pumped storage consumption", data: [900, 900] },
    ],
  });
  assert.equal(s.resolution_sec, 900); // read off the timestamp spacing
  assert.equal(s.points.length, 2);
  approx(s.points[0].direct, (900 * 1000) / 2000); // coal + solar
  approx(s.points[1].direct, 900); // solar zero, coal alone
});

test("parseEnergyCharts: a payload it cannot read is refused, not guessed at", () => {
  // Relabelled series would otherwise yield a mix built from whatever happened
  // to still be recognisable, which is worse than no reading.
  assert.throws(
    () => live.parseEnergyCharts({ unix_seconds: [1], production_types: [{ name: "Load", data: [1] }] }),
    /no recognised generation series/,
  );
  assert.throws(() => live.parseEnergyCharts({}), /no unix_seconds/);
});

test("measuredLastHour: a fallback carries the country when the primary fails", async () => {
  const seen = [];
  const out = await live.measuredLastHour("DE", {
    attempts: 1,
    onFailure: (f) => seen.push(f.provider),
    fetchers: {
      "ENTSO-E": async () => {
        throw new Error("HTTP 503");
      },
      "Energy-Charts": async () => hourly(120),
    },
  });
  assert.equal(out.source, "Energy-Charts", "the document must name the feed that replied");
  assert.equal(live.newestReading(out).direct, 120);
  // The primary's failure is still reported: it is worth knowing the main feed
  // is down while the fallback is carrying the country, not only once both are.
  assert.deepEqual(seen, ["ENTSO-E"]);
});

test("providersFor: fallbacks are national, so a zone chain drops them", () => {
  assert.deepEqual(live.providersFor("DE"), ["ENTSO-E", "Energy-Charts"]);
  // Sicily must not be answered with Italy's national mix.
  assert.deepEqual(live.providersFor("IT", "SICI"), ["ENTSO-E"]);
  assert.deepEqual(live.providersFor("GB"), ["NESO", "Elexon"]);
  assert.deepEqual(live.providersFor("AF"), []);
});

test("a fallback that is not declared independent cannot be reached", () => {
  // The rule is structural, not a convention: providersFor filters the chain by
  // FALLBACK_COVERAGE, so a feed that re-publishes the primary is inert even if
  // someone lists it. A feed that goes down with the primary is not a fallback.
  assert.deepEqual(live.providersFor("DE"), ["ENTSO-E", "Energy-Charts"]);
  assert.deepEqual(live.providersFor("CH"), ["ENTSO-E", "Energy-Charts"]);
  assert.deepEqual(live.providersFor("GB"), ["NESO", "Elexon"]);
  assert.equal(live.redundancyFor("DE"), "independent");
  assert.equal(live.redundancyFor("GB"), "independent");

  // Energy-Charts carries these too, and was configured for them until it was
  // measured re-publishing ENTSO-E. Not listed, and would be inert if it were.
  for (const c of ["IT", "FR", "PL", "AT", "ES"]) {
    assert.deepEqual(live.providersFor(c), ["ENTSO-E"], c);
    assert.equal(live.redundancyFor(c), "none", c);
  }

  assert.equal(live.redundancyFor("US"), "none"); // single feed
  assert.equal(live.redundancyFor("AF"), "none"); // no feed at all
  // National fallbacks are dropped from a zone chain, so no zone has one.
  assert.equal(live.redundancyFor("IT", "SICI"), "none");
  assert.equal(live.redundancyFor("DE", null), "independent");
});

test("parseEskomCsvAll returns every row, not just the newest", () => {
  // Same document the live path reads; the CSV carries a month of hourly rows.
  const csv =
    "Date_Time_Hour_Beginning," +
    Array.from({ length: 20 }, (_, i) => `c${i}`).join(",") +
    "\n2026-08-30 00:00:00," +
    Array.from({ length: 20 }, () => "1000").join(",") +
    "\n2026-08-30 01:00:00," +
    Array.from({ length: 20 }, () => "1000").join(",") +
    "\n2026-08-30 02:00:00," +
    Array.from({ length: 20 }, () => "1000").join(",") +
    "\n,,,\n";
  const all = live.parseEskomCsvAll(csv);
  assert.equal(all.resolution_sec, 3600);
  assert.equal(all.points.length, 3);
  // SAST is UTC+2 with no DST, so 00:00 local is 22:00Z the day before, and the
  // points come back oldest first.
  assert.equal(all.points[0].start, "2026-08-29T22:00:00Z");
  assert.ok(Date.parse(all.points[2].start) > Date.parse(all.points[0].start));
  // The live parser still takes only the newest, which is what keeps closed
  // history days from being rewritten on every run.
  assert.equal(live.parseEskomCsv(csv).points.length, 1);
});

test("parseOpennemAll aligns tracks that run on different clocks", () => {
  // Coal every 5 minutes from 00:00; rooftop solar every 30 from 00:00. Reading
  // by shared index would pair coal's 00:05 with solar's 00:30.
  const payload = {
    data: [
      {
        type: "power",
        fuel_tech: "coal_black",
        history: { start: "2026-08-30T00:00:00Z", interval: "5m", data: [1000, 1000, 1000, 1000, 1000, 1000, 1000] },
      },
      {
        type: "power",
        fuel_tech: "solar_rooftop",
        history: { start: "2026-08-30T00:00:00Z", interval: "30m", data: [1000, 1000] },
      },
    ],
  };
  const all = live.parseOpennemAll(payload);
  // Gridded on the COARSEST step, so every track really has a value at each
  // instant rather than one being interpolated into existence.
  assert.equal(all.resolution_sec, 1800);
  assert.equal(all.points.length, 2);
  assert.equal(all.points[0].start, "2026-08-30T00:00:00Z");
  assert.equal(all.points[1].start, "2026-08-30T00:30:00Z");
  // Coal 1000 + solar 1000 at each: 900 * 1000 / 2000.
  for (const pt of all.points) approx(pt.direct, 450);
  // And the live parser is unchanged: one point, the newest both tracks cover.
  assert.equal(live.parseOpennem(payload).points.length, 1);
});

test("rangedFetcher says which feeds can be backfilled, and which ignore the window", () => {
  const env = { ENTSOE_TOKEN: "t", EIA_TOKEN: "t" };
  assert.ok(live.rangedFetcher("ENTSO-E", "DE", env));
  assert.ok(live.rangedFetcher("ENTSO-E", "IT", env, "SICI"), "zones too");
  assert.ok(live.rangedFetcher("EIA", "US", env));
  assert.ok(live.rangedFetcher("Elexon", "GB", env));
  // A national-only feed must never be asked for a zone.
  assert.equal(live.rangedFetcher("Energy-Charts", "DE", env, "ANY"), null);
  // No token, no backfill — rather than a silent empty result.
  assert.equal(live.rangedFetcher("ENTSO-E", "DE", {}), null);
  // Snapshot feeds with no past range at all.
  for (const p of ["ONS", "EMC", "IESO", "NESO"]) {
    assert.equal(live.rangedFetcher(p, "BR", env), null, p);
  }
  // These two carry a fixed span in one document and ignore the window asked for.
  assert.equal(live.rangedFetcher("Eskom", "ZA", env).windowed, false);
  assert.equal(live.rangedFetcher("OpenNEM", "AU", env).windowed, false);
  assert.equal(live.rangedFetcher("ENTSO-E", "DE", env).windowed, undefined, "the rest honour it");
});

test("providerFor routing", () => {
  const expect = {
    GB: "NESO",
    US: "EIA",
    FR: "ENTSO-E",
    BR: "ONS",
    AU: "OpenNEM",
    SG: "EMC",
    ZA: "Eskom",
    LU: "ENTSO-E",
    MK: "ENTSO-E",
  };
  for (const [c, p] of Object.entries(expect)) assert.equal(live.providerFor(c), p, c);
  assert.equal(live.providerFor("NG"), null);
  // Belarus has an ENTSO-E EIC code and no ENTSO-E data — it is an
  // interconnection partner, not a member of the area. Routing it to a provider
  // that answers "no matching data" for every window it is ever asked would
  // advertise a live source that has never once produced an hour.
  assert.equal(live.providerFor("BY"), null);
  // MX has no hourly source, so it must route nowhere rather than to a fetcher
  // that fails on every run.
  assert.equal(live.providerFor("MX"), null);
});

test("measuredLastHour: injected fetchers", async () => {
  const point = { start: "2026-08-08T13:00:00Z", end: "2026-08-08T14:00:00Z", direct: 313.3 };
  const out = await live.measuredLastHour("FR", {
    fetchers: { "ENTSO-E": async () => ({ resolution_sec: 3600, points: [point] }) },
  });
  assert.deepEqual(out, { resolution_sec: 3600, points: [point], source: "ENTSO-E" });
  assert.deepEqual(live.newestReading(out), {
    direct: 313.3,
    hour_start: "2026-08-08T13:00:00Z",
    hour_end: "2026-08-08T14:00:00Z",
    source: "ENTSO-E",
  });
});

test("measuredLastHour: null for uncovered / failure", async () => {
  assert.equal(await live.measuredLastHour("NG", { fetchers: {} }), null);
  assert.equal(
    await live.measuredLastHour("GB", {
      fetchers: {
        NESO: async () => {
          throw new Error("down");
        },
      },
    }),
    null,
  );
});

test("measuredLastHour: a give-up is reported, a success is not", async () => {
  const seen = [];
  const onFailure = (f) => seen.push(f);

  await live.measuredLastHour("GB", {
    attempts: 2,
    backoffMs: 1,
    onFailure,
    fetchers: {
      NESO: async () => {
        throw new Error("HTTP 400 for https://x");
      },
    },
  });
  assert.deepEqual(seen, [{ code: "GB", zone: null, provider: "NESO", error: "HTTP 400 for https://x" }]);

  // A provider with no fetcher registered is a configuration state, not an
  // outage — IESO answers for CA/ON and deliberately not for CA — so it is not
  // reported here at all.
  seen.length = 0;
  await live.measuredLastHour("FR", { fetchers: {}, onFailure });
  assert.deepEqual(seen, []);

  // A country with no provider at all is not a failure: it has an annual figure
  // and was never going to be measured.
  seen.length = 0;
  await live.measuredLastHour("NG", { fetchers: {}, onFailure });
  assert.deepEqual(seen, []);

  seen.length = 0;
  await live.measuredLastHour("AU", { onFailure, fetchers: { OpenNEM: async () => hourly(120) } });
  assert.deepEqual(seen, []);
});

test("a reported provider URL carries no credential", () => {
  // ENTSO-E and EIA pass theirs in the query string, and the failure message
  // built from that URL now reaches a run log. Actions masks its own secrets; a
  // local run has nothing doing that.
  const url = "https://web-api.tp.entsoe.eu/api?documentType=A75&securityToken=s3cr3t";
  assert.equal(live.safeUrl(url), "https://web-api.tp.entsoe.eu/api?documentType=A75&securityToken=***");
  assert.match(live.safeUrl("https://api.eia.gov/v2/x?api_key=abc&length=200"), /api_key=\*\*\*&length=200/);
  // Nothing to hide, nothing changed; and a URL object is accepted as well.
  assert.equal(live.safeUrl("https://example.com/a.csv"), "https://example.com/a.csv");
  assert.equal(live.safeUrl(new URL("https://example.com/a.csv")), "https://example.com/a.csv");
});

test("the ENTSO-E window is wide enough to outlast the platform's publication lag", () => {
  // A window narrower than the lag returns HTTP 400 "No matching data found",
  // which is indistinguishable from the provider being gone: the country drops
  // out of the snapshot and its hourly routes go with it. Four hours behind is
  // ordinary for A75, so three (what this used to request) was inside the lag.
  assert.ok(live.ENTSOE_WINDOW_HOURS >= 6, "window must clear the worst observed lag");
});

// --- zones ---
test("parseOpennem: series aligned by timestamp, not array position", () => {
  // Rooftop solar starts an hour earlier and runs longer, so position 3 means a
  // different instant in each series. Aligning by index reads coal at an index
  // past the end of its array and reports solar alone.
  const [hs, , direct] = v1(
    live.parseOpennem({
      data: [
        {
          type: "power",
          fuel_tech: "solar_rooftop",
          history: { start: "2026-08-08T09:00:00+10:00", interval: "30m", data: [0, 0, 100, 200] },
        },
        {
          type: "power",
          fuel_tech: "coal_black",
          history: { start: "2026-08-08T10:00:00+10:00", interval: "30m", data: [5000, 5400] },
        },
      ],
    }),
  );
  // Newest instant both cover is 10:30+10:00 = 00:30Z: coal 5400, solar 200.
  approx(direct, (5400 * 900) / (5400 + 200));
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
    fetchers: { OpenNEM: async () => hourly(120) },
  });
  assert.equal(live.newestReading(r).direct, 120);
});

test("measuredLastHour: retries a transient failure, gives up after attempts", async () => {
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls < 3) throw new Error("blip");
    return hourly(120);
  };
  const r = await live.measuredLastHour("AU", { zone: "SA1", attempts: 3, backoffMs: 1, fetchers: { OpenNEM: flaky } });
  assert.equal(live.newestReading(r).direct, 120);
  assert.equal(calls, 3);

  calls = 0;
  const dead = async () => {
    calls += 1;
    throw new Error("down");
  };
  assert.equal(await live.measuredLastHour("AU", { attempts: 2, backoffMs: 1, fetchers: { OpenNEM: dead } }), null);
  assert.equal(calls, 2);
});

// --- IESO (Ontario) ---
const ieso = (date, hours) => `<?xml version="1.0"?>
<IMODocument xmlns="http://www.theIMO.com/schema"><IMODocBody><Date>${date}</Date>
${hours
  .map(
    ([fuel, rows]) => `<Generator><GeneratorName>X</GeneratorName><FuelType>${fuel}</FuelType>
  <Outputs>${rows.map(([h, mw]) => `<Output><Hour>${h}</Hour><EnergyMW>${mw}</EnergyMW></Output>`).join("")}</Outputs>
</Generator>`,
  )
  .join("\n")}
</IMODocBody></IMODocument>`;

const IESO_XML = ieso("2026-08-15", [
  [
    "NUCLEAR",
    [
      [5, 9000],
      [6, 0],
    ],
  ],
  [
    "GAS",
    [
      [5, 1000],
      [6, 0],
    ],
  ],
  [
    "WIND",
    [
      [5, 500],
      [6, 0],
    ],
  ],
  [
    "OTHER",
    [
      [5, 100],
      [6, 0],
    ],
  ],
]);

test("parseIeso: latest reporting hour, EDT hour-ending mapped to UTC", () => {
  const [hs, he, direct] = v1(live.parseIeso(IESO_XML));
  approx(direct, (1000 * 470) / 10600); // only the gas carries carbon
  // Hour 5 ends 05:00 in Toronto; August is EDT (UTC-4).
  assert.equal(hs, "2026-08-15T08:00:00Z");
  assert.equal(he, "2026-08-15T09:00:00Z");
});

test("parseIeso: winter reading uses EST, not a fixed offset", () => {
  const [hs, he] = v1(live.parseIeso(ieso("2026-01-15", [["GAS", [[5, 1000]]]])));
  assert.equal(hs, "2026-01-15T09:00:00Z");
  assert.equal(he, "2026-01-15T10:00:00Z");
});

test("parseIeso: an unusable document throws rather than inventing a reading", () => {
  assert.throws(() => live.parseIeso("<IMODocument/>"), /no <Date>/);
  assert.throws(() => live.parseIeso(ieso("2026-08-15", [["GAS", [[1, 0]]]])), /no hour with usable generation/);
});

test("providerFor: Canada resolves to IESO, but only the zone has a fetcher", async () => {
  assert.equal(live.providerFor("CA"), "IESO");
  assert.deepEqual(live.zonesFor("CA"), ["ON"]);
  // No zone -> no IESO fetcher -> null, so the country keeps its annual figure.
  assert.equal(await live.measuredLastHour("CA", { env: {} }), null);
});

// A provider that answered and had nothing to say is not a provider that could
// not be reached. Before this distinction existed, an EIA respondent with no
// published rows cost four requests per window and then told the backfill to
// re-run, which could only produce the same emptiness again.
test("an empty payload is reported as answered-and-empty, not as a failure to reach", () => {
  const empty = JSON.stringify({ response: { data: [] } });
  assert.throws(
    () => live.parseEia(empty),
    (e) => {
      assert.equal(e.empty, true);
      assert.equal(e.retryable, false);
      return true;
    },
  );
});

test("retrying does not ask again for data the provider said it does not have", async () => {
  let calls = 0;
  await assert.rejects(
    live.retrying(
      async () => {
        calls += 1;
        return live.parseEia(JSON.stringify({ response: { data: [] } }));
      },
      { attempts: 4, backoffMs: 1 },
    ),
  );
  assert.equal(calls, 1);
});
