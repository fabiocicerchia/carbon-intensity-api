// Estimating an hour the provider has not published yet.
//
// The method is one line: take the newest hour actually measured, and scale it
// by how this grid usually moves between that hour and the target.
//
//   estimate(t) = measured(t0) × profile(t) / profile(t0)
//
// `profile(h)` is the median intensity at hour `h` over the last four weeks for
// the same day type. The anchor carries today's weather; the ratio carries the
// expected diurnal shape.
//
// MULTIPLICATIVE, not additive, because intensity is a ratio bounded below by
// zero: +80 gCO2eq/kWh is meaningless on a 70 grid and trivial on a 500 one,
// while "about a fifth higher by mid-morning" travels across both.
//
// WHY THE HORIZON IS SHORT, and why the cap is the whole design. A calendar
// profile captures solar and demand, which really are diurnal. It cannot capture
// wind, which is weather. The anchor is what carries wind — output is strongly
// autocorrelated over an hour or two — and that correlation decays. By half a
// day a front has moved through, the ratio term carries no information, and the
// estimate collapses to a climatological average: something middling for a grid
// whose truth that day was 90 or 480. There is no signal in this repo's own
// history that says whether it is windy right now, because right now is exactly
// what is missing.
//
// So: estimation is for short gaps and redundancy is for long ones. A provider
// down for twelve hours is a fallback-feed problem, and no amount of arithmetic
// on past data substitutes for a second source.
//
// The cap belongs per country, because the error is dominated by the wind share
// of the grid — a solar-and-gas grid tracks its profile far better than a
// wind-dominated one — and it belongs measured rather than guessed. See
// bin/backtest-estimates.js.
//
// What the measured cap is NOT is a veto on the provider's own lag. An hour-named
// route has to be reached from wherever the feed has actually got to, so the
// measured number sets the floor and the lag lifts it to ANCHOR_MAX_HOURS —
// horizonFor() below, and the reason /v2/DE/current-hour exists at all.

// Four weeks. Enough for ~20 samples per weekday hour once Mon-Fri are pooled,
// which per-weekday buckets would not reach.
export const PROFILE_DAYS = 28;

// Below this many samples for either the target hour or the anchor hour, the
// ratio is noise and nothing is published.
export const MIN_PROFILE_SAMPLES = 5;

// Hours past the anchor an estimate may reach, until a backtest says otherwise
// for a given country. Deliberately short: a wrong default should under-serve,
// not over-claim.
//
// Lowered from 3 once there were numbers to judge it by. The only two European
// grids with enough history to backtest were wrong by 31% (DE) and 37% (GB) at
// the ninetieth percentile three hours out, and the other 28 ENTSO-E countries
// inheriting this default are the same kind of grid. One hour is where those two
// still held (13.7% and 17.2%), so it is what an unmeasured country gets.
//
// A FLOOR, not a ceiling — see horizonFor(). Read as a ceiling it silently
// deleted routes it was never meant to judge: DE publishes about three hours
// behind, so a two-hour horizon put /current-hour permanently out of reach and
// the route 404'd on every green run rather than on any actual failure. A
// horizon shorter than the provider's own lag does not trade accuracy for
// honesty, it just turns the route off.
export const DEFAULT_MAX_HOURS = 1;

