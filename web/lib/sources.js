// Fetches raw records from each public source. Nothing here interprets the
// data; it only asks for it and keeps the response exactly as received,
// together with the URL it came from and when. profile.js does the
// interpreting. Runs unchanged in the browser and in Node 18+.

import {
  GEOSEARCH, SOCRATA, NYS_SOCRATA, DATASETS, NYS_DATASETS, SOCRATA_APP_TOKEN,
} from './config.js';
import { splitBBL, isPlaceholderBIN, normalizeAddress } from './address.js';
import { geocode, murdersNear, firesOnStreet, fdnyStreet } from './nycLookup.js';

const IS_NODE = typeof window === 'undefined';
let userAgent = 'NYCHistoryExplorer/0.1 (https://github.com/MichaelHerzenberg/nyc-history-explorer)';
export function setUserAgent(ua) { userAgent = ua; }

async function getJSON(url, { headers = {}, timeout = 30000, retries = 2 } = {}) {
  const h = { Accept: 'application/json', ...headers };
  // Browsers forbid setting User-Agent; scripts identify themselves.
  if (IS_NODE) h['User-Agent'] = userAgent;
  if (SOCRATA_APP_TOKEN && url.startsWith(SOCRATA)) h['X-App-Token'] = SOCRATA_APP_TOKEN;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, { headers: h, signal: ctrl.signal });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
      const text = await res.text();
      try { return JSON.parse(text); } catch {
        throw new Error(`Non-JSON reply from ${new URL(url).host} (likely blocked or rate-limited)`);
      }
    } catch (err) {
      if (err.name === 'AbortError') err = new Error(`Timed out contacting ${new URL(url).host}`);
      if (attempt >= retries || /HTTP 4\d\d|Non-JSON/.test(err.message)) throw err;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
}

export function soqlURL(dataset, params) {
  const q = new URLSearchParams(params);
  return `${SOCRATA}/${dataset}.json?${q}`;
}

