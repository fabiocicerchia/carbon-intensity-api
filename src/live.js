// Real-time providers. Each is split into a pure parse* function (unit-tested,
// no network) and a thin fetch* wrapper (global fetch).
// measuredLastHour selects a provider per country and returns a
// normalized reading, or null so the caller falls back to the annual snapshot.

import {
  EIA_FUEL_TO_FUEL,
  ENTSOE_PSR_TO_FUEL,
  ESKOM_INDEX_TO_FUEL,
  IESO_FUEL_TO_FUEL,
  ONS_FUEL_TO_FUEL,
  OPENNEM_FUEL_TO_FUEL,
  SG_FUEL_TO_FUEL,
  mixToDirectIntensity,
} from "./factors.js";

// --- country -> ENTSO-E domain EIC code ---------------------------------------
export const ENTSOE_DOMAIN = {
  AT: "10YAT-APG------L", BE: "10YBE----------2", BG: "10YCA-BULGARIA-R",
  BY: "10Y1001A1001A51S", CH: "10YCH-SWISSGRIDZ", CZ: "10YCZ-CEPS-----N",
  DE: "10Y1001A1001A83F", DK: "10Y1001A1001A65H", EE: "10Y1001A1001A39I",
  ES: "10YES-REE------0", FI: "10YFI-1--------U", FR: "10YFR-RTE------C",
  GR: "10YGR-HTSO-----Y", HR: "10YHR-HEP------M", HU: "10YHU-MAVIR----U",
  IE: "10Y1001A1001A59C", IT: "10YIT-GRTN-----B", LT: "10YLT-1001A0008Q",
  LU: "10YLU-CEGEDEL-NQ", LV: "10YLV-1001A00074", MK: "10YMK-MEPSO----8",
  NL: "10YNL----------L", NO: "10YNO-0--------C", PL: "10YPL-AREA-----S",
  PT: "10YPT-REN------W", RO: "10YRO-TEL------P", RS: "10YCS-SERBIATSOV",
  SE: "10YSE-1--------K", SI: "10YSI-ELES-----O", SK: "10YSK-SEPS-----K",
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
    NORD: "10Y1001A1001A73I", CNOR: "10Y1001A1001A70O", CSUD: "10Y1001A1001A71M",
    SUD: "10Y1001A1001A788", CALA: "10Y1001C--00096J", SICI: "10Y1001A1001A75E",
    SARD: "10Y1001A1001A74G",
  },
  SE: {
    SE1: "10Y1001A1001A44P", SE2: "10Y1001A1001A45N",
    SE3: "10Y1001A1001A46L", SE4: "10Y1001A1001A47J",
  },
  NO: {
    NO1: "10YNO-1--------2", NO2: "10YNO-2--------T", NO3: "10YNO-3--------J",
    NO4: "10YNO-4--------9", NO5: "10Y1001A1001A48H",
  },
  DK: { DK1: "10YDK-1--------W", DK2: "10YDK-2--------M" },
  // EIA-930, passed through as the `respondent` facet. Both grains are offered:
  // the thirteen regions, and the balancing authorities inside them — CAISO and
  // ERCOT are different grids that a regional average blurs together. The long
  // tail of very small BAs is omitted; many do not report a fuel-type breakdown,
  // and a respondent that returns nothing just costs a request.
  US: {
    CAL: "CAL", CAR: "CAR", CENT: "CENT", FLA: "FLA", MIDA: "MIDA", MIDW: "MIDW",
    NE: "NE", NW: "NW", NY: "NY", SE: "SE", SW: "SW", TEN: "TEN", TEX: "TEX",
    AECI: "AECI", AVA: "AVA", AZPS: "AZPS", BANC: "BANC", BPAT: "BPAT",
    CISO: "CISO", CPLE: "CPLE", DUK: "DUK", EPE: "EPE", ERCO: "ERCO",
    FPC: "FPC", FPL: "FPL", IID: "IID", IPCO: "IPCO", ISNE: "ISNE", JEA: "JEA",
    LDWP: "LDWP", LGEE: "LGEE", MISO: "MISO", NEVP: "NEVP", NWMT: "NWMT",
    NYIS: "NYIS", PACE: "PACE", PACW: "PACW", PGE: "PGE", PJM: "PJM",
    PNM: "PNM", PSCO: "PSCO", PSEI: "PSEI", SC: "SC", SCEG: "SCEG", SCL: "SCL",
    SOCO: "SOCO", SRP: "SRP", SWPP: "SWPP", TEC: "TEC", TEPC: "TEPC",
    TIDC: "TIDC", TPWR: "TPWR", TVA: "TVA", WACM: "WACM", WALC: "WALC",
  },
  // OpenNEM. The five NEM regions plus WEM, which is a physically separate
  // network (the South West Interconnected System around Perth) and so has its
  // own path rather than sitting under NEM.
  AU: {
    NSW1: "NEM/NSW1", QLD1: "NEM/QLD1", SA1: "NEM/SA1",
    TAS1: "NEM/TAS1", VIC1: "NEM/VIC1", WEM: "WEM",
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

// --- helpers -----------------------------------------------------------------
function iso(dt) {
  return dt.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseDt(text) {
  let t = String(text).trim();
  if (t.length === 13 && t[10] === "T") t += ":00:00"; // EIA hour-only form
  t = t.replace(" ", "T");
  if (!/[zZ]$/.test(t) && !/[+-]\d\d:?\d\d$/.test(t)) t += "Z"; // naive -> UTC
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new Error(`bad datetime ${text}`);
  return d;
}

function hourWindow(instant) {
  const start = new Date(Date.UTC(
    instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate(), instant.getUTCHours(),
  ));
  return [iso(start), iso(new Date(start.getTime() + 3600 * 1000))];
}

function num(text) {
  const m = String(text).match(/-?\d[\d,]*\.?\d*/);
  if (!m) throw new Error(`no number in ${text}`);
  return parseFloat(m[0].replace(/,/g, ""));
}

function intervalMinutes(text) {
  const t = String(text || "").trim().toLowerCase();
  if (t.endsWith("m")) return parseInt(t.slice(0, -1), 10);
  if (t.endsWith("h")) return parseInt(t.slice(0, -1), 10) * 60;
  return 5;
}

// --- ENTSO-E (dependency-free XML extraction of A75) --------------------------
export function parseEntsoe(xml) {
  const blocks = xml.match(/<TimeSeries\b[\s\S]*?<\/TimeSeries>/g) || [];
  let latestEnd = null;
  let resolutionMinutes = 60;
  const mix = {};
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
      const step = intervalMinutes(
        resM ? resM[1].trim().replace(/^PT/i, "") : "60m",
      );
      let last = null;
      for (const p of points) {
        const pos = parseInt((p.match(/<position>(\d+)/) || [])[1], 10);
        const qty = parseFloat((p.match(/<quantity>([^<]+)/) || [])[1]);
        if (!Number.isNaN(pos) && !Number.isNaN(qty) && (!last || pos > last.pos)) {
          last = { pos, qty };
        }
      }
      if (!last) continue;
      const start = parseDt(startM[1]);
      const pointStart = new Date(start.getTime() + step * (last.pos - 1) * 60000);
      const pointEnd = new Date(pointStart.getTime() + step * 60000);
      mix[fuel] = (mix[fuel] || 0) + last.qty;
      resolutionMinutes = step;
      if (!latestEnd || pointEnd > latestEnd) latestEnd = pointEnd;
    }
  }
  const intensity = mixToDirectIntensity(mix);
  if (intensity == null || !latestEnd) {
    throw new Error("ENTSO-E document contained no usable generation data");
  }
  const hourStart = new Date(latestEnd.getTime() - resolutionMinutes * 60000);
  return [iso(hourStart), iso(latestEnd), intensity];
}

