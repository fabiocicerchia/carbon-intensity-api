import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANCHOR_MAX_HOURS,
  buildProfile,
  DEFAULT_MAX_HOURS,
  estimateHour,
  horizonFor,
  loadWindow,
  MIN_PROFILE_SAMPLES,
  newestAnchor,
} from "../src/estimate.js";

// Four weeks of a grid with a clean diurnal shape: cheap at midday when solar
// runs, dearer overnight. 2026-08-31 is a Monday.
const weeks = (shape, { complete = true, days = 28 } = {}) => {
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    const day = new Date("2026-08-31T00:00:00Z");
    day.setUTCDate(day.getUTCDate() - d);
    const date = day.toISOString().slice(0, 10);
    for (let h = 0; h < 24; h += 1) {
      out.push({ hour: `${date}T${String(h).padStart(2, "0")}:00:00Z`, direct: shape(h, day), complete });
    }
  }
  return out;
};
const diurnal = (h) => (h >= 10 && h <= 15 ? 200 : 400);

test("the profile pools weekdays and keeps Saturday and Sunday apart", () => {
  const p = buildProfile(weeks((h, d) => (d.getUTCDay() === 0 ? 100 : diurnal(h))));
  assert.equal(p.medians.get("week:12"), 200);
  assert.equal(p.medians.get("week:03"), undefined); // keys are unpadded
  assert.equal(p.medians.get("week:3"), 400);
  assert.equal(p.medians.get("sun:12"), 100, "Sunday is its own shape");
  // Four weeks gives ~20 weekday samples per hour, 4 each for Sat and Sun.
  assert.ok(p.counts.get("week:12") >= 15);
  assert.equal(p.min, 100);
  assert.equal(p.max, 400);
});

test("a partial hour never enters the profile", () => {
  // Same data, every hour incomplete: a mean over fewer points would drag the
  // profile toward whichever part of the hour the provider happened to publish.
  const p = buildProfile(weeks(diurnal, { complete: false }));
  assert.equal(p.medians.size, 0);
  assert.equal(p.min, null);
});

test("an estimate is the anchor scaled by the profile's shape", () => {
  const p = buildProfile(weeks(diurnal));
  // Anchor at 09:00 on an unusually dirty day: 600 against a profile of 400.
  const anchor = { hour: "2026-08-31T09:00:00Z", direct: 600, complete: true };
  const e = estimateHour("2026-08-31T12:00:00Z", anchor, p, { maxHours: 4 });
  // Profile halves from 09:00 to 12:00, so the estimate halves too — the day's
  // own level is carried, the shape is applied.
  assert.equal(e.direct, 300);
  assert.equal(e.hours_ahead, 3);
  assert.equal(e.anchor_hour, "2026-08-31T09:00:00Z");
});

test("nothing is published where the estimate would be unsupported", () => {
  const p = buildProfile(weeks(diurnal));
  const anchor = { hour: "2026-08-31T09:00:00Z", direct: 600, complete: true };

  // Past the horizon: the anchor no longer carries the weather.
  assert.equal(estimateHour("2026-08-31T21:00:00Z", anchor, p, { maxHours: 3 }), null);
  // Backwards, or the anchor's own hour.
  assert.equal(estimateHour("2026-08-31T08:00:00Z", anchor, p), null);
  assert.equal(estimateHour("2026-08-31T09:00:00Z", anchor, p), null);
  // No anchor at all.
  assert.equal(estimateHour("2026-08-31T10:00:00Z", null, p), null);
  assert.equal(estimateHour("2026-08-31T10:00:00Z", { hour: anchor.hour, direct: null }, p), null);
  // Too little history to have a shape at all.
  const thin = buildProfile(weeks(diurnal, { days: 2 }));
  assert.ok((thin.counts.get("week:12") ?? 0) < MIN_PROFILE_SAMPLES);
  assert.equal(estimateHour("2026-08-31T12:00:00Z", anchor, thin), null);
});