const esc = v => String(v).replace(/'/g, "''");

// Wraps a fetch so one failing source never sinks the whole profile.
async function record(name, url, fetcher = getJSON) {
  const retrieved_at = new Date().toISOString();
  try {
    const data = await fetcher(url);
    return { name, ok: true, url, retrieved_at, data };
  } catch (err) {
    return { name, ok: false, url, retrieved_at, error: String(err.message || err) };
  }
}

// ---------------------------------------------------------------- identity

export async function geosearch(text) {
  const url = `${GEOSEARCH}/search?${new URLSearchParams({ text, size: '5' })}`;
  return record('geosearch', url);
}

export async function autocomplete(text) {
  const url = `${GEOSEARCH}/autocomplete?${new URLSearchParams({ text })}`;
  return getJSON(url, { retries: 0, timeout: 8000 });
}

export async function footprintByBIN(bin) {
  return record('footprint', soqlURL(DATASETS.footprints, { bin: String(bin) }));
}

export async function footprintAtPoint(lat, lng) {
  return record('footprint_at_point', soqlURL(DATASETS.footprints, {
    $where: `intersects(the_geom,'POINT(${Number(lng)} ${Number(lat)})')`,
  }));
}

// Buildings within `meters` of a point, for "what's near me".
export async function footprintsNear(lat, lng, meters = 60) {
  const url = soqlURL(DATASETS.footprints, {
    $select: 'bin,name,base_bbl,mappluto_bbl,construction_year,the_geom',
    $where: `within_circle(the_geom,${Number(lat)},${Number(lng)},${Number(meters)}) AND last_status_type='Constructed'`,
    $limit: '50',
  });
  return getJSON(url);
}

// Footprints inside a map viewport, as GeoJSON for drawing.
export async function footprintsInBox(south, west, north, east) {
  const q = new URLSearchParams({
    $select: 'bin,name,construction_year,the_geom',
    $where: `within_box(the_geom,${north},${west},${south},${east}) AND last_status_type='Constructed'`,
    $limit: '3000',
  });
  return getJSON(`${SOCRATA}/${DATASETS.footprints}.geojson?${q}`);
}

export async function plutoAddresses(bbls) {
  if (!bbls.length) return [];
  return getJSON(soqlURL(DATASETS.pluto, {
    $select: 'bbl,address,yearbuilt',
    $where: `bbl in (${bbls.map(b => `'${esc(b)}'`).join(',')})`,
  }));
}

// Individual landmarks in the pilot area (for the map's highlight layer).
export async function pilotLandmarks(pilotWKT) {
  return getJSON(soqlURL(DATASETS.lpcDesignations, {
    $select: 'bin_number,bbl,lm_name,lp_number,desdate,desig_addr,latitude,longitude',
    $where: `within_polygon(location,'${pilotWKT}') AND lm_type='Individual Landmark' AND status='DESIGNATED'`,
    $limit: '2000',
  }));
}

// ---------------------------------------------------------------- records

// Collects every raw record for one building. `id` = { bin, bbl, plutoBBL }.
export async function gatherRaw(id, { onProgress } = {}) {
  const { bin, bbl } = id;
  const plutoBBL = id.plutoBBL || bbl;
  const lot = splitBBL(bbl);
  const tasks = {
    pluto: () => record('pluto', soqlURL(DATASETS.pluto, { bbl: plutoBBL })),
    lpc_buildings: () => record('lpc_buildings', soqlURL(DATASETS.lpcBuildings, {
      $where: `bin='${esc(bin)}'`,
    })).then(stripGeometry),
    lpc_designations: () => record('lpc_designations', soqlURL(DATASETS.lpcDesignations, {
      $where: `bin_number='${esc(bin)}' OR bbl='${esc(bbl)}'`, $limit: '200',
    })),
    dob_jobs_major: () => record('dob_jobs_major', soqlURL(DATASETS.dobJobs, {
      $where: `bin__='${esc(bin)}' AND doc__='01' AND job_type in ('NB','A1','DM')`,
      $limit: '500',
    })),
    dob_jobs_all: () => record('dob_jobs_all', soqlURL(DATASETS.dobJobs, {
      $select: 'job__,job_type,pre__filing_date', $where: `bin__='${esc(bin)}' AND doc__='01'`,
      $limit: '50000',
    })),
    dob_now_jobs: () => record('dob_now_jobs', soqlURL(DATASETS.dobNowJobs, {
      $select: 'job_filing_number,job_type,filing_status,filing_date,job_description,initial_cost',
      $where: `bin='${esc(bin)}'`, $limit: '20000',
    })),
    dob_co: () => record('dob_co', soqlURL(DATASETS.dobCO, {
      $select: 'job_number,job_type,c_o_issue_date,issue_type,filing_status_raw',
      $where: `bin='${esc(bin)}' OR bin_number='${esc(bin)}'`, $limit: '1000',
    })),
    dob_violations: () => record('dob_violations', soqlURL(DATASETS.dobViolations, {
      $select: 'issue_date,violation_type,violation_category', $where: `bin='${esc(bin)}'`, $limit: '50000',
    })),
    ecb_violations: () => record('ecb_violations', soqlURL(DATASETS.ecbViolations, {
      $select: 'issue_date,severity,ecb_violation_status', $where: `bin='${esc(bin)}'`, $limit: '50000',
    })),
    dob_complaints: () => record('dob_complaints', soqlURL(DATASETS.dobComplaints, {
      $select: 'date_entered,complaint_category,status', $where: `bin='${esc(bin)}'`, $limit: '50000',
    })),
    acris: () => gatherACRIS(lot),
    licenses: () => record('licenses', soqlURL(DATASETS.licenses, {
      $select: 'business_name,dba_trade_name,business_category,license_status,license_creation_date,lic_expir_dd',
      $where: `bin='${esc(bin)}'`, $limit: '2000',
    })),
    restaurants: () => record('restaurants', soqlURL(DATASETS.restaurants, {
      $select: 'camis,dba,cuisine_description,min(inspection_date) as first_inspection,max(inspection_date) as last_inspection',
      $where: `bin='${esc(bin)}'`, $group: 'camis,dba,cuisine_description', $limit: '2000',
    })),
    nypl_photo: () => photoFor(bin),
  };
  // A placeholder BIN (e.g. 1000000) is shared by thousands of unrelated
  // sites; querying by it would mix their records into this building's.
  if (!bin || isPlaceholderBIN(bin)) {
    for (const k of ['lpc_buildings', 'dob_jobs_major', 'dob_jobs_all', 'dob_now_jobs', 'dob_co', 'dob_violations', 'ecb_violations', 'dob_complaints', 'licenses', 'restaurants']) delete tasks[k];
    tasks.lpc_designations = () => record('lpc_designations', soqlURL(DATASETS.lpcDesignations, { bbl: String(bbl), $limit: '200' }));
  }
  const names = Object.keys(tasks);
  let done = 0;
  const results = await Promise.all(names.map(n => tasks[n]().then(r => {
    done++; onProgress?.(done, names.length, n);
    return r;
  })));
  const raw = {};
  names.forEach((n, i) => { raw[n] = results[i]; });
  // Second step: offices and block incidents, which need the ZIP code and
  // addresses found above.
  [raw.offices, raw.incidents] = await Promise.all([gatherOffices(id, raw), gatherIncidents(id, raw)]);
  return raw;
}

function stripGeometry(rec) {
  if (rec.ok && Array.isArray(rec.data)) {
    rec.data = rec.data.map(({ the_geom, ...rest }) => rest);
  }
  return rec;
}

// ACRIS: legals (which documents touch this lot) -> master (what each
// document is) -> parties (who, for deeds) + the document-type lookup table.
async function gatherACRIS(lot) {
  const out = { name: 'acris', ok: false, retrieved_at: new Date().toISOString(), parts: {} };
  if (!lot) { out.error = 'No valid BBL'; return out; }
  const legals = await record('acris_legals', soqlURL(DATASETS.acrisLegals, {
    $select: 'document_id,street_number,street_name,unit,partial_lot,property_type,easement,air_rights',
    borough: lot.borough, block: lot.block, lot: lot.lot, $limit: '5000',
  }));
  out.parts.legals = legals;
  if (!legals.ok) { out.error = legals.error; return out; }
  const ids = [...new Set(legals.data.map(r => r.document_id))];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 80) chunks.push(ids.slice(i, i + 80));
  const inList = c => c.map(d => `'${esc(d)}'`).join(',');
  const masters = await Promise.all(chunks.map(c => record('acris_master', soqlURL(DATASETS.acrisMaster, {
    $select: 'document_id,doc_type,document_date,recorded_datetime,document_amt,crfn',
    $where: `document_id in (${inList(c)})`, $limit: '5000',
  }))));
  out.parts.master = mergeRecords('acris_master', masters);
  out.parts.codes = await record('acris_codes', soqlURL(DATASETS.acrisCodes, { $limit: '1000' }));
  const conveyanceTypes = new Set((out.parts.codes.data || [])
    .filter(c => c.class_code_description === 'DEEDS AND OTHER CONVEYANCES').map(c => c.doc__type));
  const deedIds = (out.parts.master.data || [])
    .filter(m => conveyanceTypes.has(m.doc_type) || m.doc_type === 'LDMK').map(m => m.document_id);
  const pchunks = [];
  for (let i = 0; i < deedIds.length; i += 80) pchunks.push(deedIds.slice(i, i + 80));
  const parties = await Promise.all(pchunks.map(c => record('acris_parties', soqlURL(DATASETS.acrisParties, {
    $select: 'document_id,party_type,name', $where: `document_id in (${inList(c)})`, $limit: '5000',
  }))));
  out.parts.parties = mergeRecords('acris_parties', parties);
  out.ok = out.parts.master.ok;
  if (!out.ok) out.error = out.parts.master.error;
  return out;
}

