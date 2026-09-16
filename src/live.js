// Real-time providers. Each is split into a pure parse* function (unit-tested,
// no network) and a thin fetch* wrapper (global fetch).
// measuredLastHour selects a provider per country and returns a
// normalized reading, or null so the caller falls back to the annual snapshot.

import {
  EIA_FUEL_TO_FUEL,
  ELEXON_FUEL_TO_FUEL,
  ENTSOE_PSR_TO_FUEL,
  ESKOM_INDEX_TO_FUEL,
  energyChartsFuel,
  IESO_FUEL_TO_FUEL,
  mixToDirectIntensity,
  ONS_FUEL_TO_FUEL,
  OPENNEM_FUEL_TO_FUEL,
  SG_FUEL_TO_FUEL,
} from "./factors.js";

// --- country -> ENTSO-E domain EIC code ---------------------------------------
// Belarus is deliberately absent despite having an EIC code (10Y1001A1001A51S).
// It is in the registry as an interconnection partner, not as a member of the
// ENTSO-E area — it sits in BRELL with Russia — and 16.1.B&C answers
// acknowledgement 999 for every window of it. Two full backfills, eighteen
// windows, nothing. Listing it cost a request every run and advertised a live
// provider for a country that has never had one.
export const ENTSOE_DOMAIN = {
  AT: "10YAT-APG------L",
  BE: "10YBE----------2",
  BG: "10YCA-BULGARIA-R",
  CH: "10YCH-SWISSGRIDZ",
  CZ: "10YCZ-CEPS-----N",
  DE: "10Y1001A1001A83F",
  DK: "10Y1001A1001A65H",
  EE: "10Y1001A1001A39I",
  ES: "10YES-REE------0",
  FI: "10YFI-1--------U",
  FR: "10YFR-RTE------C",
  GR: "10YGR-HTSO-----Y",
  HR: "10YHR-HEP------M",
  HU: "10YHU-MAVIR----U",
  IE: "10Y1001A1001A59C",
  IT: "10YIT-GRTN-----B",
  LT: "10YLT-1001A0008Q",
  LU: "10YLU-CEGEDEL-NQ",
  LV: "10YLV-1001A00074",
  MK: "10YMK-MEPSO----8",
  NL: "10YNL----------L",
  NO: "10YNO-0--------C",
  PL: "10YPL-AREA-----S",
  PT: "10YPT-REN------W",
  RO: "10YRO-TEL------P",
  RS: "10YCS-SERBIATSOV",
  SE: "10YSE-1--------K",
  SI: "10YSI-ELES-----O",
  SK: "10YSK-SEPS-----K",
};

// --- country -> sub-country zones --------------------------------------------
// Maps a zone code to whatever identifier ITS provider wants: an EIC code for
// ENTSO-E, a respondent for EIA, a path segment for OpenNEM. Only countries
// whose provider publishes generation below national level appear here.
export const ZONES = {
  // ENTSO-E bidding zones. Italy is the seven market zones in force since the
  // 2021 reform — the abolished ones (BRNN/FOGN/PRGP/ROSN), the MACRO_*
  // aggregates and the virtual interconnector zones are deliberately absent.
  IT: {
    NORD: "10Y1001A1001A73I",
    CNOR: "10Y1001A1001A70O",
    CSUD: "10Y1001A1001A71M",
    SUD: "10Y1001A1001A788",
    CALA: "10Y1001C--00096J",
    SICI: "10Y1001A1001A75E",
    SARD: "10Y1001A1001A74G",
  },
  SE: {
    SE1: "10Y1001A1001A44P",
    SE2: "10Y1001A1001A45N",
    SE3: "10Y1001A1001A46L",
    SE4: "10Y1001A1001A47J",
  },
  NO: {
    NO1: "10YNO-1--------2",
    NO2: "10YNO-2--------T",
    NO3: "10YNO-3--------J",
    NO4: "10YNO-4--------9",
    NO5: "10Y1001A1001A48H",
  },
  DK: { DK1: "10YDK-1--------W", DK2: "10YDK-2--------M" },
  // EIA-930, passed through as the `respondent` facet. Both grains are offered:
  // the thirteen regions, and the balancing authorities inside them — CAISO and
  // ERCOT are different grids that a regional average blurs together. The long
  // tail of very small BAs is omitted; many do not report a fuel-type breakdown,
  // and a respondent that returns nothing just costs a request.
  US: {
    CAL: "CAL",
    CAR: "CAR",
    CENT: "CENT",
    FLA: "FLA",
    MIDA: "MIDA",
    MIDW: "MIDW",
    NE: "NE",
    NW: "NW",
    NY: "NY",
    SE: "SE",
    SW: "SW",
    TEN: "TEN",
    TEX: "TEX",
    AECI: "AECI",
    AVA: "AVA",
    AZPS: "AZPS",
    BANC: "BANC",
    BPAT: "BPAT",
    CISO: "CISO",
    CPLE: "CPLE",
    DUK: "DUK",
    EPE: "EPE",
    ERCO: "ERCO",
    FPC: "FPC",
    FPL: "FPL",
    IID: "IID",
    IPCO: "IPCO",
    ISNE: "ISNE",
    JEA: "JEA",
    LDWP: "LDWP",
    LGEE: "LGEE",
    MISO: "MISO",
    NEVP: "NEVP",
    NWMT: "NWMT",
    NYIS: "NYIS",
    PACE: "PACE",
    PACW: "PACW",
    PGE: "PGE",
    PJM: "PJM",
    PNM: "PNM",
    PSCO: "PSCO",
    PSEI: "PSEI",
    SC: "SC",
    SCEG: "SCEG",
    SCL: "SCL",
    SOCO: "SOCO",
    SRP: "SRP",
    SWPP: "SWPP",
    TEC: "TEC",
    TEPC: "TEPC",
    TIDC: "TIDC",
    TPWR: "TPWR",
    TVA: "TVA",
    WACM: "WACM",
    WALC: "WALC",
  },
  // OpenNEM. The five NEM regions plus WEM, which is a physically separate
  // network (the South West Interconnected System around Perth) and so has its
  // own path rather than sitting under NEM.
  AU: {
    NSW1: "NEM/NSW1",
    QLD1: "NEM/QLD1",
    SA1: "NEM/SA1",
    TAS1: "NEM/TAS1",
    VIC1: "NEM/VIC1",
    WEM: "WEM",
  },
  // IESO. Canada's grid is provincial and only Ontario publishes a keyless
  // hourly fuel mix, so the country as a whole stays on the annual snapshot —
  // Ontario at ~130 is not Quebec at ~30 or Alberta at ~500, and publishing one
  // province's number as Canada's would be worse than the average it replaced.
  CA: { ON: "ON" },
};

export function zonesFor(code) {
  return Object.keys(ZONES[String(code).toUpperCase()] || {});
}

// Countries with a national provider of their own. Everything else with an
// ENTSO-E domain goes there; the rest have none.
const PROVIDERS = { GB: "NESO", US: "EIA", BR: "ONS", AU: "OpenNEM", SG: "EMC", ZA: "Eskom", CA: "IESO" };