// Per-country horizons, set from `npm run backtest` against two months of real
// history. The rule applied to every row, so it can be re-applied when the
// numbers are re-measured:
//
//   a horizon is allowed if its p90 RELATIVE error is <= 30%,
//   OR its p90 ABSOLUTE error is <= 20 gCO2eq/kWh.
//
// Two tests because the grids differ by thirty times. On a coal grid the
// percentage is the meaningful number. On a nuclear or hydro one it is an
// artifact of dividing by something near zero — Finland reads 100% wrong at
// every horizon and is three grams out, which no consumer of this API could
// act on differently. 20 g is the escape hatch because it sits below the
// spread between published emission factors for the same fuel: an error
// smaller than the inputs' own disagreement is not worth withholding a figure
// over. The median is deliberately not part of the rule; it decides nothing
// the p90 has not already decided, and it hid exactly the wrong cases.
//
// Countries absent from this map get DEFAULT_MAX_HOURS. Absent by measurement,
// not by omission: AT (p90 100% and 23 g at one hour — clean enough that the
// grams look small, wrong enough that the estimate can double), EE, HR, LU and
// SK all fail both tests at every horizon. SE and ZA have too few comparisons
// to judge and are left alone rather than guessed at. CH cannot be estimated at
// all: it publishes 0 gCO2/kWh direct in every hour, so the ratio is undefined.
export const ESTIMATE_MAX_HOURS = {
  // Comfortable on the percentage at every horizon measured — coal and gas
  // grids whose shape a diurnal profile genuinely captures.
  BG: 6,
  PL: 6,
  RS: 6,
  US: 6,
  CZ: 5,
  IT: 4,
  RO: 4,
  AU: 3,
  GR: 3,
  PT: 3,
  DE: 2,
  ES: 2,
  GB: 2,
  HU: 2,
  IE: 2,
  BE: 1,
  MK: 1,
  NL: 1,

  // Low-carbon grids, qualifying on grams rather than percent. Their relative
  // error looks alarming and their absolute error is single or low double
  // digits, which is the whole reason the absolute table exists.
  DK: 6,
  FI: 6,
  FR: 6,
  LV: 6,
  NO: 6,
  SI: 6,
  LT: 3,
};

export function maxHoursFor(code) {
  return ESTIMATE_MAX_HOURS[code] ?? DEFAULT_MAX_HOURS;
}

// Where the anchor stops carrying the weather, and no measurement of a country
// may buy more. The backtested horizons say how far an estimate stays useful;
// this says how far it stays an estimate at all. Past it the ratio term is all
// that is left and the figure is a climatological average — something middling
// for a grid whose truth that day was 90 or 480 — so the route 404s and the
// gap is a redundancy problem, as it always was.
//
// Six hours because that is already the age at which an hour stops being
// publishable under either hour-named route (HOURLY_MAX_AGE_SECONDS): a feed
// further behind than this has no business filling the hour running right now.
export const ANCHOR_MAX_HOURS = 6;

// How far past the anchor this run may reach for `code`.
//
// `hoursBehind` is how far the provider actually is behind — anchor hour to the
// clock hour now running — and the horizon stretches to cover it, because that
// distance is not a choice the estimator gets to make. /current-hour names the
// hour in progress; if reaching it from the newest published hour is refused,
// the route can never answer for that country at all, however well the estimate
// would have done. So the backtested number is the floor (a country whose grid
// tracks its profile for six hours keeps six even when its feed is current) and
// the provider's lag lifts it, up to ANCHOR_MAX_HOURS.
//
// The cost is real and is disclosed rather than hidden: an estimate published
// beyond the backtested horizon carries both numbers, so a consumer holding
// itself to the measured error bound can compare `hours_ahead` against
// `backtested_max_hours` and drop the rest.
export function horizonFor(code, hoursBehind = 0) {
  const behind = Number.isFinite(hoursBehind) ? Math.ceil(hoursBehind) : 0;
  return Math.min(Math.max(maxHoursFor(code), behind), ANCHOR_MAX_HOURS);
}

// Weekdays are pooled; Saturday and Sunday stand alone. Demand shape differs
// across that boundary far more than it does between two Tuesdays.
const SUNDAY = 0;
const SATURDAY = 6;
const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const MS_PER_HOUR = SECONDS_PER_HOUR * MS_PER_SECOND;

function dayType(d) {
  const n = d.getUTCDay();
  return n === SUNDAY ? "sun" : n === SATURDAY ? "sat" : "week";
}

function bucket(iso) {
  const d = new Date(iso);
  return `${dayType(d)}:${d.getUTCHours()}`;
}

