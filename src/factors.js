// Operational emission factors and grid-mix -> intensity computation.
//
// Real-time providers report generation per fuel type; we weight each fuel's
// generation by its operational (combustion-only) emission factor to get a
// direct carbon intensity: direct = Σ(MWh_fuel × factor_fuel) / Σ MWh.
// Factors are approximate operational values in gCO2/kWh. Biogenic and
// renewable/nuclear generation is treated as zero operational emissions;
// upstream/lifecycle emissions are added later via per-country deltas.

export const FUEL_FACTORS_DIRECT = {
  hard_coal: 900,
  lignite: 1150,
  gas: 470,
  oil: 720,
  peat: 1050,
  other_fossil: 700,
  thermal: 550, // unspecified fossil thermal (mixed gas/oil/coal fleet)
  waste: 300, // non-biogenic fraction of municipal waste
  biomass: 0, // biogenic CO2 treated as operationally neutral
  geothermal: 40,
  nuclear: 0,
  hydro: 0,
  wind: 0,
  solar: 0,
  marine: 0,
  other: 0,
  storage: 0,
};

// The fuel-code mappings below are derived from each data source's OWN
// published taxonomy (primary sources cited per block), not from any third
// party — so the computed values are independent.

// ENTSO-E A75 "Actual Generation per Production Type" PSR codes -> canonical
// fuel. Source: ENTSO-E Transparency Platform, standard PSR-type code list
// (Restful API user guide, document type A75).
export const ENTSOE_PSR_TO_FUEL = {
  B01: "biomass",
  B02: "lignite",
  B03: "other_fossil",
  B04: "gas",
  B05: "hard_coal",
  B06: "oil",
  B07: "oil",
  B08: "peat",
  B09: "geothermal",
  B10: "hydro",
  B11: "hydro",
  B12: "hydro",
  B13: "marine",
  B14: "nuclear",
  B15: "other",
  B16: "solar",
  B17: "waste",
  B18: "wind",
  B19: "wind",
  B20: "other",
  // Storage discharge. Zero here for the same reason B10 pumped storage is:
  // whatever charged it was already counted in the mix at the time, and the
  // matching consumption series is dropped rather than netted off.
  B25: "storage",
};

// EIA hourly fuel-type codes -> canonical fuel. Source: US EIA Open Data,
// Hourly Electric Grid Monitor fuel-type series codes.
export const EIA_FUEL_TO_FUEL = {
  COL: "hard_coal",
  NG: "gas",
  OIL: "oil",
  NUC: "nuclear",
  WAT: "hydro",
  SUN: "solar",
  WND: "wind",
  OTH: "other",
};

// ONS (Brazil) "geracao" keys -> canonical fuel (Portuguese fuel names from
// the ONS balanço-energético JSON). Thermal is unsplit -> blended factor.
export const ONS_FUEL_TO_FUEL = {
  hidraulica: "hydro",
  termica: "thermal",
  eolica: "wind",
  solar: "solar",
  nuclear: "nuclear",
  itaipu50hzbrasil: "hydro",
  itaipu60hz: "hydro",
};

// OpenElectricity (OpenNEM) fuel_tech -> canonical fuel. Source: OpenElectricity
// fueltech taxonomy (docs.openelectricity.org.au/guides/fueltechs).
export const OPENNEM_FUEL_TO_FUEL = {
  coal_black: "hard_coal",
  coal_brown: "lignite",
  gas_ccgt: "gas",
  gas_ocgt: "gas",
  gas_recip: "gas",
  gas_steam: "gas",
  gas_wcmg: "gas",
  distillate: "oil",
  hydro: "hydro",
  wind: "wind",
  wind_offshore: "wind",
  bioenergy_biomass: "biomass",
  bioenergy_biogas: "biomass",
  solar_utility: "solar",
  solar_rooftop: "solar",
  solar_thermal: "solar",
  nuclear: "nuclear",
};

// Singapore EMC ticker "Generator Type Share" labels -> canonical fuel
// (labels published in the EMC market ticker).
export const SG_FUEL_TO_FUEL = {
  "ccgt/cogen/trigen": "gas",
  gt: "gas",
  st: "thermal",
  wte: "waste",
  solar: "solar",
};

// IESO (Ontario) Generator Output and Capability <FuelType> -> canonical fuel.
// Source: the report's own schema (GenOutputCapability_r3.xsd) — the fuel types
// it emits are NUCLEAR, GAS, HYDRO, WIND, SOLAR, BIOFUEL and OTHER.
//
// OTHER is a handful of small units the IESO does not classify further. It maps
// to `other` (0 gCO2) as ENTSO-E's unmapped psrTypes do; it is under 1% of
// Ontario's output, so the alternative — guessing a fossil factor — would be a
// larger error than the one it fixes.
export const IESO_FUEL_TO_FUEL = {
  nuclear: "nuclear",
  gas: "gas",
  hydro: "hydro",
  wind: "wind",
  solar: "solar",
  biofuel: "biomass",
  other: "other",
};