// Fallback feeds, tried in order after a country's primary. A country keeps one
// source in normal operation and only moves when the primary has nothing at all
// — "first that works", not "freshest wins", because the latter would flip
// sources every time two lags crossed and put steps in the series that read as
// real changes in the grid.
//
// Fallbacks fail safe: a fetcher that errors or a parser that does not recognise
// a payload simply hands on to the next, and a country with no working fallback
// behaves exactly as it did before it had one.
export const FALLBACK_PROVIDERS = {
  // Energy-Charts (Fraunhofer ISE) is listed for these two only. It carries most
  // of Europe from one endpoint, and was configured for all 30 ENTSO-E countries
  // until it was measured: during the 2026-08-29 publication outage it ran 6.1 h
  // behind for DE and 4.9 h for CH but 17.1 h for FR, 16.6 h for IT and 15.9 h
  // for PL — the last stopping exactly where ENTSO-E stopped. For the other 28 it
  // re-publishes the primary, so it was removed rather than left standing as
  // redundancy that is not there.
  DE: ["Energy-Charts"],
  CH: ["Energy-Charts"],
  // BMRS settlement metering: a separate path from NESO's modelled intensity.
  GB: ["Elexon"],
};

// What a fallback actually protects against, keyed `CODE:Provider`. A second
// feed is not automatically redundancy, and the difference is not a property of
// the feed — it is a property of the pair, because the same aggregator can be
// independent for one country and downstream of the primary for the next.
//
//   "independent" the feed has its own path to the meters. Covers the primary
//                 going down for any reason, publication outages included.
//   "api-only"    the feed re-publishes the primary. Covers the primary's API
//                 failing while the data exists — a real and distinct failure —
//                 and nothing at all when the primary stops publishing.
//
// Measured on 2026-08-30 while ENTSO-E was recovering: Energy-Charts was 6.1 h
// behind for DE and 4.9 h for CH but 17.1 h for FR, 16.6 h for IT and 15.9 h for
// PL, the last stopping exactly where ENTSO-E stopped. So it is assumed
// downstream unless a measurement says otherwise, which is the safe direction to
// be wrong in: claiming redundancy that is not there is the failure this table
// exists to prevent.
export const FALLBACK_COVERAGE = {
  "DE:Energy-Charts": "independent",
  "CH:Energy-Charts": "independent",
  "GB:Elexon": "independent",
};

// "independent" once a country has any fallback at all, because a fallback that
// is not independent cannot be reached — see providersFor. "none" otherwise.
export function redundancyFor(code, zone = null) {
  return providersFor(code, zone).length > 1 ? "independent" : "none";
}
// Provenance belongs to the FEED, not to the country. `sources.json` is keyed by
// country and describes the annual dataset's source, which is right for
// /yearly and wrong for an hourly reading: GB documents were carrying Elexon's
// URL under NESO's name, and FR's carried RTE's while the data came from
// ENTSO-E. With fallbacks a country has no single answer at all, so the hourly
// documents now take their `data_source` from whichever feed actually replied.
//
// Each URL is the endpoint this repo actually calls, so the attribution cannot
// drift from the code the way a hand-maintained table does.
export const PROVIDER_SOURCES = {
  "ENTSO-E": { name: "ENTSO-E", url: "https://web-api.tp.entsoe.eu/api" },
  NESO: { name: "NESO", url: "https://api.carbonintensity.org.uk/" },
  EIA: { name: "EIA", url: "https://api.eia.gov/v2/electricity/rto/fuel-type-data/" },
  ONS: { name: "ONS", url: "https://tr.ons.org.br/Content/GetBalancoEnergetico/null" },
  OpenNEM: { name: "OpenNEM", url: "https://data.openelectricity.org.au/" },
  EMC: { name: "EMC", url: "https://www.emcsg.com/ChartServer/blue/ticker" },
  Eskom: { name: "Eskom", url: "https://www.eskom.co.za/dataportal/" },
  Elexon: { name: "Elexon BMRS", url: "https://data.elexon.co.uk/bmrs/api/v1/datasets/FUELINST" },
  IESO: { name: "IESO", url: "https://reports-public.ieso.ca/public/GenOutputCapability/" },
  "Energy-Charts": { name: "Energy-Charts (Fraunhofer ISE)", url: "https://api.energy-charts.info/" },
};

// What a measured hourly document should say about where its figure came from.
// Falls back to the country's annual-dataset entry only for a provider with no
// entry here, so an unknown feed degrades to today's behaviour rather than to
// nothing.
export function providerSource(provider) {
  return PROVIDER_SOURCES[provider] || null;
}

// --- helpers -----------------------------------------------------------------
function iso(dt) {
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// What a feed is assumed to publish at when it names no interval of its own.
const DEFAULT_INTERVAL_MINUTES = 5;
// NESO reports against half-hourly settlement periods.
const NESO_SETTLEMENT_SEC = 1800;
// "YYYY-MM-DDTHH": 13 characters, the date/time separator at index 10.
const EIA_HOUR_FORM_LENGTH = 13;
const ISO_T_INDEX = 10;
const ISO_DATE_LENGTH = 10;
const ISO_HOUR_LENGTH = 13;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const MS_PER_HOUR = SECONDS_PER_HOUR * MS_PER_SECOND;
const HOURS_PER_DAY = 24;
const PERCENT = 100;
const MONTH_ABBREV_LENGTH = 3;
// Singapore's ticker numbers half-hourly periods from 1 and stamps them in SGT
// (+08:00), which has no daylight saving to complicate the shift.
const SG_PERIOD_MINUTES = 30;
const SGT_OFFSET_HOURS = 8;
const SGT_OFFSET_MS = SGT_OFFSET_HOURS * MS_PER_HOUR;
// FUELINST publishes every five minutes; this is the assumption used only when
// there is a single instant and no spacing to read the cadence from.
const ELEXON_FALLBACK_STEP_SEC = 300;
const ELEXON_LOOKBACK_HOURS = 2;
const ENERGY_CHARTS_LOOKBACK_HOURS = 24;
// How much of a provider's error body is worth quoting back in the message.
const ERROR_BODY_CHARS = 300;
// 5xx is the provider struggling, 429 is it shedding load; both are worth
// another attempt, and a 4xx is the request itself.
const HTTP_SERVER_ERROR = 500;
const HTTP_TOO_MANY_REQUESTS = 429;
// Doubling with jitter: each retry waits 50-150% of its nominal delay.
const BACKOFF_BASE = 2;
const JITTER_MIN = 0.5;

function parseDt(text) {
  let t = String(text).trim();
  if (t.length === EIA_HOUR_FORM_LENGTH && t[ISO_T_INDEX] === "T") t += ":00:00"; // EIA hour-only form
  t = t.replace(" ", "T");
  if (!/[zZ]$/.test(t) && !/[+-]\d\d:?\d\d$/.test(t)) t += "Z"; // naive -> UTC
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new Error(`bad datetime ${text}`);
  return d;
}

function hourWindow(instant) {
  const start = new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate(), instant.getUTCHours()),
  );
  return [iso(start), iso(new Date(start.getTime() + MS_PER_HOUR))];
}

function num(text) {
  const m = String(text).match(/-?\d[\d,]*\.?\d*/);
  if (!m) throw new Error(`no number in ${text}`);
  return parseFloat(m[0].replace(/,/g, ""));
}

function intervalMinutes(text) {
  const t = String(text || "")
    .trim()
    .toLowerCase();
  if (t.endsWith("m")) return parseInt(t.slice(0, -1), 10);
  if (t.endsWith("h")) return parseInt(t.slice(0, -1), 10) * SECONDS_PER_MINUTE;
  return DEFAULT_INTERVAL_MINUTES;
}