function mergeRecords(name, recs) {
  if (!recs.length) return { name, ok: true, url: null, retrieved_at: new Date().toISOString(), data: [] };
  const bad = recs.find(r => !r.ok);
  if (bad) return bad;
  return { name, ok: true, url: recs.map(r => r.url), retrieved_at: recs[0].retrieved_at, data: recs.flatMap(r => r.data) };
}

// Companies with offices here, from New York State company filings. Only the
// "chief executive officer" and "principal executive office" addresses count
// (types 3 and 4); service-of-process and registered-agent addresses are
// usually a lawyer's or agent's mailbox, and "c/o" addresses are someone
// else's office.
export function buildingAddresses(id, raw) {
  const rowsOf = r => (r?.ok && Array.isArray(r.data) ? r.data : []);
  const list = [id.label, rowsOf(raw.pluto)[0]?.address, rowsOf(raw.lpc_buildings)[0]?.des_addres,
    ...rowsOf(raw.lpc_designations).filter(d => d.bin_number === id.bin).map(d => d.desig_addr),
    ...(id.candidates || []).filter(c => c.bin === id.bin).map(c => c.label)];
  const out = new Set();
  // "173-185 Fifth Avenue (aka 945-953 Broadway)" -> both addresses; ranges
  // expand to every number on that side of the street (companies write "175").
  const pieces = list.filter(Boolean).flatMap(a => String(a).split(/\(\s*a\.?k\.?a\.?|\)|;|\baka\b/i)).map(x => x.trim()).filter(Boolean);
  for (const a of pieces) {
    const n = normalizeAddress(a);
    const m = n.match(/^(\d+)[A-Z]?(?:-(\d+)[A-Z]?)?\s+(.+)$/);
    if (!m) continue;
    const lo = Number(m[1]);
    let hi = lo;
    if (m[2]) hi = Number(m[2].length < m[1].length ? m[1].slice(0, m[1].length - m[2].length) + m[2] : m[2]);
    if (!(hi >= lo) || hi - lo > 80) hi = lo;
    for (let k = lo; k <= hi; k += 2) out.add(`${k} ${m[3]}`);
    out.add(`${hi} ${m[3]}`);
  }
  return [...out];
}

