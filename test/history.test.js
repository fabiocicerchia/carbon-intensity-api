import { test } from "node:test";
import assert from "node:assert/strict";
import { PRUNE_TAIL_DAYS, RETENTION_DAYS, historyPath, upsertDay, writeHistory } from "../src/history.js";
import { hourlyMeans, lastHour } from "../src/data.js";
import { newestReading } from "../src/live.js";

// An in-memory store with the same {get, put, del} seam fsStore provides, so
// the tests exercise the real read-modify-write path rather than a stub of it.
function store() {
  const files = {};
  return {
    files,
    put: async (p, b) => { files[p] = b; },
    get: async (p) => files[p] ?? null,
    del: async (p) => (p in files ? (delete files[p], true) : false),
  };
}

const pt = (start, direct, mins = 15) => ({
  start,
  end: new Date(Date.parse(start) + mins * 60000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  direct,
});

const quarterly = (points) => ({ resolution_sec: 900, source: "ENTSO-E", points });
const hourly = (points) => ({ resolution_sec: 3600, source: "EIA", points });

const day = (files, code, date, zone = null) => JSON.parse(files[historyPath(code, date, zone)]);

const snapshotOf = (series, generated_at = "2026-08-27T12:10:00Z") => ({
  generated_at,
  series: { countries: series, zones: {} },
});

// --- the hourly mean ----------------------------------------------------------

test("four points in an hour become its mean, marked complete", async () => {
  const s = store();
  await writeHistory(snapshotOf({
    IT: quarterly([
      pt("2026-08-27T06:00:00Z", 400), pt("2026-08-27T06:15:00Z", 300),
      pt("2026-08-27T06:30:00Z", 200), pt("2026-08-27T06:45:00Z", 100),
    ]),
  }), s.put, s.get);
  const d = day(s.files, "IT", "2026-08-27");
  assert.equal(d.direct[6], 250);
  assert.equal(d.points[6], 4);
  assert.equal(d.complete[6], true);
});

test("a partial hour averages what arrived and says so", async () => {
  const s = store();
  await writeHistory(snapshotOf({
    IT: quarterly([
      pt("2026-08-27T06:00:00Z", 400), pt("2026-08-27T06:15:00Z", 300),
      pt("2026-08-27T06:30:00Z", 200),
    ]),
  }), s.put, s.get);
  const d = day(s.files, "IT", "2026-08-27");
  assert.equal(d.direct[6], 300); // mean of the three seen, not of four
  assert.equal(d.points[6], 3);
  assert.equal(d.complete[6], false);
});

test("an hourly provider fills an hour with one point", async () => {
  const s = store();
  await writeHistory(snapshotOf({ US: hourly([pt("2026-08-27T06:00:00Z", 400, 60)]) }), s.put, s.get);
  const d = day(s.files, "US", "2026-08-27");
  assert.equal(d.points[6], 1);
  assert.equal(d.complete[6], true);
});

// --- array shape --------------------------------------------------------------

test("a missing hour is null and present, never omitted", async () => {
  const s = store();
  await writeHistory(snapshotOf({
    IT: quarterly([pt("2026-08-27T02:00:00Z", 400), pt("2026-08-27T05:00:00Z", 200)]),
  }), s.put, s.get);
  const d = day(s.files, "IT", "2026-08-27");
  for (const key of ["direct", "lifecycle", "consumption_direct", "consumption_lifecycle", "points", "complete"]) {
    assert.equal(d[key].length, 6, key);
    assert.equal(d[key][3], null, `${key}[3]`);
    assert.equal(d[key][4], null, `${key}[4]`);
  }
  // Dropping hours 3 and 4 instead would slide hour 5's value into index 3 and
  // every later comparison would be against the wrong hour.
  assert.equal(d.direct[2], 400);
  assert.equal(d.direct[5], 200);
});

test("today is truncated at the last known hour, never padded to 24", async () => {
  const s = store();
  await writeHistory(snapshotOf({ IT: quarterly([pt("2026-08-27T09:00:00Z", 400)]) }), s.put, s.get);
  assert.equal(day(s.files, "IT", "2026-08-27").direct.length, 10);
});

test("a late point for an earlier hour never truncates the later ones", () => {
  const seeded = upsertDay(null, hourlyMeans(quarterly([pt("2026-08-27T19:00:00Z", 400)])), {
    code: "IT", date: "2026-08-27", generatedAt: "t",
  });
  assert.equal(seeded.direct.length, 20);
  const after = upsertDay(JSON.stringify(seeded), hourlyMeans(quarterly([pt("2026-08-27T05:00:00Z", 100)])), {
    code: "IT", date: "2026-08-27", generatedAt: "t",
  });
  assert.equal(after.direct.length, 20);
  assert.equal(after.direct[5], 100);
  assert.equal(after.direct[19], 400);
});

// --- merge semantics ----------------------------------------------------------

test("an hour seen again with more points takes the newer mean", async () => {
  const s = store();
  const first = quarterly([pt("2026-08-27T06:00:00Z", 400), pt("2026-08-27T06:15:00Z", 300)]);
  await writeHistory(snapshotOf({ IT: first }), s.put, s.get);
  assert.equal(day(s.files, "IT", "2026-08-27").direct[6], 350);

  const full = quarterly([
    pt("2026-08-27T06:00:00Z", 400), pt("2026-08-27T06:15:00Z", 300),
    pt("2026-08-27T06:30:00Z", 200), pt("2026-08-27T06:45:00Z", 100),
  ]);
  await writeHistory(snapshotOf({ IT: full }), s.put, s.get);
  const d = day(s.files, "IT", "2026-08-27");
  assert.equal(d.direct[6], 250); // recomputed, not blended with the old 350
  assert.equal(d.complete[6], true);
});

test("a window spanning midnight writes both days", async () => {
  const s = store();
  await writeHistory(snapshotOf({
    IT: quarterly([
      pt("2026-08-27T23:30:00Z", 400), pt("2026-08-27T23:45:00Z", 420),
      pt("2026-08-28T00:00:00Z", 300), pt("2026-08-28T00:15:00Z", 310),
    ]),
  }, "2026-08-28T00:20:00Z"), s.put, s.get);
  assert.equal(day(s.files, "IT", "2026-08-27").direct[23], 410);
  assert.equal(day(s.files, "IT", "2026-08-28").direct[0], 305);
});

test("a closed day is left byte-identical on a later run", async () => {
  const s = store();
  const series = quarterly([
    pt("2026-08-27T06:00:00Z", 400), pt("2026-08-27T06:15:00Z", 300),
    pt("2026-08-27T06:30:00Z", 200), pt("2026-08-27T06:45:00Z", 100),
  ]);
  const first = await writeHistory(snapshotOf({ IT: series }), s.put, s.get);
  assert.equal(first.written, 1);
  const before = s.files[historyPath("IT", "2026-08-27")];

  // Same points, a later run. This is what keeps `immutable` cache headers
  // honest and stops closed days churning the repo.
  const second = await writeHistory(snapshotOf({ IT: series }, "2026-08-27T23:59:00Z"), s.put, s.get);
  assert.equal(second.written, 0);
  assert.equal(second.skipped, 1);
  assert.equal(s.files[historyPath("IT", "2026-08-27")], before);
});

test("completeness is fixed per hour, so a resolution change cannot rewrite history", async () => {
  const s = store();
  // Morning: an hourly feed, so one point completes an hour.
  await writeHistory(snapshotOf({ IT: hourly([pt("2026-08-27T05:00:00Z", 500, 60)]) }), s.put, s.get);
  assert.equal(day(s.files, "IT", "2026-08-27").complete[5], true);

  // Afternoon: the provider switches to quarter-hourly. Hour 5 keeps its own
  // verdict; a client deriving completeness from one day-level constant would
  // now read it as 1-of-4 and wrongly call it partial.
  await writeHistory(snapshotOf({
    IT: quarterly([pt("2026-08-27T14:00:00Z", 200), pt("2026-08-27T14:15:00Z", 200)]),
  }), s.put, s.get);
  const d = day(s.files, "IT", "2026-08-27");
  assert.equal(d.complete[5], true);
  assert.equal(d.points[5], 1);
  assert.equal(d.complete[14], false);
  assert.equal(d.points[14], 2);
});

test("same snapshot twice is idempotent", async () => {
  const s = store();
  const snap = snapshotOf({ IT: quarterly([pt("2026-08-27T06:00:00Z", 400)]) });
  await writeHistory(snap, s.put, s.get);
  const after = JSON.stringify(s.files);
  await writeHistory(snap, s.put, s.get);
  assert.equal(JSON.stringify(s.files), after);
});

// --- zones --------------------------------------------------------------------

test("zone history carries direct and lifecycle only", async () => {
  const s = store();
  await writeHistory({
    generated_at: "2026-08-27T12:00:00Z",
    series: { countries: {}, zones: { "IT/SICI": quarterly([pt("2026-08-27T06:00:00Z", 400)]) } },
  }, s.put, s.get);
  const d = day(s.files, "IT", "2026-08-27", "SICI");
  assert.equal(d.zone, "SICI");
  assert.ok("lifecycle" in d);
  // The import adjustment is a national figure; Sicily's mix is not Italy's.
  assert.equal("consumption_direct" in d, false);
  assert.equal("consumption_lifecycle" in d, false);
});

// --- retention ----------------------------------------------------------------

const daysAgo = (from, n) => {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

test("retention prunes past the window and spares the last day inside it", async () => {
  const s = store();
  const today = "2026-08-27";
  const expired = historyPath("IT", daysAgo(today, RETENTION_DAYS + 1));
  const inside = historyPath("IT", daysAgo(today, RETENTION_DAYS - 1));
  s.files[expired] = "{}";
  s.files[inside] = "{}";
  const r = await writeHistory(snapshotOf({}, `${today}T12:00:00Z`), s.put, s.get, s.del);
  assert.equal(r.pruned, 1);
  assert.equal(expired in s.files, false);
  assert.equal(inside in s.files, true, "a day one short of the boundary must survive");
});

test("an outage shorter than the tail still gets swept", async () => {
  const s = store();
  const today = "2026-08-27";
  const missed = historyPath("IT", daysAgo(today, RETENTION_DAYS + PRUNE_TAIL_DAYS));
  s.files[missed] = "{}";
  await writeHistory(snapshotOf({}, `${today}T12:00:00Z`), s.put, s.get, s.del);
  assert.equal(missed in s.files, false);
});

test("without a del the run neither throws nor prunes", async () => {
  const s = store();
  const expired = historyPath("IT", daysAgo("2026-08-27", RETENTION_DAYS + 1));
  s.files[expired] = "{}";
  const r = await writeHistory(snapshotOf({}, "2026-08-27T12:00:00Z"), s.put, s.get);
  assert.equal(r.pruned, 0);
  assert.equal(expired in s.files, true);
});

// --- the v1 guard --------------------------------------------------------------

test("v1 still reads the newest point when a provider returns a whole window", () => {
  // The premise the v2 split rests on: widening the parsers must not move v1.
  const series = quarterly([
    pt("2026-08-27T06:00:00Z", 400), pt("2026-08-27T06:15:00Z", 300),
    pt("2026-08-27T06:30:00Z", 200), pt("2026-08-27T06:45:00Z", 117),
  ]);
  const doc = lastHour("IT", { measured: newestReading({ ...series, source: "ENTSO-E" }) });
  assert.equal(doc.hour_start, "2026-08-27T06:45:00Z");
  assert.equal(doc.hour_end, "2026-08-27T07:00:00Z");
  assert.equal(doc.direct, 117); // the newest point, NOT the hour's mean of 254
  assert.equal(doc.basis, "measured");
  assert.equal(doc.data_source.name, "ENTSO-E");
  // v1 fields stay put: no v2 naming leaks in.
  assert.equal("period_start" in doc, false);
  assert.equal("resolution_sec" in doc, false);
});