// --- the parser contract ------------------------------------------------------
// Every parse* returns a SERIES: { resolution_sec, points: [{start, end, direct}] },
// oldest point first. Providers were publishing several points per response all
// along — ENTSO-E's A75 covers the requested window at PT15M, EIA sorts 200 hourly rows —
// and every parser used to keep only the newest and drop the rest, which is why
// an hourly *mean* was not computable and history had to be sampled one run at a
// time.
//
// `resolution_sec` is the cadence at which this provider gives us points, not
// necessarily its own internal granularity. For a provider that publishes one
// snapshot per request (OpenNEM, EMC, Eskom, ONS) that cadence is hourly and the
// single point represents its clock hour — declaring the true sub-hourly
// granularity instead would mark every hour permanently incomplete and
// /past-hour would never answer for those countries.
function series(resolutionSec, points) {
  return { resolution_sec: resolutionSec, points };
}

// One point covering the clock hour containing `instant`. The shape the
// snapshot providers produce, and exactly the window v1 gave them.
function hourPoint(instant, direct) {
  const [start, end] = hourWindow(instant);
  return series(SECONDS_PER_HOUR, [{ start, end, direct }]);
}

// How many points a complete hour holds for this resolution. 4 at PT15M, 2 for
// NESO's half-hourly settlement periods, 1 for an hourly feed.
export function pointsPerHour(resolutionSec) {
  return Math.max(1, Math.round(SECONDS_PER_HOUR / resolutionSec));
}

// The v1 reading: the newest point, which is what the single-reading parsers
// returned before they were widened to a series. v1 objects are frozen, so this
// is the adapter that keeps them byte-identical.
export function newestReading(s) {
  if (!s?.points?.length) return null;
  const p = s.points[s.points.length - 1];
  return { direct: p.direct, hour_start: p.start, hour_end: p.end, source: s.source };
}

// --- ENTSO-E (dependency-free XML extraction of A75) --------------------------
// Upper bound on how many step-slots one Period may expand to. Two days at
// PT15M — far beyond the twelve hours we ask for, and small enough that a
// document declaring a nonsense interval cannot run the machine out of memory.
const SLOTS_PER_HOUR_AT_PT15M = 4;
const MAX_PERIOD_DAYS = 2;
const MAX_PERIOD_SLOTS = SLOTS_PER_HOUR_AT_PT15M * HOURS_PER_DAY * MAX_PERIOD_DAYS;

// Mark a failure the provider will repeat verbatim. Retrying a refusal is not
// resilience — the platform answered, and it will answer the same way one and
// three seconds later. During the 2026-08-29 maintenance the retries turned 48
// pointless requests per run into 144 of them, three times an hour, against a
// service that was down. What actually rides out an outage that long is the
// schedule (a run every 20 minutes) and HOURLY_MAX_AGE_SECONDS holding the
// routes up meanwhile; in-run backoff is for a dropped connection.
function notRetryable(err) {
  err.retryable = false;
  return err;
}

// A provider that answered, and had nothing to say. Distinct from one that
// could not be reached: a retry cannot conjure rows that the publisher has not
// published, and a backfill that ends empty for this reason is not waiting on
// anything — the series simply has no data for the window, or at all.
function noData(err) {
  err.empty = true;
  return notRetryable(err);
}

export function parseEntsoe(xml) {
  // ENTSO-E answers in three shapes and only one of them is a document. Telling
  // them apart here is the difference between a run log that says why the data
  // is missing and one that says "no usable generation data" for every cause
  // there is — which is what it said through a 22-hour platform outage.
  if (/<Acknowledgement_MarketDocument/.test(xml)) {
    // A refusal, but a well-formed one: the platform is up and answering. Code
    // 999 with "No matching data found" means it holds nothing for the window,
    // which is a provider gap; anything else is usually the request or the
    // token. Both belong in the log verbatim — neither carries a credential.
    const code = (xml.match(/<code>([^<]*)</) || [])[1] || "?";
    const text = (xml.match(/<text>([^<]*)</) || [])[1] || "no reason given";
    throw noData(new Error(`ENTSO-E acknowledgement ${code}: ${text}`));
  }
  if (!/<GL_MarketDocument/.test(xml)) {
    // Neither a document nor a refusal. In practice the maintenance page —
    // "Service Temporarily Unavailable" as HTML, which is not always served
    // with a 5xx and so can arrive here looking like a successful fetch.
    const html = /^\s*<(?:!doctype|html)/i.test(xml);
    const title = (xml.match(/<title>([^<]*)</i) || [])[1];
    throw notRetryable(
      new Error(
        `ENTSO-E returned no market document${html ? " (an HTML page" : " ("}` +
          `${title ? `: "${title.trim()}"` : ""}) — platform maintenance?`,
      ),
    );
  }
  const blocks = xml.match(/<TimeSeries\b[\s\S]*?<\/TimeSeries>/g) || [];
  // One TimeSeries per fuel, each carrying the whole window, so the mix has to
  // be accumulated per instant rather than per document — keyed by the point's
  // own start, which also absorbs a series that skips positions.
  const byInstant = new Map();
  for (const ts of blocks) {
    const hasOut = /<outBiddingZone_Domain\.mRID/.test(ts);
    const hasIn = /<inBiddingZone_Domain\.mRID/.test(ts);
    if (hasOut && !hasIn) continue; // consumption (pumped-storage load) series
    const psr = (ts.match(/<psrType>\s*([^<\s]+)/) || [])[1] || "";
    const fuel = ENTSOE_PSR_TO_FUEL[psr] || "other";
    const periods = ts.match(/<Period>[\s\S]*?<\/Period>/g) || [];
    for (const period of periods) {
      const startM = period.match(/<start>([^<]+)</);
      const resM = period.match(/<resolution>([^<]+)</);
      const points = period.match(/<Point>[\s\S]*?<\/Point>/g) || [];
      if (!startM || points.length === 0) continue;
      const step = intervalMinutes(resM ? resM[1].trim().replace(/^PT/i, "") : "60m");
      const start = parseDt(startM[1]);
      const endM = period.match(/<end>([^<]+)</);
      // ENTSO-E returns curveType A03, "variable sized blocks": a point holds
      // until the NEXT position, so a series that changes slowly is published
      // sparsely. Reading only the positions present would leave nuclear and
      // lignite at the first instant and nothing after it while solar reports
      // every quarter hour — and the mix at 21:15 would then be solar alone, a
      // handful of gCO2 where the truth is a few hundred. Filling forward is a
      // no-op under A01, where every position is present, so it is done
      // unconditionally rather than behind a curveType check that would only
      // be one more thing able to disagree with the document.
      const parsed = [];
      for (const p of points) {
        const pos = parseInt((p.match(/<position>(\d+)/) || [])[1], 10);
        const qty = parseFloat((p.match(/<quantity>([^<]+)/) || [])[1]);
        if (Number.isNaN(pos) || Number.isNaN(qty)) continue;
        parsed.push({ pos, qty });
      }
      parsed.sort((a, b) => a.pos - b.pos);
      // The Period's own end says how many slots the last point covers. Capped
      // so a malformed interval cannot make this loop enormous; our own window
      // is twelve hours, well inside it.
      const lastSlot = endM
        ? Math.min(
            Math.round((parseDt(endM[1]).getTime() - start.getTime()) / (step * MS_PER_MINUTE)),
            MAX_PERIOD_SLOTS,
          )
        : null;
      for (let i = 0; i < parsed.length; i += 1) {
        const { pos: from, qty } = parsed[i];
        let until = i + 1 < parsed.length ? parsed[i + 1].pos - 1 : (lastSlot ?? from);
        if (lastSlot !== null) until = Math.min(until, lastSlot);
        until = Math.max(until, from);
        for (let pos = from; pos <= until; pos += 1) {
          const ms = start.getTime() + step * (pos - 1) * MS_PER_MINUTE;
          if (!byInstant.has(ms)) byInstant.set(ms, { step, mix: {} });
          const slot = byInstant.get(ms);
          slot.mix[fuel] = (slot.mix[fuel] || 0) + qty;
        }
      }
    }
  }

  const out = [];
  for (const ms of [...byInstant.keys()].sort((a, b) => a - b)) {
    const { step, mix } = byInstant.get(ms);
    const direct = mixToDirectIntensity(mix);
    if (direct == null) continue; // an instant present but with nothing usable
    out.push({ start: iso(new Date(ms)), end: iso(new Date(ms + step * MS_PER_MINUTE)), direct });
  }
  if (out.length === 0) {
    throw noData(new Error("ENTSO-E document contained no usable generation data"));
  }
  // The newest point's own step: a document that changes resolution part-way
  // through describes the present with its last one.
  const newest = byInstant.get(Math.max(...byInstant.keys()));
  return series(newest.step * 60, out);
}

