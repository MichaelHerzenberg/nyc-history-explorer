// Fetches raw records from each public source. Nothing here interprets the
// data; it only asks for it and keeps the response exactly as received,
// together with the URL it came from and when. profile.js does the
// interpreting. Runs unchanged in the browser and in Node 18+.

import {
  GEOSEARCH, SOCRATA, WIKIDATA_SPARQL, COMMONS_API, DATASETS, SOCRATA_APP_TOKEN,
} from './config.js';
import { splitBBL, isPlaceholderBIN } from './address.js';

const IS_NODE = typeof window === 'undefined';
let userAgent = 'NYCHistoryExplorer/0.1 (https://github.com/MichaelHerzenberg/nyc-history-explorer)';
export function setUserAgent(ua) { userAgent = ua; }

async function getJSON(url, { headers = {}, timeout = 30000, retries = 2 } = {}) {
  const h = { Accept: 'application/json', ...headers };
  // Browsers forbid setting User-Agent; Wikimedia accepts Api-User-Agent instead.
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
    $select: 'bin_number,bbl,lm_name,lp_number,desdate,latitude,longitude',
    $where: `within_polygon(location,'${pilotWKT}') AND lm_type='Individual Landmark' AND status='DESIGNATED'`,
    $limit: '2000',
  }));
}

// ---------------------------------------------------------------- records

// Collects every raw record for one building. `id` = { bin, bbl, plutoBBL }.
export async function gatherRaw(id, { onProgress, photos = true } = {}) {
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
    wikidata: () => gatherWikidata(bin),
  };
  // A placeholder BIN (e.g. 1000000) is shared by thousands of unrelated
  // sites; querying by it would mix their records into this building's.
  if (!bin || isPlaceholderBIN(bin)) {
    for (const k of ['lpc_buildings', 'dob_jobs_major', 'dob_jobs_all', 'dob_now_jobs', 'dob_co', 'dob_violations', 'ecb_violations', 'dob_complaints', 'wikidata']) delete tasks[k];
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
  // Commons photos depend on what Wikidata returned.
  if (photos) raw.commons = await gatherCommons(raw.wikidata);
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

// Wikidata links buildings to NYC BINs (property P6082), so the match is by
// ID, not by guessing from the name.
const WD_PROPS = ['P571', 'P1619', 'P576', 'P84', 'P631', 'P88', 'P149', 'P1435',
  'P649', 'P18', 'P5775', 'P373', 'P1101', 'P793', 'P127', 'P138'];

async function gatherWikidata(bin) {
  const sparql = query => `${WIKIDATA_SPARQL}?${new URLSearchParams({ query, format: 'json' })}`;
  const wdFetch = url => getJSON(url, { headers: { Accept: 'application/sparql-results+json' } });
  const items = await record('wikidata_items', sparql(`
SELECT ?item ?itemLabel ?itemDescription ?article WHERE {
  ?item wdt:P6082 "${esc(bin)}" .
  OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`), wdFetch);
  const out = { name: 'wikidata', ok: items.ok, retrieved_at: items.retrieved_at, url: items.url, parts: { items } };
  if (!items.ok) { out.error = items.error; return out; }
  const qids = [...new Set(items.data.results.bindings.map(b => b.item.value.split('/').pop()))];
  if (!qids.length) return out;
  out.parts.claims = await record('wikidata_claims', sparql(`
SELECT ?item ?prop ?val ?valLabel ?prec ?pit ?start ?end WHERE {
  VALUES ?item { ${qids.map(q => 'wd:' + q).join(' ')} }
  VALUES ?prop { ${WD_PROPS.map(p => 'wd:' + p).join(' ')} }
  ?prop wikibase:claim ?p ; wikibase:statementProperty ?ps ; wikibase:statementValue ?psv .
  ?item ?p ?st . ?st ?ps ?val .
  OPTIONAL { ?st ?psv ?vn . ?vn wikibase:timePrecision ?prec . }
  OPTIONAL { ?st pq:P585 ?pit } OPTIONAL { ?st pq:P580 ?start } OPTIONAL { ?st pq:P582 ?end }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`), wdFetch);
  return out;
}

// Wikimedia Commons: the building's own images plus files from any
// historical sub-categories (names with old decades, "construction", "history").
async function gatherCommons(wikidata) {
  const out = { name: 'commons', ok: true, retrieved_at: new Date().toISOString(), parts: {} };
  const rows = wikidata?.parts?.claims?.data?.results?.bindings || [];
  const files = rows.filter(r => ['P18', 'P5775'].includes(r.prop.value.split('/').pop()))
    .map(r => 'File:' + decodeURIComponent(r.val.value.split('/Special:FilePath/').pop()).replace(/_/g, ' '));
  const cats = rows.filter(r => r.prop.value.endsWith('/P373')).map(r => r.val.value);
  const api = params => `${COMMONS_API}?${new URLSearchParams({ format: 'json', origin: '*', ...params })}`;
  const info = { prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: '480' };
  if (!files.length && !cats.length) return out;
  if (files.length) {
    out.parts.lead = await record('commons_lead', api({ action: 'query', titles: files.slice(0, 10).join('|'), ...info }));
  }
  const cat = cats[0];
  if (cat) {
    out.parts.category = await record('commons_category', api({
      action: 'query', generator: 'categorymembers', gcmtitle: 'Category:' + cat,
      gcmtype: 'file', gcmlimit: '8', ...info,
    }));
    const listSubcats = title => record('commons_subcats', api({
      action: 'query', list: 'categorymembers', cmtitle: title, cmtype: 'subcat', cmlimit: '200',
    }));
    const titles = r => (r.data?.query?.categorymembers || []).map(c => c.title);
    const subs = await listSubcats('Category:' + cat);
    out.parts.subcats = subs;
    let names = titles(subs);
    // Big subjects group old photos under "<name> by decade" / "by year".
    const byDecade = names.find(t => / by decade$/i.test(t)) || names.find(t => / by year$/i.test(t));
    if (byDecade) {
      out.parts.decades = await listSubcats(byDecade);
      names = names.concat(titles(out.parts.decades));
    }
    const historic = names
      .filter(t => /\b(1[6-9][0-7]\ds|1[6-9][0-7]\d|construction|history|historical|old photographs?|black and white photographs)\b/i.test(t))
      .sort((a, b) => (a.match(/1[6-9]\d\d/)?.[0] || '9999').localeCompare(b.match(/1[6-9]\d\d/)?.[0] || '9999'))
      .slice(0, 4);
    out.parts.historic = await Promise.all(historic.map(t => record('commons_historic', api({
      action: 'query', generator: 'categorymembers', gcmtitle: t, gcmtype: 'file', gcmlimit: '6', ...info,
    }))));
  }
  const all = [out.parts.lead, out.parts.category, ...(out.parts.historic || [])].filter(Boolean);
  if (all.length && all.every(r => !r.ok)) { out.ok = false; out.error = all[0].error; }
  return out;
}

// Library of Congress Chronicling America (historic US newspapers, mostly
// public domain). loc.gov sometimes refuses automated or cloud traffic; the
// app then falls back to a search link.
export async function searchNewspapers(phrase, fromYear, toYear) {
  const q = new URLSearchParams({ q: `"${phrase}"`, dates: `${fromYear}/${toYear}`, fo: 'json', c: '10', at: 'results,pagination' });
  return record('newspapers', `https://www.loc.gov/collections/chronicling-america/?${q}`,
    url => getJSON(url, { retries: 0, timeout: 15000 }));
}