function median(sorted) {
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// samples: [{ hour: ISO, direct, complete }] — as history stores them.
// Only complete hours count: a partial hour is a mean over fewer points and
// would drag the profile toward whichever part of the hour the provider
// happened to publish.
export function buildProfile(samples) {
  const buckets = new Map();
  let min = Infinity;
  let max = -Infinity;
  for (const s of samples) {
    if (s.direct == null || s.complete !== true) continue;
    const key = bucket(s.hour);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s.direct);
    if (s.direct < min) min = s.direct;
    if (s.direct > max) max = s.direct;
  }
  const medians = new Map();
  const counts = new Map();
  for (const [key, values] of buckets) {
    values.sort((a, b) => a - b);
    // Median, not mean: one provider glitch in four weeks should not move it.
    medians.set(key, median(values));
    counts.set(key, values.length);
  }
  return {
    medians,
    counts,
    min: Number.isFinite(min) ? min : null,
    max: Number.isFinite(max) ? max : null,
  };
}

// -> { hour, direct, hours_ahead, anchor_hour, profile_samples } or null.
// Null whenever the estimate would be unsupported rather than merely uncertain:
// no anchor, too far past it, too few samples either end, or an anchor hour whose
// profile is zero — which would make the ratio meaningless rather than large.
export function estimateHour(targetIso, anchor, profile, { maxHours = DEFAULT_MAX_HOURS } = {}) {
  if (!anchor || anchor.direct == null) return null;
  const ahead = Math.round((Date.parse(targetIso) - Date.parse(anchor.hour)) / MS_PER_HOUR);
  if (!Number.isFinite(ahead) || ahead <= 0 || ahead > maxHours) return null;

  const kTarget = bucket(targetIso);
  const kAnchor = bucket(anchor.hour);
  const pTarget = profile.medians.get(kTarget);
  const pAnchor = profile.medians.get(kAnchor);
  const nTarget = profile.counts.get(kTarget) ?? 0;
  const nAnchor = profile.counts.get(kAnchor) ?? 0;
  if (pTarget == null || pAnchor == null) return null;
  if (nTarget < MIN_PROFILE_SAMPLES || nAnchor < MIN_PROFILE_SAMPLES) return null;
  if (!(pAnchor > 0)) return null;

  // Clamped to what this grid has actually done in the window. The ratio can run
  // away when the anchor hour's profile sits near zero, and a figure outside
  // everything four weeks of the real grid did is not an estimate of it.
  const raw = anchor.direct * (pTarget / pAnchor);
  const direct = Math.min(Math.max(raw, profile.min), profile.max);

  return {
    hour: targetIso,
    direct,
    hours_ahead: ahead,
    anchor_hour: anchor.hour,
    // A partial anchor is still a real measurement, and a later one — but its
    // mean covers only the part of the hour the provider sent, so the ratio is
    // taken against a full-hour profile it does not quite match. Disclosed
    // rather than silently treated as equivalent.
    anchor_complete: anchor.complete === true,
    profile_samples: Math.min(nTarget, nAnchor),
  };
}

// The newest hour with ANY data, which is what an estimate anchors on.
//
// Deliberately not "the newest complete hour". A provider three hours behind
// often has the hour after its last complete one partly filled, and that partial
// mean is both a real measurement and an hour closer to now — using it shortens
// the extrapolation, which is the only thing that actually limits accuracy here.
// Completeness still governs the PROFILE, where a partial hour would bias the
// shape toward whichever part of the hour happened to arrive.
export function newestAnchor(samples) {
  let best = null;
  for (const s of samples) {
    if (s.direct == null) continue;
    if (!best || Date.parse(s.hour) > Date.parse(best.hour)) best = s;
  }
  return best;
}

// Flatten `days` of history documents into samples. `readDay(date)` returns the
// parsed document or null; passing it in rather than importing the store keeps
// this file free of both I/O and a cycle through history.js.
export async function loadWindow(readDay, endDate, days = PROFILE_DAYS) {
  const out = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(`${endDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    const date = d.toISOString().slice(0, 10);
    const doc = await readDay(date);
    if (!doc?.direct) continue;
    for (let h = 0; h < doc.direct.length; h += 1) {
      if (doc.direct[h] == null) continue;
      out.push({
        hour: `${date}T${String(h).padStart(2, "0")}:00:00Z`,
        direct: doc.direct[h],
        complete: doc.complete?.[h] === true,
      });
    }
  }
  return out;
}
