import assert from "node:assert/strict";
import { test } from "node:test";
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
    BY: "ENTSO-E",
  };
  for (const [c, p] of Object.entries(expect)) assert.equal(live.providerFor(c), p, c);
  assert.equal(live.providerFor("NG"), null);
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
