import assert from "node:assert/strict";
import { test } from "node:test";
import { hourlyMeans, lastHour } from "../src/data.js";
import { historyPath, PRUNE_TAIL_DAYS, RETENTION_DAYS, upsertDay, upsertDays, writeHistory } from "../src/history.js";
import { newestReading } from "../src/live.js";
import { HOURLY_MAX_AGE_SECONDS, writeV2 } from "../src/pipeline.js";

// An in-memory store with the same {get, put, del} seam fsStore provides, so
// the tests exercise the real read-modify-write path rather than a stub of it.
function store() {
  const files = {};
  return {
    files,
    put: async (p, b) => {
      files[p] = b;
    },
    get: async (p) => files[p] ?? null,
    del: async (p) => {
      if (!(p in files)) return false;
      delete files[p];
      return true;
    },
  };
}

const pt = (start, direct, mins = 15) => ({
  start,
  end: new Date(Date.parse(start) + mins * 60000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  direct,
});

const quarterly = (points) => ({ resolution_sec: 900, source: "ENTSO-E", points });

// A complete PT15M hour starting at `hourIso`, for tests that care when an hour
// happened rather than what it averages.
const completeHour = (hourIso) =>
  quarterly(
    [0, 15, 30, 45].map((m) =>
      pt(new Date(Date.parse(hourIso) + m * 60000).toISOString().replace(/\.\d{3}Z$/, "Z"), 400 - m * 5),
    ),
  );
const hourly = (points) => ({ resolution_sec: 3600, source: "EIA", points });

const day = (files, code, date, zone = null) => JSON.parse(files[historyPath(code, date, zone)]);

const snapshotOf = (series, generated_at = "2026-08-27T12:10:00Z") => ({
  generated_at,
  series: { countries: series, zones: {} },
});

// --- the hourly mean ----------------------------------------------------------

test("four points in an hour become its mean, marked complete", async () => {
  const s = store();
  await writeHistory(
    snapshotOf({
      IT: quarterly([
        pt("2026-08-27T06:00:00Z", 400),
        pt("2026-08-27T06:15:00Z", 300),
        pt("2026-08-27T06:30:00Z", 200),
        pt("2026-08-27T06:45:00Z", 100),
      ]),
    }),
    s.put,
    s.get,
  );
  const d = day(s.files, "IT", "2026-08-27");
  assert.equal(d.direct[6], 250);
  assert.equal(d.points[6], 4);
  assert.equal(d.complete[6], true);
});

test("a partial hour averages what arrived and says so", async () => {
  const s = store();
  await writeHistory(
    snapshotOf({
      IT: quarterly([
        pt("2026-08-27T06:00:00Z", 400),
        pt("2026-08-27T06:15:00Z", 300),
        pt("2026-08-27T06:30:00Z", 200),
      ]),
    }),
    s.put,
    s.get,
  );
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
  await writeHistory(
    snapshotOf({
      IT: quarterly([pt("2026-08-27T02:00:00Z", 400), pt("2026-08-27T05:00:00Z", 200)]),
    }),
    s.put,
    s.get,
  );
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
    code: "IT",
    date: "2026-08-27",
    generatedAt: "t",
  });
  assert.equal(seeded.direct.length, 20);
  const after = upsertDay(JSON.stringify(seeded), hourlyMeans(quarterly([pt("2026-08-27T05:00:00Z", 100)])), {
    code: "IT",
    date: "2026-08-27",
    generatedAt: "t",
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
    pt("2026-08-27T06:00:00Z", 400),
    pt("2026-08-27T06:15:00Z", 300),
    pt("2026-08-27T06:30:00Z", 200),
    pt("2026-08-27T06:45:00Z", 100),
  ]);
  await writeHistory(snapshotOf({ IT: full }), s.put, s.get);
  const d = day(s.files, "IT", "2026-08-27");
  assert.equal(d.direct[6], 250); // recomputed, not blended with the old 350
  assert.equal(d.complete[6], true);
});