test("an estimate cannot leave the range the grid actually reached", () => {
  // A profile with a near-zero anchor hour would otherwise send the ratio to
  // absurdity: 600 * 400/1 is not an estimate of anything.
  const p = buildProfile(weeks((h) => (h === 9 ? 1 : 400)));
  const anchor = { hour: "2026-08-31T09:00:00Z", direct: 600, complete: true };
  const e = estimateHour("2026-08-31T10:00:00Z", anchor, p, { maxHours: 2 });
  assert.equal(e.direct, p.max, "clamped to the window's own maximum");
  assert.ok(e.direct <= 400);
});

test("the anchor is the newest hour with data, partial included", () => {
  // A provider three hours behind usually has the hour after its last complete
  // one partly filled. That mean is a real measurement and an hour closer to the
  // target, and shortening the extrapolation is the only thing that meaningfully
  // limits the error — so the partial hour wins.
  const a = newestAnchor([
    { hour: "2026-08-31T08:00:00Z", direct: 300, complete: true },
    { hour: "2026-08-31T09:00:00Z", direct: 320, complete: false },
  ]);
  assert.equal(a.hour, "2026-08-31T09:00:00Z");
  assert.equal(newestAnchor([]), null);
  assert.equal(newestAnchor([{ hour: "2026-08-31T09:00:00Z", direct: null }]), null);
});

test("an estimate discloses whether its anchor was a whole hour", () => {
  const p = buildProfile(weeks(diurnal));
  const partial = { hour: "2026-08-31T09:00:00Z", direct: 600, complete: false };
  const e = estimateHour("2026-08-31T11:00:00Z", partial, p, { maxHours: 3 });
  // Usable — but its mean covers only the part of the hour that arrived, and the
  // ratio is taken against a full-hour profile, so the document says so.
  assert.equal(e.anchor_complete, false);
  assert.equal(e.direct, 300);
  const whole = estimateHour("2026-08-31T11:00:00Z", { ...partial, complete: true }, p, { maxHours: 3 });
  assert.equal(whole.anchor_complete, true);
});

test("loadWindow walks back day by day and skips missing days and hours", async () => {
  const days = {
    "2026-08-31": { direct: [100, null, 300], complete: [true, null, false] },
    "2026-08-29": { direct: [500], complete: [true] },
  };
  const got = await loadWindow(async (d) => days[d] ?? null, "2026-08-31", 3);
  assert.deepEqual(got, [
    { hour: "2026-08-31T00:00:00Z", direct: 100, complete: true },
    // hour 1 is null and skipped; hour 2 is present but incomplete and kept as
    // such, so buildProfile can drop it and newestAnchor can refuse it.
    { hour: "2026-08-31T02:00:00Z", direct: 300, complete: false },
    { hour: "2026-08-29T00:00:00Z", direct: 500, complete: true },
  ]);
});

test("the default horizon is short, so a missing backtest under-serves", () => {
  assert.ok(DEFAULT_MAX_HOURS <= 3);
});

test("the horizon stretches to the provider's lag and stops at the ceiling", () => {
  // A current feed keeps exactly what its grid was measured at, either way.
  assert.equal(horizonFor("DE", 0), 2);
  assert.equal(horizonFor("US", 1), 6);
  assert.equal(horizonFor("AT", 0), DEFAULT_MAX_HOURS);

  // Behind by more than the backtest allowed: the lag wins, because refusing it
  // does not buy accuracy — it removes /current-hour from the country entirely.
  assert.equal(horizonFor("DE", 3), 3);
  assert.equal(horizonFor("AT", 3), 3);

  // Past the ceiling nothing is bought back. A feed half a day behind cannot
  // fill the hour running now: the anchor no longer carries the weather, and
  // that is a fallback-feed problem rather than an arithmetic one.
  assert.equal(horizonFor("DE", 25), ANCHOR_MAX_HOURS);
  assert.equal(horizonFor("US", 12), ANCHOR_MAX_HOURS);
  assert.equal(horizonFor("DE", NaN), 2);
});