// --- EIA ----------------------------------------------------------------------
export function parseEia(payload) {
  const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
  const rows = obj?.response?.data || [];
  if (rows.length === 0) throw noData(new Error("EIA response contained no data rows"));
  // fetchEia asks for 200 rows sorted by period; every period in them is a
  // point, not just the newest.
  const byPeriod = new Map();
  for (const r of rows) {
    const fuel = EIA_FUEL_TO_FUEL[r.fueltype] || "other";
    const val = parseFloat(r.value);
    if (Number.isNaN(val)) continue;
    if (!byPeriod.has(r.period)) byPeriod.set(r.period, {});
    const mix = byPeriod.get(r.period);
    mix[fuel] = (mix[fuel] || 0) + val;
  }
  const out = [];
  for (const period of [...byPeriod.keys()].sort()) {
    const direct = mixToDirectIntensity(byPeriod.get(period));
    if (direct == null) continue;
    const start = parseDt(period);
    out.push({ start: iso(start), end: iso(new Date(start.getTime() + MS_PER_HOUR)), direct });
  }
  if (out.length === 0) throw new Error("EIA period had no usable generation data");
  return series(SECONDS_PER_HOUR, out);
}

// --- UK NESO ------------------------------------------------------------------
// `payload` is /intensity: exactly one row, the settlement period in progress,
// and the row v1 reports verbatim. `dayPayload` is the optional /intensity/date
// feed, which carries every period of the settlement day — the only way an hour
// gets both of its halves, since /intensity is a single period per call and the
// two halves would otherwise arrive on different runs with nothing to join them.
//
// The day feed cannot simply replace /intensity: its tail is future periods
// carrying only a forecast, and it lags by a period (it had no `actual` for the
// in-progress one). So it is filtered to settled rows and used only to widen the
// series *behind* the current period.
export function parseUk(payload, dayPayload = null) {
  const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
  const rows = obj?.data || [];
  if (rows.length === 0) throw noData(new Error("NESO response contained no data"));
  const intensityOf = (row) => row?.intensity?.actual ?? row?.intensity?.forecast;
  // Checked against the newest row specifically, not "any row has a value":
  // v1 fell back to the annual figure when the current period had no intensity,
  // and widening to a series must not quietly start answering with an older one.
  const newest = rows[rows.length - 1];
  if (intensityOf(newest) == null) throw new Error("NESO period had no intensity");

  const byStart = new Map();
  let stepSec = NESO_SETTLEMENT_SEC;
  const add = (row, value) => {
    const start = parseDt(row.from);
    const end = parseDt(row.to);
    const span = Math.round((end.getTime() - start.getTime()) / MS_PER_SECOND);
    if (span > 0) stepSec = span;
    byStart.set(iso(start), { start: iso(start), end: iso(end), direct: Number(value) });
  };

  // Settled periods first; only rows with a real `actual`, never a forecast.
  const dayObj = typeof dayPayload === "string" ? JSON.parse(dayPayload) : dayPayload;
  for (const row of dayObj?.data || []) {
    const settled = row?.intensity?.actual;
    if (settled != null) add(row, settled);
  }
  // Then the current period, last and authoritative — keyed by start, so it
  // replaces the day feed's copy rather than duplicating it.
  for (const row of rows) {
    const value = intensityOf(row);
    if (value != null) add(row, value);
  }

  const out = [...byStart.keys()].sort().map((k) => byStart.get(k));
  return series(stepSec, out);
}

// --- ONS (Brazil) -------------------------------------------------------------
export function parseOns(payload) {
  const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
  const regions = ["nordeste", "norte", "sudesteECentroOeste", "sul"];
  const mix = {};
  let found = false;
  for (const region of regions) {
    const geracao = obj?.[region]?.geracao || {};
    for (const [key, value] of Object.entries(geracao)) {
      if (key === "total" || value == null) continue;
      const fuel = ONS_FUEL_TO_FUEL[key.toLowerCase()];
      if (!fuel) continue;
      mix[fuel] = (mix[fuel] || 0) + Number(value);
      found = true;
    }
  }
  const intensity = mixToDirectIntensity(mix);
  if (!found || intensity == null) throw new Error("ONS response had no usable data");
  return hourPoint(parseDt(obj.Data), intensity);
}

// --- OpenNEM / OpenElectricity ------------------------------------------------
// One entry per production series, each carrying its own clock. The series do
// not share a start time or a length — rooftop solar in particular runs on its
// own — so they must be aligned on timestamps. Indexing every series with one
// shared position reads a different instant from each, and where the offset
// exceeds the shorter arrays it reads only the longest, yielding a mix of one
// fuel or none.
function opennemTracks(payload) {
  const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
  const found = (obj.data || []).filter(
    (s) => s.type === "power" && s.fuel_tech && OPENNEM_FUEL_TO_FUEL[String(s.fuel_tech).toLowerCase()],
  );
  if (found.length === 0) throw new Error("OpenNEM response had no production series");
  return found.map((s) => ({
    fuel: OPENNEM_FUEL_TO_FUEL[String(s.fuel_tech).toLowerCase()],
    start: parseDt(s.history.start).getTime(),
    step: intervalMinutes(s.history.interval || "5m") * MS_PER_MINUTE,
    data: s.history.data,
  }));
}

export function parseOpennem(payload) {
  const tracks = opennemTracks(payload);
  // Latest instant every track has a value for. Taking the newest instant of
  // any single track instead would land on one a slower feed has not reached.
  const ends = tracks
    .map((t) => {
      let i = t.data.length - 1;
      while (i >= 0 && t.data[i] == null) i -= 1;
      return i >= 0 ? t.start + i * t.step : null;
    })
    .filter((t) => t != null);
  if (ends.length === 0) throw noData(new Error("OpenNEM series contained no values"));
  const instant = Math.min(...ends);
  const mix = {};
  for (const t of tracks) {
    const i = Math.round((instant - t.start) / t.step);
    const v = i >= 0 && i < t.data.length ? t.data[i] : null;
    if (v == null) continue;
    mix[t.fuel] = (mix[t.fuel] || 0) + Number(v);
  }
  const intensity = mixToDirectIntensity(mix);
  if (intensity == null) throw new Error("OpenNEM latest interval had no usable generation");
  // One point per fetch on the live path, though the 7d payload holds a full
  // 5-minute history per fuel. parseOpennemAll below pays the re-alignment cost
  // for the backfill, where AU history does matter.
  return hourPoint(new Date(instant), intensity);
}