// Eskom (South Africa) Station_Build_Up.csv column index (after the datetime)
// -> canonical fuel. Source: Eskom Data Portal column glossary. Only generation
// columns are listed; storage/import/load-shed columns are skipped.
export const ESKOM_INDEX_TO_FUEL = {
  0: "hard_coal",
  6: "nuclear",
  8: "oil",
  9: "gas",
  10: "oil",
  11: "hydro",
  16: "wind",
  17: "solar",
  18: "solar",
  19: "biomass",
};

// Weighted operational intensity (gCO2/kWh) for a canonical-fuel -> MWh mix.
// Returns null when total generation is non-positive. Negative per-fuel values
// (e.g. net pumped-storage consumption) are floored at 0.
// --- Elexon BMRS (GB) ---------------------------------------------------------
// FUELINST's transmission-level fuel mix. The INT* rows are interconnector
// flows, not generation — they go both ways and are routinely negative — so
// they are absent here and dropped, the same treatment ENTSO-E's
// outBiddingZone series get.
//
// Caveat worth knowing when reading a GB figure sourced from Elexon: FUELINST
// has no solar row at all. GB solar is overwhelmingly distribution-connected
// and invisible to transmission metering, so this mix omits it and reads
// dirtier than the truth in daylight. NESO's own feed models embedded
// generation, which is why it stays the primary and this is only the fallback.
export const ELEXON_FUEL_TO_FUEL = {
  BIOMASS: "biomass",
  CCGT: "gas",
  OCGT: "gas",
  COAL: "hard_coal",
  OIL: "oil",
  NUCLEAR: "nuclear",
  NPSHYD: "hydro",
  PS: "hydro",
  WIND: "wind",
  OTHER: "other",
};

// --- Energy-Charts (Fraunhofer ISE) ------------------------------------------
// Matched on a normalised substring rather than an exact name, because this feed
// labels series in prose ("Fossil brown coal / lignite") and the wording is not
// a contract. Ordered: the first rule that matches wins, so lignite is tested
// before the bare "coal".
//
// Anything unmatched is DROPPED, not counted as `other`. The response carries
// non-generation series alongside the fuels — load, residual load, cross-border
// trading, renewable share — and treating an unrecognised one as generation
// would put load into the denominator and halve the intensity. Dropping an
// unknown fuel understates a little; counting load destroys the figure.
const ENERGY_CHARTS_SKIP = [
  "load",
  "cross border",
  "cross-border",
  "share",
  "import",
  "export",
  "consumption",
  "residual",
  "price",
  "renewable",
];

const ENERGY_CHARTS_RULES = [
  ["brown coal", "lignite"],
  ["lignite", "lignite"],
  // Before the bare "coal": the feed publishes "Fossil coal-derived gas", which
  // is ENTSO-E's B03 and burns nothing like hard coal — 700 against 900.
  ["coal-derived", "other_fossil"],
  ["hard coal", "hard_coal"],
  ["coal", "hard_coal"],
  ["gas", "gas"],
  ["oil", "oil"],
  ["nuclear", "nuclear"],
  ["biomass", "biomass"],
  ["waste", "waste"],
  ["geothermal", "geothermal"],
  ["hydro", "hydro"],
  ["wind", "wind"],
  ["solar", "solar"],
  ["battery", "storage"],
  ["storage", "storage"],
  // "Others" is this feed's B20. Mapped rather than dropped so it lands in the
  // denominator exactly as it does on the primary: dropping it would make the
  // same grid read slightly dirtier through the fallback than through ENTSO-E.
  ["other", "other"],
];

// -> our fuel key, or null for a series that is not generation.
export function energyChartsFuel(name) {
  const n = String(name || "").toLowerCase();
  if (!n) return null;
  if (ENERGY_CHARTS_SKIP.some((w) => n.includes(w))) return null;
  for (const [needle, fuel] of ENERGY_CHARTS_RULES) if (n.includes(needle)) return fuel;
  return null;
}

export function mixToDirectIntensity(mix) {
  let total = 0;
  let weighted = 0;
  for (const [fuel, mwh] of Object.entries(mix)) {
    if (mwh == null || mwh <= 0) continue;
    const factor = FUEL_FACTORS_DIRECT[fuel] ?? FUEL_FACTORS_DIRECT.other;
    total += mwh;
    weighted += mwh * factor;
  }
  if (total <= 0) return null;
  return weighted / total;
}