// --- EIA ----------------------------------------------------------------------
export function parseEia(payload) {
  const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
  const rows = obj?.response?.data || [];
  if (rows.length === 0) throw new Error("EIA response contained no data rows");
  const latestPeriod = rows.reduce((a, r) => (r.period > a ? r.period : a), rows[0].period);
  const mix = {};
  for (const r of rows) {
    if (r.period !== latestPeriod) continue;
    const fuel = EIA_FUEL_TO_FUEL[r.fueltype] || "other";
    const val = parseFloat(r.value);
    if (Number.isNaN(val)) continue;
    mix[fuel] = (mix[fuel] || 0) + val;
  }
  const intensity = mixToDirectIntensity(mix);
  if (intensity == null) throw new Error("EIA period had no usable generation data");
  const start = parseDt(latestPeriod);
  return [iso(start), iso(new Date(start.getTime() + 3600 * 1000)), intensity];
}

// --- UK NESO ------------------------------------------------------------------
export function parseUk(payload) {
  const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
  const rows = obj?.data || [];
  if (rows.length === 0) throw new Error("NESO response contained no data");
  const row = rows[rows.length - 1];
  const value = row.intensity?.actual ?? row.intensity?.forecast;
  if (value == null) throw new Error("NESO period had no intensity");
  return [iso(parseDt(row.from)), iso(parseDt(row.to)), Number(value)];
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
  const [hs, he] = hourWindow(parseDt(obj.Data));
  return [hs, he, intensity];
}