// Every instant the payload covers, for a backfill. Same endpoint as the live
// path — the work is aligning each fuel's own track, since rooftop solar and
// coal are published on different steps and start at different times.
export function parseOpennemAll(payload) {
  const tracks = opennemTracks(payload);
  if (tracks.length === 0) throw noData(new Error("OpenNEM series contained no values"));
  // The coarsest step, so every track really has a value at each grid instant
  // rather than one being interpolated into existence.
  const step = Math.max(...tracks.map((t) => t.step));
  const from = Math.max(...tracks.map((t) => t.start));
  const to = Math.min(...tracks.map((t) => t.start + (t.data.length - 1) * t.step));
  const points = [];
  for (let ms = from; ms <= to; ms += step) {
    const mix = {};
    for (const t of tracks) {
      const i = Math.round((ms - t.start) / t.step);
      const v = i >= 0 && i < t.data.length ? t.data[i] : null;
      if (v == null) continue;
      mix[t.fuel] = (mix[t.fuel] || 0) + Number(v);
    }
    const direct = mixToDirectIntensity(mix);
    if (direct == null) continue;
    points.push({ start: iso(new Date(ms)), end: iso(new Date(ms + step)), direct });
  }
  if (points.length === 0) throw new Error("OpenNEM payload had no usable interval");
  return series(Math.round(step / MS_PER_SECOND), points);
}

// --- Singapore EMC ------------------------------------------------------------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function parseSg(payload) {
  const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
  const sections = obj.Sections;
  const find = (items, key, value, want) => {
    for (const it of items || []) if (it[key] === value) return it[want];
    throw new Error(`SG ticker missing ${key}=${value}`);
  };
  const energy = find(sections, "Name", "Energy", "SectionData");
  const generation = num(find(energy, "Label", "Demand", "Value")) + num(find(energy, "Label", "System Loss", "Value"));
  const share = find(sections, "Name", "Generator Type Share", "SectionData");
  const mix = {};
  for (const item of share) {
    const pct = num(item.Value) / PERCENT;
    const fuel = SG_FUEL_TO_FUEL[String(item.Label).trim().toLowerCase()] || "other";
    mix[fuel] = (mix[fuel] || 0) + pct * generation;
  }
  const intensity = mixToDirectIntensity(mix);
  if (intensity == null) throw new Error("SG ticker had no usable generation share");
  const [d, mon, y] = String(obj.Date).trim().split(/\s+/);
  const month = MONTHS[mon.slice(0, MONTH_ABBREV_LENGTH).toLowerCase()];
  const period = parseInt(num(obj.Period), 10);
  const instant = new Date(Date.UTC(+y, month, +d, 0, SG_PERIOD_MINUTES * (period - 1)) - SGT_OFFSET_MS);
  return hourPoint(instant, intensity);
}

// --- Eskom (South Africa) -----------------------------------------------------
export function parseEskomCsv(text) {
  const rows = text.split(/\r?\n/).map((l) => l.split(","));
  let latestMs = null;
  let latestCols = null;
  for (const row of rows) {
    if (!row || row.length < 2) continue;
    const head = (row[0] || "").trim();
    if (head === "" || head === "Date_Time_Hour_Beginning") continue;
    const cols = row.slice(1);
    if (cols.every((v) => v.trim() === "")) continue;
    const d = new Date(`${head.replace(" ", "T")}+02:00`); // SAST, no DST
    if (Number.isNaN(d.getTime())) continue;
    if (latestMs == null || d.getTime() > latestMs) {
      latestMs = d.getTime();
      latestCols = cols;
    }
  }
  if (latestMs == null) throw new Error("Eskom CSV had no usable rows");
  const mix = {};
  for (const [idx, fuel] of Object.entries(ESKOM_INDEX_TO_FUEL)) {
    const raw = (latestCols[+idx] || "").trim();
    if (!raw) continue;
    const v = parseFloat(raw);
    if (!Number.isNaN(v)) mix[fuel] = (mix[fuel] || 0) + v;
  }
  const intensity = mixToDirectIntensity(mix);
  if (intensity == null) throw new Error("Eskom row had no usable generation data");
  // Newest row only on the live path, though Station_Build_Up.csv carries the
  // whole month. Returning all of it every run would rewrite closed history
  // days, which is exactly the immutability the caching design depends on —
  // `all` is the bounded backfill path this note asked for.
  return hourPoint(new Date(latestMs), intensity);
}

// Every row of the same document, for a backfill. No new endpoint: this is the
// file the live path already fetches, read whole instead of read for its tail.
export function parseEskomCsvAll(text) {
  const points = [];
  for (const row of text.split(/\r?\n/).map((l) => l.split(","))) {
    if (!row || row.length < 2) continue;
    const head = (row[0] || "").trim();
    if (head === "" || head === "Date_Time_Hour_Beginning") continue;
    const cols = row.slice(1);
    if (cols.every((v) => v.trim() === "")) continue;
    const d = new Date(`${head.replace(" ", "T")}+02:00`); // SAST, no DST
    if (Number.isNaN(d.getTime())) continue;
    const mix = {};
    for (const [idx, fuel] of Object.entries(ESKOM_INDEX_TO_FUEL)) {
      const raw = (cols[+idx] || "").trim();
      if (!raw) continue;
      const v = parseFloat(raw);
      if (!Number.isNaN(v)) mix[fuel] = (mix[fuel] || 0) + v;
    }
    const intensity = mixToDirectIntensity(mix);
    if (intensity == null) continue;
    const [start, end] = hourWindow(d);
    points.push({ start, end, direct: intensity });
  }
  if (points.length === 0) throw new Error("Eskom CSV had no usable rows");
  points.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return series(SECONDS_PER_HOUR, points);
}

// --- IESO (Ontario) -----------------------------------------------------------

// The report stamps hours in Eastern Prevailing Time and carries no offset, so
// the mapping to UTC moves twice a year. Intl is the only thing in Node that
// knows when. Two passes: the offset has to be read at the instant being
// converted, and the first guess can land the wrong side of a DST switch.
function zoneOffsetMs(tz, at) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - at.getTime();
}

function easternToUtc(y, m, d, hour) {
  const naive = Date.UTC(y, m - 1, d, hour);
  const once = naive - zoneOffsetMs("America/Toronto", new Date(naive));
  return new Date(naive - zoneOffsetMs("America/Toronto", new Date(once)));
}

