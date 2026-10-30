// Murders and fires near an NYC address, from NYC Open Data (no API key needed).
// Works in Node 18+ and browsers (both APIs allow CORS).
//   import { lookup } from "./nycLookup.js";
//   const result = await lookup("1 Albany Ave Brooklyn", { radiusM: 150 });
//
// Provided by the project owner (Oct 2026). Changes for NYC History Explorer:
//  1. fdnyStreet() turns ordinal words into numbers ("FIFTH AVENUE" -> "5 AVE"),
//     because FDNY writes numbered avenues as digits.
//  2. firesOnStreet() also matches FDNY's double-spaced spelling ("5  AVE") and
//     accepts several ZIP codes (some buildings have their own ZIP, e.g. 10118,
//     while incidents are filed under the surrounding one).

const SODA = "https://data.cityofnewyork.us/resource";
const GEOSEARCH = "https://geosearch.planninglabs.nyc/v2/search";
const MURDER = "MURDER & NON-NEGL. MANSLAUGHTER";
const ABBR = { AVENUE: "AVE", STREET: "ST", ROAD: "RD", BOULEVARD: "BLVD", PLACE: "PL",
  DRIVE: "DR", PARKWAY: "PKWY", LANE: "LN", COURT: "CT", TERRACE: "TER", EAST: "E",
  WEST: "W", NORTH: "N", SOUTH: "S", EXPRESSWAY: "EXPY", HIGHWAY: "HWY", SQUARE: "SQ",
  FIRST: "1", SECOND: "2", THIRD: "3", FOURTH: "4", FIFTH: "5", SIXTH: "6", SEVENTH: "7",
  EIGHTH: "8", NINTH: "9", TENTH: "10", ELEVENTH: "11", TWELFTH: "12" };

async function get(url, params) {
  const res = await fetch(`${url}?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`${res.status} from ${url}: ${await res.text()}`);
  return res.json();
}

const q = (s) => String(s).replace(/'/g, "''");

export async function geocode(address) {
  const { features } = await get(GEOSEARCH, { text: address, size: 1 });
  if (!features.length) return null;
  const p = features[0].properties;
  const [lon, lat] = features[0].geometry.coordinates;
  const pad = p.addendum?.pad ?? {};
  return { label: p.label, lat, lon, street: p.street ?? "", zip: p.postalcode ?? "",
    borough: p.borough ?? "", bbl: pad.bbl, bin: pad.bin };
}

// "WEST 92 STREET" -> "W 92 ST", the form FDNY uses.
export function fdnyStreet(street) {
  return street.toUpperCase().split(/\s+/)
    .map((w) => (ABBR[w] ?? w).replace(/^(\d+)(ST|ND|RD|TH)$/, "$1")).join(" ");
}

// NYPD murder complaints within radiusM meters (2006-present), newest first.
export async function murdersNear(lat, lon, radiusM = 100) {
  const params = {
    $where: `ofns_desc='${MURDER}' AND within_circle(lat_lon,${lat},${lon},${radiusM})`,
    $select: "cmplnt_num,cmplnt_fr_dt,cmplnt_fr_tm,boro_nm,addr_pct_cd,prem_typ_desc," +
      "loc_of_occur_desc,vic_age_group,vic_sex,vic_race,latitude,longitude",
    $limit: 5000,
  };
  const sets = await Promise.all(["qgea-i56i", "5uac-w243"] // historic + current year
    .map((ds) => get(`${SODA}/${ds}.json`, params)));
  const byId = new Map(sets.flat().map((r) => [r.cmplnt_num, r]));
  return [...byId.values()].sort((a, b) => (b.cmplnt_fr_dt ?? "").localeCompare(a.cmplnt_fr_dt ?? ""));
}

// FDNY fire incidents (NFIRS 1xx) on a street within a ZIP (2013-2025), newest first.
// FDNY publishes no house numbers, so this covers the whole street within the ZIP.
export function firesOnStreet(street, zip) {
  const zips = [].concat(zip).filter(Boolean);
  const spellings = [street, street.replace(/^(\S+) /, "$1  ")];
  return get(`${SODA}/tm6d-hbzd.json`, {
    $where: `street_highway in (${spellings.map((s) => `'${q(s)}'`).join(",")}) AND zip_code in (${zips.map((z) => `'${q(z)}'`).join(",")}) AND starts_with(incident_type_desc,'1')`,
    $select: "im_incident_key,incident_date_time,incident_type_desc,highest_level_desc," +
      "property_use_desc,street_highway,zip_code",
    $order: "incident_date_time DESC",
    $limit: 50000,
  });
}

export async function lookup(address, { radiusM = 100 } = {}) {
  const location = await geocode(address);
  if (!location) throw new Error(`Address not found: ${address}`);
  const fireStreet = fdnyStreet(location.street);
  const [murders, fires] = await Promise.all([
    murdersNear(location.lat, location.lon, radiusM),
    firesOnStreet(fireStreet, location.zip),
  ]);
  return { location, murders, fires, fireStreet, radiusM };
}