// --- OpenNEM / OpenElectricity ------------------------------------------------
export function parseOpennem(payload) {
  const obj = typeof payload === "string" ? JSON.parse(payload) : payload;
  const series = (obj.data || []).filter(
    (s) => s.type === "power" && s.fuel_tech && OPENNEM_FUEL_TO_FUEL[String(s.fuel_tech).toLowerCase()],
  );
  if (series.length === 0) throw new Error("OpenNEM response had no production series");
  // The series do not share a start time or a length — rooftop solar in
  // particular runs on its own clock — so they must be aligned on timestamps.
  // Indexing every series with one shared position reads a different instant
  // from each, and where the offset exceeds the shorter arrays it reads only
  // the longest series, yielding a mix of one fuel (or none).
  const tracks = series.map((s) => ({
    fuel: OPENNEM_FUEL_TO_FUEL[String(s.fuel_tech).toLowerCase()],
    start: parseDt(s.history.start).getTime(),
    step: intervalMinutes(s.history.interval || "5m") * 60000,
    data: s.history.data,
  }));
  // Latest instant every track has a value for. Taking the newest instant of
  // any single track instead would land on one a slower feed has not reached.
  const ends = tracks.map((t) => {
    let i = t.data.length - 1;
    while (i >= 0 && t.data[i] == null) i -= 1;
    return i >= 0 ? t.start + i * t.step : null;
  }).filter((t) => t != null);
  if (ends.length === 0) throw new Error("OpenNEM series contained no values");
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
  const [hs, he] = hourWindow(new Date(instant));
  return [hs, he, intensity];
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
    const pct = num(item.Value) / 100;
    const fuel = SG_FUEL_TO_FUEL[String(item.Label).trim().toLowerCase()] || "other";
    mix[fuel] = (mix[fuel] || 0) + pct * generation;
  }
  const intensity = mixToDirectIntensity(mix);
  if (intensity == null) throw new Error("SG ticker had no usable generation share");
  const [d, mon, y] = String(obj.Date).trim().split(/\s+/);
  const month = MONTHS[mon.slice(0, 3).toLowerCase()];
  const period = parseInt(num(obj.Period), 10);
  const instant = new Date(Date.UTC(+y, month, +d, 0, 30 * (period - 1)) - 8 * 3600 * 1000); // SGT +08:00
  const [hs, he] = hourWindow(instant);
  return [hs, he, intensity];
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
    if (latestMs == null || d.getTime() > latestMs) { latestMs = d.getTime(); latestCols = cols; }
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
  const [hs, he] = hourWindow(new Date(latestMs));
  return [hs, he, intensity];
}

// --- IESO (Ontario) -----------------------------------------------------------

// The report stamps hours in Eastern Prevailing Time and carries no offset, so
// the mapping to UTC moves twice a year. Intl is the only thing in Node that
// knows when. Two passes: the offset has to be read at the instant being
// converted, and the first guess can land the wrong side of a DST switch.
function zoneOffsetMs(tz, at) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).map((x) => [x.type, x.value]),
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

  for (const hour of [...byHour.keys()].sort((a, b) => b - a)) {
    const intensity = mixToDirectIntensity(byHour.get(hour));
    if (intensity == null) continue; // an hour present but with no output yet
    const end = easternToUtc(y, m, d, hour);
    return [iso(new Date(end.getTime() - 3600 * 1000)), iso(end), intensity];
  }
  throw new Error("IESO report had no hour with usable generation");
}