// SQL patterns for one address: "350 5 AVENUE" -> "350 %5%", "350 %FIFTH%".
const AVENUE_WORD = ['', 'FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH', 'SIXTH', 'SEVENTH', 'EIGHTH', 'NINTH', 'TENTH', 'ELEVENTH', 'TWELFTH'];
function likePatterns(address) {
  const [num, ...rest] = address.split(' ');
  const street = rest.filter(w => !/^(WEST|EAST|NORTH|SOUTH)$/.test(w));
  const key = street[0];
  if (!key) return [];
  const pats = [`${num} %${key}%`];
  if (/^\d+$/.test(key) && street[1] === 'AVENUE' && AVENUE_WORD[Number(key)]) pats.push(`${num} %${AVENUE_WORD[Number(key)]}%`);
  if (key === '6' && street[1] === 'AVENUE') pats.push(`${num} %AMERICAS%`);
  return pats;
}

async function gatherOffices(id, raw) {
  const addresses = buildingAddresses(id, raw);
  const out = { name: 'offices', ok: true, retrieved_at: new Date().toISOString(), addresses, parts: {} };
  if (!addresses.length || isPlaceholderBIN(id.bin)) return out;
  const nyURL = (ds, p) => `${NYS_SOCRATA}/${ds}.json?${new URLSearchParams(p)}`;
  const likes = [...new Set(addresses.flatMap(likePatterns))];
  const addrRec = await record('offices_addresses', nyURL(NYS_DATASETS.corpAddresses, {
    $select: 'corpid_num,date_filed,addr_type,addr1,addr2,city,zip5',
    $where: `addr_type in ('3','4') AND upper(city) in ('NEW YORK','NY','NEW YORK CITY','MANHATTAN','NYC') AND (${likes.map(l => `upper(addr1) like '${esc(l)}'`).join(' OR ')})`,
    $limit: '50000',
  }));
  out.parts.addresses = addrRec;
  if (!addrRec.ok) { out.ok = false; out.error = addrRec.error; return out; }
  const ours = addresses;
  const hits = addrRec.data.filter(r => {
    if (/\bC\/O\b|\bCARE OF\b/i.test(`${r.addr1} ${r.addr2 || ''}`)) return false;
    const n = normalizeAddress(r.addr1);
    return ours.some(a => n === a || n.startsWith(a + ' '));
  });
  out.parts.matched = hits;
  const ids = [...new Set(hits.map(r => r.corpid_num))];
  const chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const inList = c => c.map(x => `'${esc(x)}'`).join(',');
  const active = await Promise.all(chunks.map(c => record('offices_active', nyURL(NYS_DATASETS.activeCorps, {
    $select: 'dos_id,current_entity_name,entity_type', $where: `dos_id in (${inList(c)})`, $limit: '5000',
  }))));
  out.parts.active = mergeRecords('offices_active', active);
  const activeIds = new Set((out.parts.active.data || []).map(a => a.dos_id));
  const missing = ids.filter(x => !activeIds.has(x));
  const mchunks = [];
  for (let i = 0; i < missing.length; i += 100) mchunks.push(missing.slice(i, i + 100));
  const names = await Promise.all(mchunks.map(c => record('offices_names', nyURL(NYS_DATASETS.corpFilings, {
    $select: 'corpid_num,corp_name,max(date_filed) as date_filed', $where: `corpid_num in (${inList(c)}) AND documenttype not like '%ASSUMED NAME%'`,
    $group: 'corpid_num,corp_name', $limit: '20000',
  }))));
  out.parts.names = mergeRecords('offices_names', names);
  out.url = addrRec.url;
  return out;
}