test("a window spanning midnight writes both days", async () => {
  const s = store();
  await writeHistory(
    snapshotOf(
      {
        IT: quarterly([
          pt("2026-08-27T23:30:00Z", 400),
          pt("2026-08-27T23:45:00Z", 420),
          pt("2026-08-28T00:00:00Z", 300),
          pt("2026-08-28T00:15:00Z", 310),
        ]),
      },
      "2026-08-28T00:20:00Z",
    ),
    s.put,
    s.get,
  );
  assert.equal(day(s.files, "IT", "2026-08-27").direct[23], 410);
  assert.equal(day(s.files, "IT", "2026-08-28").direct[0], 305);
});

test("upsertDays is the one place the immutability rule lives", async () => {
  // Both the pipeline and the backfill write days through this, so the rule that
  // keeps closed days byte-stable — and their `immutable` cache headers honest —
  // cannot be got right in one path and wrong in the other.
  const s = store();
  const means = hourlyMeans(
    quarterly([
      pt("2026-08-27T06:00:00Z", 400),
      pt("2026-08-27T06:15:00Z", 300),
      pt("2026-08-27T06:30:00Z", 200),
      pt("2026-08-27T06:45:00Z", 100),
    ]),
  );
  const where = { code: "IT", generatedAt: "2026-08-27T07:00:00Z", source: "ENTSO-E" };

  const first = await upsertDays(means, where, s);
  assert.deepEqual(first, { written: 1, unchanged: 0 });
  const bytes = s.files[historyPath("IT", "2026-08-27")];
  assert.equal(JSON.parse(bytes).source[6], "ENTSO-E");

  // Same hours seen again, a later run: not rewritten, byte-for-byte.
  const again = await upsertDays(means, { ...where, generatedAt: "2026-08-27T23:00:00Z" }, s);
  assert.deepEqual(again, { written: 0, unchanged: 1 });
  assert.equal(s.files[historyPath("IT", "2026-08-27")], bytes);

  // A dry run is a put that does nothing, not a flag inside the writer.
  const dry = store();
  const r = await upsertDays(means, where, { get: dry.get, put: async () => {} });
  assert.equal(r.written, 1);
  assert.equal(Object.keys(dry.files).length, 0);
});