// Hour N is the hour *ending* N:00 local: hour 1 covers 00:00-01:00.
//
// ponytail: on the two DST days IESO publishes 23 or 25 hours and the repeated
// autumn hour is indistinguishable here, so one reading a year is stamped an
// hour out. Carrying the report's DST flag would fix it; not worth the parser.
export function parseIeso(xml) {
  const date = (xml.match(/<Date>([^<]+)</) || [])[1];
  if (!date) throw new Error("IESO document had no <Date>");
  const [y, m, d] = date.trim().split("-").map(Number);

  // The file covers the whole delivery day and is republished hourly, so the
  // tail is empty for hours that have not happened yet. Sum every hour, then
  // take the latest one that actually reported.
  const byHour = new Map();
  for (const gen of xml.match(/<Generator>[\s\S]*?<\/Generator>/g) || []) {
    const raw = (gen.match(/<FuelType>([^<]*)</) || [])[1] || "";
    const fuel = IESO_FUEL_TO_FUEL[raw.trim().toLowerCase()] || "other";
    const outputs = (gen.match(/<Outputs>[\s\S]*?<\/Outputs>/) || [])[0] || "";
    for (const o of outputs.match(/<Output>[\s\S]*?<\/Output>/g) || []) {
      const hour = parseInt((o.match(/<Hour>(\d+)</) || [])[1], 10);
      const mw = parseFloat((o.match(/<EnergyMW>([^<]+)</) || [])[1]);
      if (Number.isNaN(hour) || Number.isNaN(mw)) continue;
      if (!byHour.has(hour)) byHour.set(hour, {});
      const mix = byHour.get(hour);
      mix[fuel] = (mix[fuel] || 0) + mw;
    }
  }

  // Every reporting hour is a point, ascending. The document already held the
  // whole delivery day; only the newest hour used to survive.
  const out = [];
  for (const hour of [...byHour.keys()].sort((a, b) => a - b)) {
    const intensity = mixToDirectIntensity(byHour.get(hour));
    if (intensity == null) continue; // an hour present but with no output yet
    const end = easternToUtc(y, m, d, hour);
    out.push({
      start: iso(new Date(end.getTime() - MS_PER_HOUR)),
      end: iso(end),
      direct: intensity,
    });
  }
  if (out.length === 0) throw new Error("IESO report had no hour with usable generation");
  return series(SECONDS_PER_HOUR, out);
}

// --- fetch wrappers -----------------------------------------------------------
// The live path wants a short timeout: a run every 20 minutes must not hang on
// one slow provider. A backfill asks for a week at a time and needs longer, so
// bin/backfill-history.js raises it — the one caller allowed to, which is why
// this is a setter rather than an argument threaded through every fetcher.
let TIMEOUT_MS = 15000;

export function setFetchTimeout(ms) {
  TIMEOUT_MS = ms;
}

// Two providers carry their credential in the query string — ENTSO-E's
// securityToken, EIA's api_key — and the failure below is reported, so the URL
// reaches a run log. Blank anything that looks like a secret: Actions masks
// registered secrets, but a local run has nothing doing that.
export function safeUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/token|key|secret|password/i.test(k)) u.searchParams.set(k, "***");
    }
    return u.toString();
  } catch {
    return String(url).split("?")[0];
  }
}

// AbortSignal.timeout guards against a provider hanging the whole run.
async function get(url, kind = "json") {
  const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) {
    // The body is where providers say WHY. ENTSO-E returns an acknowledgement
    // with a reason code on plenty of its errors, and discarding it left a wall
    // of bare "HTTP 503" with nothing to act on. Truncated and flattened: this
    // goes in a log line, and an HTML error page would otherwise fill the screen.
    let why = "";
    let page = false;
    try {
      const body = (await resp.text()).replace(/\s+/g, " ").trim();
      // An HTML body is a page, not a payload: a maintenance notice or an edge
      // error. Summarised by its title rather than dumped, because 300
      // characters of a stylesheet tells a reader nothing and buries the other
      // failures in the run.
      page = /^\s*<(?:!doctype|html)/i.test(body);
      const title = (body.match(/<title>([^<]*)</i) || [])[1];
      if (page) why = ` — HTML page${title ? ` "${title.trim()}"` : ""}, not data: provider maintenance?`;
      else if (body) why = ` — ${body.slice(0, ERROR_BODY_CHARS)}${body.length > ERROR_BODY_CHARS ? "…" : ""}`;
    } catch {
      /* a body that cannot be read is not worth failing over */
    }
    const err = new Error(`HTTP ${resp.status} for ${safeUrl(url)}${why}`);
    // 5xx and 429 are the provider struggling or shedding load, so worth trying
    // again; a 4xx is the request itself and will not improve. A maintenance
    // page is neither — the platform is deliberately serving a page, and it will
    // serve the same one eight seconds later. parseEntsoe already refused to
    // retry that page when it arrived with a 200; this applies the same rule
    // when it arrives with a 503.
    err.retryable = !page && (resp.status >= HTTP_SERVER_ERROR || resp.status === HTTP_TOO_MANY_REQUESTS);
    throw err;
  }
  return kind === "text" ? resp.text() : resp.json();
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// How far back to ask ENTSO-E for. A75 is published per control area as each
// TSO submits, so the platform runs anywhere from one to four hours behind
// real time, and the whole platform occasionally stops publishing for hours.
// The window has to cover that lag with room to spare, because ENTSO-E answers
// a window it has no data for with HTTP 400 "No matching data found" — not an
// empty document — so a window that falls entirely inside the lag is
// indistinguishable from the provider being gone: the country drops out of the
// snapshot, /past-hour is deleted, and /current-hour freezes at whatever it
// last held. That is exactly how DE, AT, IT, NL and PL lost /past-hour on
// 2026-08-29 while the runs stayed green. Twelve hours is well past the worst
// lag observed and still a small document at PT15M.
export const ENTSOE_WINDOW_HOURS = 12;

