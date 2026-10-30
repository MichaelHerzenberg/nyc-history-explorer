// Fetches raw records from each public source. Nothing here interprets the
// data; it only asks for it and keeps the response exactly as received,
// together with the URL it came from and when. profile.js does the
// interpreting. Runs unchanged in the browser and in Node 18+.

import {
  GEOSEARCH, SOCRATA, DATASETS, SOCRATA_APP_TOKEN,
} from './config.js';
import { splitBBL, isPlaceholderBIN } from './address.js';

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
    nypl_photo: () => photoFor(bin),
  };
  // A placeholder BIN (e.g. 1000000) is shared by thousands of unrelated
  // sites; querying by it would mix their records into this building's.
  if (!bin || isPlaceholderBIN(bin)) {
    for (const k of ['lpc_buildings', 'dob_jobs_major', 'dob_jobs_all', 'dob_now_jobs', 'dob_co', 'dob_violations', 'ecb_violations', 'dob_complaints']) delete tasks[k];
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