// Murders within 150 m (NYPD) and fires on the building's street within its
// ZIP code (FDNY publishes no house numbers), via the owner's nycLookup.js.
export const INCIDENT_RADIUS_M = 150;
async function gatherIncidents(id, raw) {
  const out = { name: 'incidents', ok: true, retrieved_at: new Date().toISOString(), radius_m: INCIDENT_RADIUS_M, parts: {} };
  if (id.lat == null) { out.ok = false; out.error = 'No location'; return out; }
  const address = buildingAddresses(id, raw)[0] || normalizeAddress(id.label || '');
  const zips = new Set([(raw.pluto?.data?.[0]?.zipcode || '').trim()]);
  let street = address.replace(/^\S+\s+/, '');
  try {
    const g = await geocode(`${address}, Manhattan`);
    if (g?.zip) zips.add(g.zip);
    if (g?.street) street = g.street;
  } catch { /* fall back to the tax-lot ZIP */ }
  zips.delete('');
  out.street = fdnyStreet(street);
  out.zips = [...zips];
  const wrap = async (name, fn) => {
    try { return { name, ok: true, data: await fn() }; } catch (err) { return { name, ok: false, error: String(err.message || err) }; }
  };
  [out.parts.murders, out.parts.fires] = await Promise.all([
    wrap('murders', () => murdersNear(id.lat, id.lng, INCIDENT_RADIUS_M)),
    out.zips.length ? wrap('fires', () => firesOnStreet(out.street, out.zips)) : { name: 'fires', ok: false, error: 'No ZIP code' },
  ]);
  if (!out.parts.murders.ok && !out.parts.fires.ok) { out.ok = false; out.error = out.parts.murders.error; }
  return out;
}

// NYPL photos are chosen ahead of time by scripts/nypl-photos.mjs (the API key
// stays off the public site) and saved to web/data/nypl-photos.json.
let photoIndex = null;
function loadPhotoIndex() {
  const file = new URL('../data/nypl-photos.json', import.meta.url);
  photoIndex ||= (IS_NODE
    ? import('node:fs/promises').then(fs => fs.readFile(file, 'utf8')).then(JSON.parse)
    : fetch(file).then(r => (r.ok ? r.json() : { photos: {} })))
    .catch(() => ({ photos: {} }));
  return photoIndex;
}
async function photoFor(bin) {
  const idx = await loadPhotoIndex();
  return { name: 'nypl_photo', ok: true, url: 'data/nypl-photos.json', retrieved_at: idx.generated_at || null, data: idx.photos?.[bin] ? [idx.photos[bin]] : [] };
}

// Library of Congress Chronicling America (historic US newspapers, mostly
// public domain). loc.gov sometimes refuses automated or cloud traffic; the
// app then falls back to a search link.
export async function searchNewspapers(phrase, fromYear, toYear) {
  const q = new URLSearchParams({ q: `"${phrase}"`, dates: `${fromYear}/${toYear}`, fo: 'json', c: '10', at: 'results,pagination' });
  return record('newspapers', `https://www.loc.gov/collections/chronicling-america/?${q}`,
    url => getJSON(url, { retries: 0, timeout: 15000 }));
}