// `window` is {start, end} as Dates, for backfilling a past range; omitted, the
// pipeline's own trailing window is used. A75 accepts up to a year per request,
// so a backfill is a handful of calls per series rather than one per day.
export async function fetchEntsoe(code, token, zone = null, window = null) {
  const domain = zone ? ZONES[code]?.[zone] : ENTSOE_DOMAIN[code];
  if (!domain) throw new Error(`no ENTSO-E domain for ${code}${zone ? `/${zone}` : ""}`);
  const end = window ? window.end : new Date();
  const start = window ? window.start : new Date(end.getTime() - ENTSOE_WINDOW_HOURS * MS_PER_HOUR);
  const fmt = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}00`;
  const url = new URL("https://web-api.tp.entsoe.eu/api");
  url.search = new URLSearchParams({
    documentType: "A75",
    processType: "A16",
    in_Domain: domain,
    periodStart: fmt(start),
    periodEnd: fmt(end),
    securityToken: token,
  }).toString();
  return parseEntsoe(await get(url, "text"));
}

// --- Elexon BMRS (GB) ---------------------------------------------------------
// { data: [{ startTime, fuelType, generation }, ...] }, one row per fuel per
// instant, published every five minutes.
export function parseElexon(payload) {
  const rows = payload?.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw noData(new Error("Elexon payload had no data rows"));
  }
  const byInstant = new Map();
  for (const r of rows) {
    // Unmapped is dropped, not folded into `other`: the unmapped rows are the
    // interconnectors, and an import is not GB generation.
    const fuel = ELEXON_FUEL_TO_FUEL[String(r?.fuelType || "").toUpperCase()];
    if (!fuel) continue;
    const ms = Date.parse(r.startTime);
    const mw = Number(r.generation);
    if (!Number.isFinite(ms) || !Number.isFinite(mw) || mw <= 0) continue;
    if (!byInstant.has(ms)) byInstant.set(ms, {});
    const mix = byInstant.get(ms);
    mix[fuel] = (mix[fuel] || 0) + mw;
  }
  const instants = [...byInstant.keys()].sort((a, b) => a - b);
  if (instants.length === 0) {
    throw notRetryable(new Error("Elexon payload had no recognised generation rows"));
  }
  // FUELINST publishes every five minutes; read the cadence off the data rather
  // than assuming it, so a change of publication rate does not silently mark
  // every hour incomplete.
  const stepSec =
    instants.length > 1
      ? Math.max(SECONDS_PER_MINUTE, Math.round((instants[1] - instants[0]) / MS_PER_SECOND))
      : ELEXON_FALLBACK_STEP_SEC;
  const out = [];
  for (const ms of instants) {
    const direct = mixToDirectIntensity(byInstant.get(ms));
    if (direct == null) continue;
    out.push({ start: iso(new Date(ms)), end: iso(new Date(ms + stepSec * MS_PER_SECOND)), direct });
  }
  if (out.length === 0) throw noData(new Error("Elexon document contained no usable generation data"));
  return series(stepSec, out);
}

export async function fetchElexon(window = null) {
  const now = window ? window.end : new Date();
  const from = window ? window.start : new Date(now.getTime() - ELEXON_LOOKBACK_HOURS * MS_PER_HOUR);
  const url = new URL("https://data.elexon.co.uk/bmrs/api/v1/datasets/FUELINST");
  url.search = new URLSearchParams({
    format: "json",
    publishDateTimeFrom: iso(from),
    publishDateTimeTo: iso(now),
  }).toString();
  return parseElexon(await get(url));
}

// --- Energy-Charts (Fraunhofer ISE) -------------------------------------------
// { unix_seconds: [...], production_types: [{ name, data: [...] }, ...] }, with
// one value per timestamp per series. The response also carries series that are
// not generation — load, residual load, cross-border trading, renewable share —
// which energyChartsFuel() drops rather than folding into `other`.
export function parseEnergyCharts(payload) {
  const seconds = payload?.unix_seconds;
  const types = payload?.production_types;
  if (!Array.isArray(seconds) || !Array.isArray(types) || seconds.length === 0) {
    throw notRetryable(new Error("Energy-Charts payload had no unix_seconds/production_types"));
  }
  // The feed states its cadence only by the spacing of its own timestamps.
  const stepSec = seconds.length > 1 ? Math.max(1, seconds[1] - seconds[0]) : SECONDS_PER_HOUR;
  const mixes = seconds.map(() => ({}));
  let recognised = 0;
  for (const t of types) {
    const fuel = energyChartsFuel(t?.name);
    if (!fuel) continue;
    recognised += 1;
    const data = Array.isArray(t.data) ? t.data : [];
    for (let i = 0; i < seconds.length && i < data.length; i += 1) {
      const v = Number(data[i]);
      if (data[i] == null || !Number.isFinite(v) || v <= 0) continue;
      mixes[i][fuel] = (mixes[i][fuel] || 0) + v;
    }
  }
  // Nothing matched means the labelling changed under us, not that the grid
  // stopped generating. Refusing loudly beats publishing a mix built from
  // whatever happened to be recognisable.
  if (recognised === 0) {
    throw notRetryable(new Error("Energy-Charts payload had no recognised generation series"));
  }
  const out = [];
  for (let i = 0; i < seconds.length; i += 1) {
    const direct = mixToDirectIntensity(mixes[i]);
    if (direct == null) continue; // an instant present but with nothing usable
    out.push({
      start: iso(new Date(seconds[i] * MS_PER_SECOND)),
      end: iso(new Date((seconds[i] + stepSec) * MS_PER_SECOND)),
      direct,
    });
  }
  if (out.length === 0) throw noData(new Error("Energy-Charts document contained no usable generation data"));
  return series(stepSec, out);
}

export async function fetchEnergyCharts(code, window = null) {
  // Dates, not timestamps. A full ISO8601 `start` is answered with 404 "no
  // content available", which looks exactly like a country this feed does not
  // carry — so the window is expressed as two calendar days and trimmed by the
  // hourly means afterwards. Yesterday to today is 30-48h depending on where
  // the feed puts a local midnight; more than the twelve hours wanted, and
  // small enough not to care.
  const day = (d) => d.toISOString().slice(0, ISO_DATE_LENGTH);
  const now = new Date();
  const url = new URL("https://api.energy-charts.info/public_power");
  url.search = new URLSearchParams({
    country: code.toLowerCase(),
    start: day(window ? window.start : new Date(now.getTime() - ENERGY_CHARTS_LOOKBACK_HOURS * MS_PER_HOUR)),
    end: day(window ? window.end : now),
  }).toString();
  return parseEnergyCharts(await get(url));
}

export async function fetchEia(token, respondent = "US48", window = null) {
  const url = new URL("https://api.eia.gov/v2/electricity/rto/fuel-type-data/data/");
  const params = {
    api_key: token,
    frequency: "hourly",
    "data[0]": "value",
    "facets[respondent][]": respondent,
    "sort[0][column]": "period",
    "sort[0][direction]": "desc",
    // Measured: 200 rows is about 13 hours, since EIA gives each fuel type its
    // own row. The ceiling is ~330 hours, so a backfill chunk of a week fits
    // with room; a chunk that came back short of `days * 24` minus the feed's
    // lag would be hitting it.
    length: window ? "5000" : "200",
  };
  if (window) {
    // Hour granularity, which is what `frequency: hourly` indexes on.
    const hour = (d) => d.toISOString().slice(0, ISO_HOUR_LENGTH);
    params.start = hour(window.start);
    params.end = hour(window.end);
  }
  url.search = new URLSearchParams(params).toString();
  return parseEia(await get(url));
}

export async function fetchUk() {
  // Two calls: the current period (what v1 reports) and the settlement day
  // behind it (what makes an hour completable). The day feed is best-effort —
  // if it fails GB degrades to one point per hour, which is what it had before,
  // rather than losing the reading altogether.
  const [now, day] = await Promise.all([
    get("https://api.carbonintensity.org.uk/intensity"),
    get("https://api.carbonintensity.org.uk/intensity/date").catch(() => null),
  ]);
  return parseUk(now, day);
}

export async function fetchOns() {
  // ONS moved this feed: integra.ons.org.br/api/energiaagora/Get/ now 302s to
  // tr.ons.org.br, where the old path is gone — BR had been falling back to its
  // annual figure since. The document itself is unchanged, same regions and the
  // same `geracao` keys, so only the address moved.
  return parseOns(await get("https://tr.ons.org.br/Content/GetBalancoEnergetico/null"));
}

export async function fetchOpennem(region = "NEM") {
  return parseOpennem(await get(`https://data.openelectricity.org.au/v4/stats/au/${region}/power/7d.json`));
}

export async function fetchSg() {
  // EMC's TLS chain is misconfigured and verification is not disabled here, so
  // this can fail and fall back to the annual snapshot.
  return parseSg(await get("https://www.emcsg.com/ChartServer/blue/ticker"));
}

export async function fetchIeso() {
  // GenOutputCapability, not GenOutputbyFuelHourly: the latter is the tidier
  // shape but is republished once a day and a day behind, which is no use to an
  // hourly pipeline. This one is 70 KB, current-day, and updated every hour.
  return parseIeso(
    await get("https://reports-public.ieso.ca/public/GenOutputCapability/PUB_GenOutputCapability.xml", "text"),
  );
}

// The same documents the live path fetches, read whole. No new endpoint, so the
// only risk is in the parsing — which the backfill reports loudly, unlike a
// fallback fetcher that fails into silence.
export async function fetchEskomAll() {
  const now = new Date();
  const url =
    "https://www.eskom.co.za/dataportal/wp-content/uploads/" +
    `${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}/Station_Build_Up.csv`;
  return parseEskomCsvAll(await get(url, "text"));
}

export async function fetchOpennemAll(region = "NEM") {
  return parseOpennemAll(await get(`https://data.openelectricity.org.au/v4/stats/au/${region}/power/7d.json`));
}

export async function fetchEskom() {
  const now = new Date();
  const url =
    "https://www.eskom.co.za/dataportal/wp-content/uploads/" +
    `${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}/Station_Build_Up.csv`;
  return parseEskomCsv(await get(url, "text"));
}