// --- fetch wrappers -----------------------------------------------------------
const TIMEOUT_MS = 15000;

// AbortSignal.timeout guards against a provider hanging the whole run.
async function get(url, kind = "json") {
  const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  return kind === "text" ? resp.text() : resp.json();
}

function pad(n) { return String(n).padStart(2, "0"); }

export async function fetchEntsoe(code, token, zone = null) {
  const domain = zone ? ZONES[code]?.[zone] : ENTSOE_DOMAIN[code];
  if (!domain) throw new Error(`no ENTSO-E domain for ${code}${zone ? `/${zone}` : ""}`);
  const end = new Date();
  const start = new Date(end.getTime() - 3 * 3600 * 1000);
  const fmt = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}00`;
  const url = new URL("https://web-api.tp.entsoe.eu/api");
  url.search = new URLSearchParams({
    documentType: "A75", processType: "A16", in_Domain: domain,
    periodStart: fmt(start), periodEnd: fmt(end), securityToken: token,
  }).toString();
  return parseEntsoe(await get(url, "text"));
}

export async function fetchEia(token, respondent = "US48") {
  const url = new URL("https://api.eia.gov/v2/electricity/rto/fuel-type-data/data/");
  url.search = new URLSearchParams({
    api_key: token, frequency: "hourly", "data[0]": "value",
    "facets[respondent][]": respondent, "sort[0][column]": "period",
    "sort[0][direction]": "desc", length: "200",
  }).toString();
  return parseEia(await get(url));
}

export async function fetchUk() {
  return parseUk(await get("https://api.carbonintensity.org.uk/intensity"));
}

export async function fetchOns() {
  return parseOns(await get("https://integra.ons.org.br/api/energiaagora/Get/"));
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
  return parseIeso(await get(
    "https://reports-public.ieso.ca/public/GenOutputCapability/PUB_GenOutputCapability.xml",
    "text",
  ));
}

export async function fetchEskom() {
  const now = new Date();
  const url = "https://www.eskom.co.za/dataportal/wp-content/uploads/"
    + `${now.getUTCFullYear()}/${pad(now.getUTCMonth() + 1)}/Station_Build_Up.csv`;
  return parseEskomCsv(await get(url, "text"));
}

// --- orchestration ------------------------------------------------------------
export function providerFor(code) {
  return PROVIDERS[code] || (ENTSOE_DOMAIN[code] ? "ENTSO-E" : null);
}

// `zone` selects a sub-country area; null asks for the country as a whole. Only
// the three zone-capable providers read it — the rest publish one national
// figure and are never reached with a zone (zonesFor gates that).
function defaultFetchers(code, env, zone = null) {
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
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Return a measured reading { direct, hour_start, hour_end, source } or null.
//
// Retries a failing provider `attempts` times with exponential backoff. A
// country falling back to its annual figure loses accuracy; a zone has nothing
// to fall back to and disappears from the API for the hour, so it is worth a
// few seconds to ride out a dropped connection.
export async function measuredLastHour(
  code,
  { fetchers = null, env = {}, zone = null, attempts = 3, backoffMs = 1000 } = {},
) {
  const provider = providerFor(code);
  if (!provider) return null;
  if (zone && !ZONES[code]?.[zone]) return null;
  const fetch_ = (fetchers || defaultFetchers(code, env, zone))[provider];
  if (!fetch_) return null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const [hour_start, hour_end, direct] = await fetch_();
      return { direct, hour_start, hour_end, source: provider };
    } catch {
      // Exponential (1s, 2s), jittered: the pipeline fires every US balancing
      // authority at EIA at once, so a deterministic backoff would have them
      // all rate-limited together and then retry together, in step.
      if (i < attempts - 1) await sleep(backoffMs * 2 ** i * (0.5 + Math.random()));
    }
  }
  return null; // every attempt failed -> annual fallback, or no zone reading
}