test("a closed day is left byte-identical on a later run", async () => {
  const s = store();
  const series = quarterly([
    pt("2026-08-27T06:00:00Z", 400),
    pt("2026-08-27T06:15:00Z", 300),
    pt("2026-08-27T06:30:00Z", 200),
    pt("2026-08-27T06:45:00Z", 100),
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
  await writeHistory(
    snapshotOf({
      IT: quarterly([pt("2026-08-27T14:00:00Z", 200), pt("2026-08-27T14:15:00Z", 200)]),
    }),
    s.put,
    s.get,
  );
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
  await writeHistory(
    {
      generated_at: "2026-08-27T12:00:00Z",
      series: { countries: {}, zones: { "IT/SICI": quarterly([pt("2026-08-27T06:00:00Z", 400)]) } },
    },
    s.put,
    s.get,
  );
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

// --- v2 coverage and the v1 guard ---------------------------------------------

test("an annual-average country gets /yearly but no hourly routes", async () => {
  const s = store();
  await writeV2({ generated_at: "2026-08-27T12:00:00Z", series: { countries: {}, zones: {} } }, s.put, s.get, s.del);
  assert.ok("v2/AF/yearly" in s.files);
  assert.equal("v2/AF/past-hour" in s.files, false);
  assert.equal("v2/AF/current-hour" in s.files, false);
  assert.equal("v2/AF/latest" in s.files, false);
  // The bulk catalogue answers for every country, measured or not.
  assert.equal(JSON.parse(s.files["v2/countries.json"]).count, 213);
  // No bulk current-hour: partial hours are not comparable across providers.
  assert.equal("v2/current-hour.json" in s.files, false);
  assert.equal("v2/latest.json" in s.files, false);
  assert.equal("v2/yearly.json" in s.files, false);
});

test("a past-hour object is removed once no complete hour remains", async () => {
  const s = store();
  // The run is 12:10, so /past-hour names 11:00 and /current-hour names 12:00.
  const complete = quarterly([
    pt("2026-08-27T11:00:00Z", 400),
    pt("2026-08-27T11:15:00Z", 300),
    pt("2026-08-27T11:30:00Z", 200),
    pt("2026-08-27T11:45:00Z", 100),
  ]);
  await writeV2(snapshotOf({ IT: complete }), s.put, s.get, s.del);
  assert.ok("v2/IT/past-hour" in s.files);
  assert.equal(JSON.parse(s.files["v2/past-hour.json"]).count, 1);

  // A later window holding only the hour in progress: the named past hour is not
  // in it, and with no history to estimate from the route goes.
  await writeV2(snapshotOf({ IT: quarterly([pt("2026-08-27T12:00:00Z", 400)]) }), s.put, s.get, s.del);
  assert.equal("v2/IT/past-hour" in s.files, false);
  assert.ok("v2/IT/current-hour" in s.files);
});

test("a provider that goes dark loses its hour-named routes at once", async () => {
  const s = store();
  // Run at 07:10: /past-hour names 06:00 (complete) and /current-hour 07:00,
  // which is still filling — one point of the four.
  const complete = quarterly([
    pt("2026-08-27T06:00:00Z", 400),
    pt("2026-08-27T06:15:00Z", 300),
    pt("2026-08-27T06:30:00Z", 200),
    pt("2026-08-27T06:45:00Z", 100),
    pt("2026-08-27T07:00:00Z", 150),
  ]);
  await writeV2(snapshotOf({ IT: complete }, "2026-08-27T07:10:00Z"), s.put, s.get, s.del);
  assert.ok("v2/IT/past-hour" in s.files);
  assert.ok("v2/IT/current-hour" in s.files);
  const written = JSON.parse(s.files["v2/IT/latest"]).generated_at;

  // The provider fails on the very next run: IT is not in the snapshot at all.
  // No grace period — the routes are named for clock hours and there is no such
  // hour to serve, so they go now rather than in a few hours' time.
  const soon = new Date(Date.parse("2026-08-27T07:10:00Z") + 20 * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
  await writeV2(snapshotOf({}, soon), s.put, s.get, s.del);
  assert.equal("v2/IT/past-hour" in s.files, false);
  assert.equal("v2/IT/current-hour" in s.files, false);
  assert.equal(JSON.parse(s.files["v2/past-hour.json"]).count, 0);

  // /latest is what carries the reading across the outage, unrewritten, so its
  // own timestamp shows how long ago the last run that had data was.
  assert.ok("v2/IT/latest" in s.files);
  assert.equal(JSON.parse(s.files["v2/IT/latest"]).generated_at, written);

  // And it keeps carrying it however long the outage lasts.
  const muchLater = new Date(Date.parse("2026-08-27T07:10:00Z") + 30 * 24 * 3600 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  await writeV2(snapshotOf({}, muchLater), s.put, s.get, s.del);
  assert.ok("v2/IT/latest" in s.files);
  assert.equal(JSON.parse(s.files["v2/IT/latest"]).generated_at, written);
});

test("a complete hour too far in the past is not published as the past hour", async () => {
  const s = store();
  // A provider that comes back by backfilling old hours and nothing recent. The
  // window is wide enough to hold them, and they are complete — but an hour that
  // ended half a day ago is not "the last completed hour", and republishing it
  // every run with a fresh generated_at would make it look current.
  const stale = completeHour("2026-08-27T00:00:00Z");
  await writeV2(snapshotOf({ IT: stale }, "2026-08-27T12:10:00Z"), s.put, s.get, s.del);
  assert.equal("v2/IT/past-hour" in s.files, false);
  assert.equal("v2/IT/current-hour" in s.files, false);
  assert.equal(JSON.parse(s.files["v2/past-hour.json"]).count, 0);

  // The same hour, read soon after it closed, is exactly what the route is for.
  await writeV2(snapshotOf({ IT: stale }, "2026-08-27T01:10:00Z"), s.put, s.get, s.del);
  assert.equal(JSON.parse(s.files["v2/IT/past-hour"]).period_start, "2026-08-27T00:00:00Z");
});

test("a feed publishing a day behind answers on /latest and nowhere else", async () => {
  const s = store();
  // EIA runs about a day behind and Eskom several; the hour they last published
  // is real data, but it is not the last completed clock hour and must not be
  // served as one.
  const stale = completeHour("2026-08-27T00:00:00Z");
  await writeV2(snapshotOf({ IT: stale }, "2026-08-27T12:10:00Z"), s.put, s.get, s.del);
  assert.equal("v2/IT/past-hour" in s.files, false);
  assert.equal("v2/IT/current-hour" in s.files, false);
  const latest = JSON.parse(s.files["v2/IT/latest"]);
  assert.equal(latest.period_start, "2026-08-27T00:00:00Z");
  assert.equal(latest.complete, true);
  // Still absent from the bulk document: that one is the completed hour.
  assert.equal(JSON.parse(s.files["v2/past-hour.json"]).count, 0);
});

test("the catalogue reports each country's routes, lag and stale flag", async () => {
  const s = store();
  await writeV2(
    {
      generated_at: "2026-08-27T12:10:00Z",
      series: {
        countries: {
          // A live feed, and one running a day behind the way EIA does.
          FR: completeHour("2026-08-27T11:00:00Z"),
          IT: completeHour("2026-08-26T12:00:00Z"),
        },
        zones: {},
      },
    },
    s.put,
    s.get,
    s.del,
  );

  const by = Object.fromEntries(JSON.parse(s.files["v2/countries.json"]).countries.map((c) => [c.country_code, c]));

  // FR published the hour that just closed but not the one still running, which
  // is what a feed an hour behind looks like.
  assert.deepEqual(by.FR.routes, ["past-hour", "latest"]);
  assert.equal(by.FR.provider, "ENTSO-E");
  assert.equal(by.FR.data_lag_seconds, 600); // 12:00 to 12:10
  assert.equal(by.FR.stale, false);

  // Real measured data, just too old to be any recent clock hour.
  assert.deepEqual(by.IT.routes, ["latest"]);
  assert.equal(by.IT.data_lag_seconds, 23 * 3600 + 600);
  assert.equal(by.IT.stale, true);

  // A country with a provider that returned nothing: no routes, nothing to lag.
  assert.deepEqual(by.DE.routes, []);
  assert.equal(by.DE.provider, "ENTSO-E");
  assert.equal(by.DE.data_lag_seconds, null);
  assert.equal(by.DE.stale, false);

  // And one with no provider at all.
  assert.deepEqual(by.AF.routes, []);
  assert.equal(by.AF.provider, null);
  assert.equal(by.AF.data_lag_seconds, null);
});

test("/latest is not expired by a dark provider; its timestamp stops instead", async () => {
  const s = store();
  await writeV2(snapshotOf({ IT: completeHour("2026-08-27T06:00:00Z") }, "2026-08-27T07:10:00Z"), s.put, s.get, s.del);
  const written = JSON.parse(s.files["v2/IT/latest"]).generated_at;

  const late = new Date(Date.parse("2026-08-27T07:10:00Z") + HOURLY_MAX_AGE_SECONDS * 1000 + 3600 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  await writeV2(snapshotOf({}, late), s.put, s.get, s.del);

  // The two hour-named routes expire, because the hours they name are gone.
  assert.equal("v2/IT/past-hour" in s.files, false);
  assert.equal("v2/IT/current-hour" in s.files, false);
  // The newest reading we have is still the newest reading we have.
  assert.ok("v2/IT/latest" in s.files);
  assert.equal(
    JSON.parse(s.files["v2/IT/latest"]).generated_at,
    written,
    "not rewritten, so the document's own timestamp shows how stale it is",
  );
});

// 28 days of history for a grid that is cheap at midday and dear otherwise —
// enough support for a profile, written straight into the store the way the
// pipeline would have.
function seedHistory(files, code, endDate, days = 28) {
  for (let i = 1; i <= days; i += 1) {
    const d = new Date(`${endDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    const direct = Array.from({ length: 24 }, (_, h) => (h >= 10 && h <= 15 ? 200 : 400));
    files[historyPath(code, date)] = JSON.stringify({
      direct,
      complete: direct.map(() => true),
    });
  }
}

test("a lagging provider gets its named hours estimated, flagged as such", async () => {
  const s = store();
  seedHistory(s.files, "US", "2026-08-31");
  // Run at 12:10 on a Monday: /past-hour names 11:00, /current-hour 12:00. The
  // provider is two hours behind and has published only up to 09:00 — routine
  // publication lag, the case that made hour-named routes flicker in and out.
  // US because two hours has to be inside the country's measured horizon, and
  // EIA's is six; an unmeasured country gets one hour and would refuse this.
  // An unusually dirty morning: 600 where the profile for 09:00 says 400.
  const dirty = {
    ...quarterly(
      [0, 15, 30, 45].map((m) =>
        pt(new Date(Date.parse("2026-08-31T09:00:00Z") + m * 60000).toISOString().replace(/\.\d{3}Z$/, "Z"), 600),
      ),
    ),
    source: "EIA",
  };
  await writeV2(snapshotOf({ US: dirty }, "2026-08-31T12:10:00Z"), s.put, s.get, s.del);

  const past = JSON.parse(s.files["v2/US/past-hour"]);
  assert.equal(past.period_start, "2026-08-31T11:00:00Z", "the hour it names, not the newest one");
  assert.equal(past.basis, "estimated");
  assert.equal(past.estimate.hours_ahead, 2);
  assert.equal(past.estimate.anchor_hour, "2026-08-31T09:00:00Z");
  assert.equal(past.estimate.from_source, "EIA");
  // No measurement stands behind it, and the document says so rather than
  // borrowing the anchor's point count.
  assert.equal(past.points, 0);
  assert.equal(past.complete, false);
  // The figure is ours, modelled from our own history — not credited to the feed.
  assert.equal(past.data_source.status, "estimated");

  // The profile halves from 09:00 (400) to 11:00 (200), so the estimate halves
  // the day's own level: 600 -> 300. The grid's level is carried by the anchor,
  // the shape by the ratio — and 300 sits inside the four-week range, so the
  // clamp does not bind.
  assert.equal(JSON.parse(s.files["v2/US/latest"]).direct, 600);
  assert.equal(past.direct, 300);

  // /latest stays the newest REAL reading: never estimated.
  const latest = JSON.parse(s.files["v2/US/latest"]);
  assert.equal(latest.basis, "measured");
  assert.equal(latest.period_start, "2026-08-31T09:00:00Z");

  // The bulk document carries the basis so a consumer can filter estimates out.
  const bulk = JSON.parse(s.files["v2/past-hour.json"]).countries.find((c) => c.country_code === "US");
  assert.equal(bulk.basis, "estimated");
});

// The backtested horizon is a floor, not a veto on the provider's lag. Identical
// setup to the test above, on Austria — absent from ESTIMATE_MAX_HOURS because it
// was measured and rejected, so it carries the one-hour default. Its feed is
// three hours behind, and the hour-named routes are reached anyway: a horizon
// shorter than the lag would not make /current-hour more accurate, it would make
// it permanently absent. What the country did not earn is hidden: the document
// carries both numbers and a consumer holding to the measured bound can filter.
test("the backtested horizon is a floor the provider's lag lifts", async () => {
  const s = store();
  seedHistory(s.files, "AT", "2026-08-31");
  const dirty = quarterly(
    [0, 15, 30, 45].map((m) =>
      pt(new Date(Date.parse("2026-08-31T09:00:00Z") + m * 60000).toISOString().replace(/\.\d{3}Z$/, "Z"), 600),
    ),
  );
  await writeV2(snapshotOf({ AT: dirty }, "2026-08-31T12:10:00Z"), s.put, s.get, s.del);

  const past = JSON.parse(s.files["v2/AT/past-hour"]);
  assert.equal(past.period_start, "2026-08-31T11:00:00Z");
  assert.equal(past.estimate.hours_ahead, 2);
  // Reaching the hour in progress costs three hours from a nine o'clock anchor,
  // and that is what the horizon is set to — not the one the backtest allowed.
  const current = JSON.parse(s.files["v2/AT/current-hour"]);
  assert.equal(current.period_start, "2026-08-31T12:00:00Z");
  assert.equal(current.estimate.hours_ahead, 3);
  assert.equal(current.estimate.max_hours, 3);
  assert.equal(current.estimate.backtested_max_hours, 1);

  // The real reading it does have is untouched by any of that.
  assert.equal(JSON.parse(s.files["v2/AT/latest"]).period_start, "2026-08-31T09:00:00Z");
});

// The case this rule exists for. DE was measured at two hours and its feed runs
// about three behind, so under a cap read as a ceiling /v2/DE/current-hour could
// never be published — 404 on every green run, with /past-hour and /latest both
// answering beside it.
test("a three-hour feed still fills the hour in progress", async () => {
  const s = store();
  seedHistory(s.files, "DE", "2026-08-31");
  const dirty = quarterly(
    [0, 15, 30, 45].map((m) =>
      pt(new Date(Date.parse("2026-08-31T09:00:00Z") + m * 60000).toISOString().replace(/\.\d{3}Z$/, "Z"), 600),
    ),
  );
  await writeV2(snapshotOf({ DE: dirty }, "2026-08-31T12:10:00Z"), s.put, s.get, s.del);

  const current = JSON.parse(s.files["v2/DE/current-hour"]);
  assert.equal(current.period_start, "2026-08-31T12:00:00Z");
  assert.equal(current.basis, "estimated");
  assert.equal(current.estimate.hours_ahead, 3);
  assert.equal(current.estimate.backtested_max_hours, 2);
  // The catalogue is what a reader consults to know a route answers, so it has
  // to have grown the route too.
  const de = JSON.parse(s.files["v2/countries.json"]).countries.find((c) => c.country_code === "DE");
  assert.deepEqual(de.routes, ["past-hour", "current-hour", "latest"]);
});

// A current feed does not lose the horizon its grid earned: the lag lifts the
// floor and never lowers it.
test("a feed that is up to date keeps the backtested horizon", async () => {
  const s = store();
  seedHistory(s.files, "US", "2026-08-31");
  const dirty = {
    ...quarterly(
      [0, 15, 30, 45].map((m) =>
        pt(new Date(Date.parse("2026-08-31T11:00:00Z") + m * 60000).toISOString().replace(/\.\d{3}Z$/, "Z"), 600),
      ),
    ),
    source: "EIA",
  };
  await writeV2(snapshotOf({ US: dirty }, "2026-08-31T12:10:00Z"), s.put, s.get, s.del);
  const current = JSON.parse(s.files["v2/US/current-hour"]);
  assert.equal(current.estimate.hours_ahead, 1);
  assert.equal(current.estimate.max_hours, 6, "one hour behind, six still allowed");
});

test("estimates stop where the anchor stops carrying the weather", async () => {
  const s = store();
  seedHistory(s.files, "IT", "2026-08-31");
  // The same grid, but the provider is a full day behind. The anchor tells us
  // nothing about the wind now, so both hour-named routes 404 rather than
  // publishing a climatological average dressed as a reading.
  await writeV2(snapshotOf({ IT: completeHour("2026-08-30T11:00:00Z") }, "2026-08-31T12:10:00Z"), s.put, s.get, s.del);
  assert.equal("v2/IT/past-hour" in s.files, false);
  assert.equal("v2/IT/current-hour" in s.files, false);
  // And /latest still carries the real day-old reading.
  assert.equal(JSON.parse(s.files["v2/IT/latest"]).period_start, "2026-08-30T11:00:00Z");
});

test("no history means no estimate, so this ships inert", async () => {
  const s = store();
  // A fresh deployment has nothing to build a profile from. The estimator must
  // refuse rather than invent a shape from two days of data.
  await writeV2(snapshotOf({ IT: completeHour("2026-08-31T09:00:00Z") }, "2026-08-31T12:10:00Z"), s.put, s.get, s.del);
  assert.equal("v2/IT/past-hour" in s.files, false);
  assert.ok("v2/IT/latest" in s.files);
});

test("an offline build reconciles nothing", async () => {
  const s = store();
  await writeV2(
    snapshotOf(
      {
        IT: quarterly([pt("2026-08-27T07:00:00Z", 400)]),
      },
      "2026-08-27T07:10:00Z",
    ),
    s.put,
    s.get,
    s.del,
  );
  assert.ok("v2/IT/current-hour" in s.files);

  // --no-live asks no provider anything, so an empty snapshot means "we did not
  // try" — never grounds for expiring an object.
  await writeV2(snapshotOf({}, "2026-09-27T07:10:00Z"), s.put, s.get, s.del, { reconcile: false });
  assert.ok("v2/IT/current-hour" in s.files);
});

test("a dark zone expires on its own path, not its country's", async () => {
  const s = store();
  const complete = quarterly([
    pt("2026-08-27T06:00:00Z", 400),
    pt("2026-08-27T06:15:00Z", 300),
    pt("2026-08-27T06:30:00Z", 200),
    pt("2026-08-27T06:45:00Z", 100),
  ]);
  const snap = {
    generated_at: "2026-08-27T07:10:00Z",
    series: { countries: { IT: complete }, zones: { "IT/SICI": complete } },
  };
  await writeV2(snap, s.put, s.get, s.del);
  assert.ok("v2/IT/SICI/past-hour" in s.files);

  // The country keeps reporting — with an hour from the new run, not the stale
  // one, or the freshness bound below would drop it too.
  const late = new Date(Date.parse("2026-08-27T07:10:00Z") + HOURLY_MAX_AGE_SECONDS * 1000 + 3600 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  // The hour /past-hour names for a run at `late`, so the country still reports.
  const stillLive = completeHour(
    new Date(Date.parse(`${late.slice(0, 13)}:00:00Z`) - 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
  );
  await writeV2({ generated_at: late, series: { countries: { IT: stillLive }, zones: {} } }, s.put, s.get, s.del);
  // The country still reports, the zone's stale objects are gone.
  assert.ok("v2/IT/past-hour" in s.files);
  assert.equal("v2/IT/SICI/past-hour" in s.files, false);
  assert.equal("v2/IT/SICI/current-hour" in s.files, false);
  // A zone never reaches the bulk document, retained or not.
  assert.deepEqual(
    JSON.parse(s.files["v2/past-hour.json"]).countries.map((c) => c.country_code),
    ["IT"],
  );
});

test("the OpenAPI document covers every route and resolves every $ref", async () => {
  const s = store();
  await writeV2({ generated_at: "2026-08-27T12:00:00Z", series: { countries: {}, zones: {} } }, s.put, s.get, s.del);
  const spec = JSON.parse(s.files["v2/openapi.json"]);

  // Every published route is documented. This is the assertion that fails when
  // a route is added and the spec is not regenerated.
  assert.deepEqual(Object.keys(spec.paths).sort(), [
    "/v2/countries.json",
    "/v2/past-hour.json",
    "/v2/{code}/current-hour",
    "/v2/{code}/history/{date}",
    "/v2/{code}/latest",
    "/v2/{code}/past-hour",
    "/v2/{code}/yearly",
    "/v2/{code}/{zone}/current-hour",
    "/v2/{code}/{zone}/history/{date}",
    "/v2/{code}/{zone}/latest",
    "/v2/{code}/{zone}/past-hour",
  ]);

  // Generated from the live data, so it cannot drift from what is served.
  assert.equal(spec.components.parameters.code.schema.enum.length, 213);
  assert.equal(spec.components.parameters.zone.schema.enum.length, 80);
  assert.ok(spec.components.parameters.zone.schema.enum.includes("SICI"));

  // A dangling $ref renders as a blank section rather than an error, so check.
  const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    const target = ref.split("/").reduce((o, k) => (o == null ? o : o[k]), spec);
    assert.ok(target, `unresolved $ref: #/${ref}`);
  }

  // No timestamp: the spec describes the API's shape, so it must stay
  // byte-identical between runs and out of the commit log.
  assert.equal(JSON.stringify(spec).includes('generated_at":"2026'), false);
});

test("v1 still reads the newest point when a provider returns a whole window", () => {
  // The premise the v2 split rests on: widening the parsers must not move v1.
  const series = quarterly([
    pt("2026-08-27T06:00:00Z", 400),
    pt("2026-08-27T06:15:00Z", 300),
    pt("2026-08-27T06:30:00Z", 200),
    pt("2026-08-27T06:45:00Z", 117),
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