// --- orchestration ------------------------------------------------------------
export function providerFor(code) {
  return PROVIDERS[code] || (ENTSOE_DOMAIN[code] ? "ENTSO-E" : null);
}

// The full chain for a country: primary first, then its fallbacks. A zone is
// served only by a provider that publishes below national level, so a zone
// chain is filtered to those — a fallback that only has national figures must
// not be asked for a bidding zone and quietly answer with the country's.
export function providersFor(code, zone = null) {
  const primary = providerFor(code);
  if (!primary) return [];
  // A fallback is reachable only while it is declared independent of the
  // primary. Enforced here rather than left to whoever edits FALLBACK_PROVIDERS,
  // because a feed that re-publishes the primary is not a fallback at all: it
  // goes down with it, and configuring one buys nothing but the appearance of
  // cover. Removing a `FALLBACK_COVERAGE` entry is enough to retire a feed.
  const chain = [
    primary,
    ...(FALLBACK_PROVIDERS[code] || []).filter((p) => FALLBACK_COVERAGE[`${code}:${p}`] === "independent"),
  ];
  if (!zone) return chain;
  return chain.filter((p) => ZONE_CAPABLE.has(p));
}

// Providers that can answer for a sub-country zone. IESO is Ontario-only and so
// is reached exclusively through a zone; the rest publish one national figure.
const ZONE_CAPABLE = new Set(["ENTSO-E", "EIA", "OpenNEM", "IESO"]);

// `zone` selects a sub-country area; null asks for the country as a whole. Only
// the three zone-capable providers read it — the rest publish one national
// figure and are never reached with a zone (zonesFor gates that).
// Exported for bin/verify-providers.js, which calls every feed in a chain rather
// than stopping at the first that works — the only way to find out whether a
// configured fallback is real.
export function defaultFetchers(code, env, zone = null) {
  const ref = zone ? ZONES[code]?.[zone] : null;
  const out = {
    NESO: fetchUk,
    ONS: fetchOns,
    OpenNEM: () => fetchOpennem(ref || "NEM"),
    EMC: fetchSg,
    Eskom: fetchEskom,
  };
  // Ontario only, so it is registered just for the zone request: asked for CA
  // as a country there is no fetcher, measuredLastHour returns null, and the
  // annual snapshot stands (see ZONES.CA).
  if (zone) out.IESO = fetchIeso;
  const eia = env.EIA_TOKEN || env.EIA_API_KEY;
  if (eia) out.EIA = () => fetchEia(eia, ref || "US48");
  const ent = env.ENTSOE_TOKEN || env.ENTSOE_API_KEY;
  if (ent) out["ENTSO-E"] = () => fetchEntsoe(code, ent, zone);
  // National figures only, and no token. Registered for the country request
  // alone — providersFor() already filters it out of a zone chain, and this is
  // the second guard on the same rule: a fallback with only national data must
  // never answer a bidding-zone request with the country's mix.
  if (!zone) out["Energy-Charts"] = () => fetchEnergyCharts(code);
  if (!zone) out.Elexon = fetchElexon;
  return out;
}

// Feeds that can be asked for an arbitrary past range, for bin/backfill-history.js.
// Everything else publishes a snapshot of now and cannot be backfilled from —
// its history only ever accumulates one run at a time.
export function rangedFetcher(provider, code, env, zone = null) {
  const ref = zone ? ZONES[code]?.[zone] : null;
  if (provider === "ENTSO-E") {
    const token = env.ENTSOE_TOKEN || env.ENTSOE_API_KEY;
    return token ? (window) => fetchEntsoe(code, token, zone, window) : null;
  }
  if (provider === "EIA") {
    const token = env.EIA_TOKEN || env.EIA_API_KEY;
    return token ? (window) => fetchEia(token, ref || "US48", window) : null;
  }
  if (provider === "Elexon" && !zone) return (window) => fetchElexon(window);
  // National figures only, so never for a zone.
  if (provider === "Energy-Charts" && !zone) return (window) => fetchEnergyCharts(code, window);
  // These two ignore the window: their documents carry a fixed span — a month
  // of hourly rows for Eskom, seven days at five minutes for OpenNEM — and the
  // caller keeps whatever days fall in range. Bounded by the feed, not by the
  // request, and the run reports how many hours actually came back.
  // `windowed: false` says the window is ignored, so a caller walking several
  // windows should fetch once rather than pull the same document each time.
  if (provider === "Eskom" && !zone) return Object.assign(() => fetchEskomAll(), { windowed: false });
  if (provider === "OpenNEM") {
    return Object.assign(() => fetchOpennemAll(ref || "NEM"), { windowed: false });
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run `fn`, retrying what is worth retrying. Exponential and jittered: the
// pipeline fires every US balancing authority at EIA at once, so a deterministic
// backoff would have them all rate-limited together and then retry together, in
// step. A failure marked `retryable: false` — a 4xx, an ENTSO-E acknowledgement,
// a maintenance page, an empty payload — is not retried at all: the provider
// answered, and it will answer the same way a second later. The subset also
// marked `empty` says the answer was "nothing to publish", which is what lets
// the backfill tell a series that is waiting on an outage from one that is not.
//
// Shared so the live path and the backfill cannot disagree about which failures
// are worth a second look.
export async function retrying(fn, { attempts = 3, backoffMs = 1000 } = {}) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (e.retryable === false) break;
      if (i < attempts - 1) await sleep(backoffMs * BACKOFF_BASE ** i * (JITTER_MIN + Math.random()));
    }
  }
  throw last;
}

// Return a provider series { resolution_sec, points, source } or null.
// `newestReading()` collapses it to the v1 { direct, hour_start, hour_end,
// source } shape for callers that want a single reading.
//
// Retries a failing provider `attempts` times with exponential backoff. A
// country falling back to its annual figure loses accuracy; a zone has nothing
// to fall back to and disappears from the API for the hour, so it is worth a
// few seconds to ride out a dropped connection.
export async function measuredLastHour(
  code,
  { fetchers = null, env = {}, zone = null, attempts = 3, backoffMs = 1000, onFailure = null } = {},
) {
  const chain = providersFor(code, zone);
  if (chain.length === 0) return null;
  if (zone && !ZONES[code]?.[zone]) return null;
  const table = fetchers || defaultFetchers(code, env, zone);

  // Each feed in turn, primary first. A fallback is only reached when the one
  // before it produced nothing at all, so a country stays on one source while
  // that source is working and its figures do not step between two providers'
  // idea of the same grid every run.
  for (const provider of chain) {
    // Not reported: a provider with no fetcher registered is a configuration
    // state, not an outage, and it is not always even a fault — IESO answers
    // for CA/ON and deliberately not for CA. bin/pipeline.js checks the token
    // variables by name instead, which cannot confuse the two.
    const fetch_ = table[provider];
    if (!fetch_) continue;
    let last = null;
    try {
      const s = await retrying(
        async () => {
          const r = await fetch_();
          if (!r?.points?.length) throw new Error("empty series");
          return r;
        },
        { attempts, backoffMs },
      );
      return { ...s, source: provider };
    } catch (e) {
      last = e;
    }
    // Reported even when a fallback goes on to succeed: a primary that has
    // stopped answering is worth knowing about while the fallback is carrying
    // the country, not only once both are gone. Reported rather than swallowed
    // at all because a provider going dark used to leave a green run, an
    // unchanged commit and no line anywhere saying why 30 countries stopped
    // being measured.
    if (onFailure) onFailure({ code, zone, provider, error: last ? last.message : "unknown" });
  }
  return null; // every feed failed -> annual fallback, or no zone reading
}
