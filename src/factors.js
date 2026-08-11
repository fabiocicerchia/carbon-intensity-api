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
