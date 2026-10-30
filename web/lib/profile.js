// Turns raw source records (from sources.js) into one building profile:
// facts, a dated timeline, ownership, DOB activity, conflicts and
// gaps. Pure function: no network, so it can be tested offline against
// saved fixtures. Every fact and event carries `cite` entries pointing at the
// record it came from. Nothing is invented: when a source is silent, the
// profile says so in `gaps`.

import { normalizeAddress, displayAddress, isCondoBillingLot, splitBBL } from './address.js';
import { DATASETS } from './config.js';
import { writeNarrative } from './narrative.js';

export const SCHEMA_VERSION = 1;

const OD = id => `https://data.cityofnewyork.us/d/${id}`;
const NYC_TERMS = 'NYC Open Data — free public data (NYC Open Data Law)';

export const SOURCES = {
  geosearch: { label: 'NYC GeoSearch (City address directory, PAD)', publisher: 'NYC Dept. of City Planning', url: 'https://geosearch.planninglabs.nyc/', license: 'Free public API (City data)' },
  footprints: { label: 'Building Footprints', publisher: 'NYC Office of Technology & Innovation', url: OD(DATASETS.footprints), license: NYC_TERMS },
  pluto: { label: 'PLUTO tax-lot data', publisher: 'NYC Dept. of City Planning', url: OD(DATASETS.pluto), license: NYC_TERMS, caution: 'City Planning notes that “year built” is often estimated.' },
  lpc_buildings: { label: 'LPC Landmark & Historic District Building Database', publisher: 'NYC Landmarks Preservation Commission', url: OD(DATASETS.lpcBuildings), license: NYC_TERMS },
  lpc_designations: { label: 'LPC Designated and Calendared Buildings and Sites', publisher: 'NYC Landmarks Preservation Commission', url: OD(DATASETS.lpcDesignations), license: NYC_TERMS },
  lpc_report: { label: 'LPC designation report', publisher: 'NYC Landmarks Preservation Commission', url: 'https://www.nyc.gov/site/lpc/designations/designation-reports.page', license: 'Public government record' },
  dob_jobs: { label: 'DOB Job Application Filings (BIS)', publisher: 'NYC Dept. of Buildings', url: OD(DATASETS.dobJobs), license: NYC_TERMS },
  dob_now: { label: 'DOB NOW: Build job filings', publisher: 'NYC Dept. of Buildings', url: OD(DATASETS.dobNowJobs), license: NYC_TERMS },
  dob_co: { label: 'DOB Certificates of Occupancy', publisher: 'NYC Dept. of Buildings', url: OD(DATASETS.dobCO), license: NYC_TERMS },
  dob_violations: { label: 'DOB Violations', publisher: 'NYC Dept. of Buildings', url: OD(DATASETS.dobViolations), license: NYC_TERMS },
  ecb_violations: { label: 'DOB ECB Violations', publisher: 'NYC Dept. of Buildings', url: OD(DATASETS.ecbViolations), license: NYC_TERMS },
  dob_complaints: { label: 'DOB Complaints Received', publisher: 'NYC Dept. of Buildings', url: OD(DATASETS.dobComplaints), license: NYC_TERMS },
  nypl: { label: 'NYPL Digital Collections', publisher: 'The New York Public Library', url: 'https://digitalcollections.nypl.org/', license: 'Public domain (per NYPL rights statement on each item)' },
  acris: { label: 'ACRIS property records (City Register)', publisher: 'NYC Dept. of Finance', url: OD(DATASETS.acrisMaster), license: NYC_TERMS },
};

// Labels for PLUTO building-class first letters (subset; full list from DCP).
const BLDG_CLASS = {
  A: 'One-family house', B: 'Two-family house', C: 'Walk-up apartments', D: 'Elevator apartments',
  E: 'Warehouse', F: 'Factory / industrial', G: 'Garage', H: 'Hotel', I: 'Hospital / health',
  J: 'Theatre', K: 'Store building', L: 'Loft building', M: 'Religious building', N: 'Asylum / home',
  O: 'Office building', P: 'Place of assembly / cultural', Q: 'Outdoor recreation', R: 'Condominium',
  S: 'Mixed residential & store', T: 'Transportation facility', U: 'Utility', V: 'Vacant land',
  W: 'Educational', Y: 'Government / public', Z: 'Miscellaneous',
};

// ---------------------------------------------------------------- helpers

const rows = rec => (rec && rec.ok && Array.isArray(rec.data) ? rec.data : []);
const blank = v => v == null || v === '' || v === '0' || v === 0;
const title = s => String(s || '').toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase())
  .replace(/\b(\d+)(St|Nd|Rd|Th)\b/g, (m, n, x) => n + x.toLowerCase());
const stripHTML = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

// "11/30/1995" -> "1995-11-30"; "19951130" -> "1995-11-30"; ISO kept as date.
export function isoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^[+]?(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
const yearOf = d => (d ? Number(String(d).slice(0, 4)) : null);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function formatDate(iso, precision = 'day') {
  if (!iso) return 'Undated';
  const [y, m, d] = iso.split('-');
  if (precision === 'year' || !m) return String(Number(y));
  if (precision === 'month') return `${MONTHS[Number(m) - 1]} ${Number(y)}`;
  return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${Number(y)}`;
}

const lpReportURL = lp => {
  const n = String(lp || '').match(/(\d+)/);
  return n ? `https://s-media.nyc.gov/agencies/lpc/lp/${String(Number(n[1])).padStart(4, '0')}.pdf` : null;
};
const bisJobURL = job => `https://a810-bisweb.nyc.gov/bisweb/JobsQueryByNumberServlet?passjobnumber=${encodeURIComponent(job)}&passdocnumber=01`;
const acrisDocURL = id => `https://a836-acris.nyc.gov/DS/DocumentSearch/DocumentDetail?doc_id=${encodeURIComponent(id)}`;
const recURL = rec => (Array.isArray(rec?.url) ? rec.url[0] : rec?.url) || null;

const cite = (source, url, note) => ({ source, ...(url ? { url } : {}), ...(note ? { note } : {}) });

// ---------------------------------------------------------------- main

export function buildProfile(identity, raw, { now = new Date() } = {}) {
  const { bin, bbl } = identity;
  const lot = splitBBL(bbl);
  const fp = rows(raw.footprint)[0] || null;
  const pluto = rows(raw.pluto)[0] || null;
  const lpcB = rows(raw.lpc_buildings)[0] || null;
  const desig = rows(raw.lpc_designations);

  const facts = [];
  const timeline = [];
  const conflicts = [];
  const gaps = [];

  const name = lpcB?.build_nme && !blank(lpcB.build_nme) ? lpcB.build_nme
    : fp?.name || desig.find(d => d.bin_number === bin)?.lm_name || null;

  // ---- addresses: every spelling, grouped by normalised form
  const addrMap = new Map();
  const addAddr = (text, source) => {
    if (!text || blank(text)) return;
    const n = normalizeAddress(text);
    if (!n || !/^\d/.test(n)) return;
    if (!addrMap.has(n)) addrMap.set(n, { address: displayAddress(n), normalized: n, sources: new Set() });
    addrMap.get(n).sources.add(source);
  };
  if (identity.label) addAddr(identity.label, 'geosearch');
  for (const c of identity.candidates || []) if (c.bin === bin) addAddr(c.label, 'geosearch');
  addAddr(pluto?.address, 'pluto');
  addAddr(lpcB?.des_addres, 'lpc_buildings');
  for (const d of desig) if (d.bin_number === bin) { addAddr(d.desig_addr, 'lpc_designations'); addAddr(d.pluto_addr, 'lpc_designations'); }
  for (const j of rows(raw.dob_jobs_major)) addAddr(`${j.house__} ${j.street_name}`, 'dob_jobs');
  const acrisParts = raw.acris?.parts || {};
  for (const l of rows(acrisParts.legals)) if (!l.unit) addAddr(`${l.street_number} ${l.street_name}`, 'acris');
  const addresses = [...addrMap.values()].map(a => ({ ...a, sources: [...a.sources] }))
    .sort((a, b) => addrScore(b) - addrScore(a));

  // ---- construction date: compare every source, flag disagreement
  const built = [];
  if (lpcB && !blank(lpcB.date_low)) {
    const lo = Number(lpcB.date_low), hi = blank(lpcB.date_high) ? lo : Number(lpcB.date_high);
    built.push({ source: 'lpc_buildings', value: lpcB.date_combo || (hi !== lo ? `${lo}–${hi}` : String(lo)), year: hi, from: lo, circa: lpcB.circa === '1', url: recURL(raw.lpc_buildings) });
  }
  if (fp && !blank(fp.construction_year)) built.push({ source: 'footprints', value: fp.construction_year, year: Number(fp.construction_year), url: recURL(raw.footprint) });
  if (pluto && !blank(pluto.yearbuilt)) built.push({ source: 'pluto', value: pluto.yearbuilt, year: Number(pluto.yearbuilt), url: recURL(raw.pluto) });
  if (built.length) {
    facts.push({ key: 'built', label: 'Built', value: built[0].value + (built[0].circa ? ' (circa)' : ''), cite: built.map(b => cite(b.source, b.url, b.value)) });
    // Agree = within a year of the LPC's researched range, or (without LPC)
    // within a year of each other.
    const lpcRange = built.find(b => b.source === 'lpc_buildings');
    const years = built.map(b => b.year).filter(Boolean);
    const disagree = lpcRange
      ? years.some(y => y < lpcRange.from - 1 || y > lpcRange.year + 1)
      : Math.max(...years) - Math.min(...years) > 1;
    if (disagree) {
      conflicts.push({ field: 'Construction date', values: built.map(b => ({ value: b.value, source: b.source })),
        note: 'Sources disagree. LPC dates come from architectural research; PLUTO and footprint years are administrative and often approximate.' });
    }
    const lpc = built.find(b => b.source === 'lpc_buildings');
    const first = lpc || built[0];
    timeline.push({
      date: `${first.from || first.year}-01-01`, precision: 'year',
      date_label: lpc ? lpc.value : String(first.year),
      category: 'construction', certainty: lpc ? 'documented' : 'recorded',
      title: name ? `${name} built` : 'Building constructed',
      detail: [lpcB && !blank(lpcB.arch_build) ? `Architect: ${lpcB.arch_build}.` : '',
        lpcB && !blank(lpcB.own_devel) ? `Original owner/developer: ${lpcB.own_devel}.` : ''].filter(Boolean).join(' '),
      cite: built.map(b => cite(b.source, b.url, b.value)),
    });
  } else {
    gaps.push('No construction date was found in any source.');
  }
  // ---- architecture and use (from the LPC's researched building survey)
  if (lpcB) {
    const arch = lpcB.arch_build;
    if (!blank(arch)) facts.push({ key: 'architect', label: 'Architect', value: arch, cite: [cite('lpc_buildings', recURL(raw.lpc_buildings))] });
    if (!blank(lpcB.own_devel)) facts.push({ key: 'developer', label: 'Original owner / developer', value: lpcB.own_devel, cite: [cite('lpc_buildings', recURL(raw.lpc_buildings))] });
    const style = [lpcB.style_prim, lpcB.style_sec, lpcB.style_oth].filter(s => !blank(s)).join(', ');
    if (style) facts.push({ key: 'style', label: 'Style', value: style, cite: [cite('lpc_buildings', recURL(raw.lpc_buildings))] });
    const mats = [lpcB.mat_prim, lpcB.mat_sec, lpcB.mat_third, lpcB.mat_four, lpcB.mat_other].filter(s => !blank(s)).join(', ');
    if (mats) facts.push({ key: 'materials', label: 'Materials', value: mats, cite: [cite('lpc_buildings', recURL(raw.lpc_buildings))] });
    if (!blank(lpcB.use_orig)) facts.push({ key: 'original_use', label: 'Original use', value: lpcB.use_orig, cite: [cite('lpc_buildings', recURL(raw.lpc_buildings))] });
    if (!blank(lpcB.build_type)) facts.push({ key: 'type', label: 'Building type', value: lpcB.build_type, cite: [cite('lpc_buildings', recURL(raw.lpc_buildings))] });
    for (const [d, a] of [[lpcB.alt_date_1, lpcB.alt_arch_1], [lpcB.alt_date_2, lpcB.alt_arch_2]]) {
      if (blank(d)) continue;
      timeline.push({ date: `${String(d).match(/\d{4}/)?.[0] || d}-01-01`, precision: 'year', date_label: String(d),
        category: 'alteration', certainty: 'documented', title: 'Altered',
        detail: blank(a) ? '' : `Alteration architect: ${a}.`, cite: [cite('lpc_buildings', recURL(raw.lpc_buildings))] });
    }
    if (!blank(lpcB.hist_dist) && !/individual landmark/i.test(lpcB.hist_dist)) {
      facts.push({ key: 'district', label: 'Historic district', value: lpcB.hist_dist, cite: [cite('lpc_buildings', recURL(raw.lpc_buildings))] });
    }
  } else {
    gaps.push('Not in the Landmarks Preservation Commission’s building survey, so the city has no researched architect, style or original-owner data for it.');
  }

  // ---- physical / tax-lot facts
  if (pluto) {
    if (!blank(pluto.numfloors)) facts.push({ key: 'floors', label: 'Floors', value: String(Math.round(Number(pluto.numfloors))), cite: [cite('pluto', recURL(raw.pluto))] });
    if (!blank(pluto.bldgclass)) facts.push({ key: 'class', label: 'Current tax class', value: `${BLDG_CLASS[pluto.bldgclass[0]] || 'Other'} (${pluto.bldgclass})`, cite: [cite('pluto', recURL(raw.pluto))] });
    if (!blank(pluto.bldgarea)) facts.push({ key: 'area', label: 'Floor area', value: `${Number(pluto.bldgarea).toLocaleString('en-US')} sq ft`, cite: [cite('pluto', recURL(raw.pluto))] });
    if (!blank(pluto.ownername)) facts.push({ key: 'owner', label: 'Owner of record (tax roll)', value: pluto.ownername, cite: [cite('pluto', recURL(raw.pluto))] });
    for (const k of ['yearalter1', 'yearalter2']) {
      if (blank(pluto[k])) continue;
      timeline.push({ date: `${pluto[k]}-01-01`, precision: 'year', date_label: String(pluto[k]), category: 'alteration',
        certainty: 'recorded', title: 'Major alteration (tax-lot record)', detail: 'City Planning records a major alteration in this year; the records do not say what changed.',
        cite: [cite('pluto', recURL(raw.pluto))] });
    }
  }
  if (fp && !blank(fp.height_roof)) facts.push({ key: 'height', label: 'Roof height', value: `${Math.round(Number(fp.height_roof))} ft`, cite: [cite('footprints', recURL(raw.footprint))] });

  // ---- landmark designations
  const reports = [];
  const mine = desig.filter(d => d.bin_number === bin || blank(d.bin_number));
  const lotOthers = desig.filter(d => d.bin_number && d.bin_number !== bin);
  const seenLP = new Set();
  for (const d of mine) {
    const key = `${d.lp_number}|${d.lm_type}`;
    if (seenLP.has(key)) continue;
    seenLP.add(key);
    const url = lpReportURL(d.lp_number);
    const status = String(d.status || '').toUpperCase();
    const isDistrict = /district/i.test(d.lm_type || '');
    if (url && !isDistrict) reports.push({ label: `${d.lm_type || 'Designation'} report ${d.lp_number}`, url });
    for (const h of String(d.public_hea || '').split(/;\s*/).map(isoDate).filter(Boolean)) {
      timeline.push({ date: h, precision: 'day', date_label: formatDate(h), category: 'landmark', certainty: 'documented',
        title: `LPC public hearing (${d.lm_type || 'designation'})`, detail: '',
        cite: [cite('lpc_designations', recURL(raw.lpc_designations), d.lp_number)] });
    }
    const dd = isoDate(d.desdate) || isoDate(d.caldate);
    if (status === 'DESIGNATED' && dd) {
      timeline.push({ date: dd, precision: 'day', date_label: formatDate(dd), category: 'landmark', certainty: 'documented',
        title: isDistrict ? `Included in a designated historic district${d.lm_name ? ': ' + d.lm_name : ''}` : `Designated a New York City ${d.lm_type || 'Landmark'}`,
        detail: d.lp_number ? `LPC designation ${d.lp_number}.` : '',
        cite: [cite('lpc_designations', recURL(raw.lpc_designations), d.lp_number), ...(url && !isDistrict ? [cite('lpc_report', url, d.lp_number)] : [])] });
    } else if (status && status !== 'DESIGNATED') {
      timeline.push({ date: dd || null, precision: 'day', date_label: dd ? formatDate(dd) : 'Date not recorded', category: 'landmark', certainty: 'documented',
        title: `Landmark status: ${title(status)} (${d.lm_type || ''})`, detail: '', cite: [cite('lpc_designations', recURL(raw.lpc_designations), d.lp_number)] });
    }
  }
  if (mine.length) {
    facts.push({ key: 'landmark', label: 'Landmark status', value: [...new Set(mine.filter(d => /DESIGNATED/i.test(d.status)).map(d => d.lm_type))].join(', ') || title(mine[0].status), cite: [cite('lpc_designations', recURL(raw.lpc_designations))] });
  } else if (pluto && !blank(pluto.landmark)) {
    facts.push({ key: 'landmark', label: 'Landmark status', value: title(pluto.landmark), cite: [cite('pluto', recURL(raw.pluto))] });
  }
  if (lotOthers.length) {
    gaps.push(`Landmark records on this tax lot also mention another building (BIN ${[...new Set(lotOthers.map(d => d.bin_number))].join(', ')}); those are not shown as this building's history.`);
  }
  // ---- DOB
  const dob = summariseDOB(raw, timeline, gaps);

  // ---- ACRIS ownership
  const ownership = summariseACRIS(raw, timeline, gaps, lot, bbl);

  // ---- photo: at most one, chosen ahead of time from NYPL (scripts/nypl-photos.mjs)
  const media = rows(raw.nypl_photo).map(ph => ({
    title: ph.title, image: ph.image, page: ph.page, date: ph.date, year: Number(String(ph.date || '').slice(0, 4)) || null,
    collection: ph.collection, rights: ph.rights, rights_uri: ph.rights_uri, match: ph.match,
    cite: [cite('nypl', ph.page, [ph.title, ph.date].filter(Boolean).join(', '))],
  }));
  if (!media.length) gaps.push('No public-domain historical image confidently matched to this building in NYPL Digital Collections (only landmarks in the pilot are searched so far). Try the NYPL link under “Dig deeper”.');

  // ---- standing gaps that apply to every building
  gaps.push('Past occupants and businesses: no open city dataset lists them. City directories (NYPL) and newspapers are the likely sources; not yet automated.');

  // ---- sources that failed
  const source_status = sourceStatus(raw);
  for (const s of source_status.filter(s => !s.ok)) gaps.unshift(`${s.label} could not be reached (${s.error}); its records are missing from this page.`);

  timeline.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
  const display = name || (addresses[0]?.address) || identity.label || `BIN ${bin}`;
  const profile = {
    schema_version: SCHEMA_VERSION,
    generated_at: now.toISOString(),
    title: display,
    address: addresses[0]?.address || displayAddress(normalizeAddress(identity.label || '')),
    identity: {
      bin, bbl, pluto_bbl: identity.plutoBBL || bbl, borough: lot?.borough, block: lot?.block, lot: lot?.lot,
      lat: identity.lat, lng: identity.lng, condo: isCondoBillingLot(bbl) || isCondoBillingLot(identity.plutoBBL),
    },
    geometry: identity.geometry || fp?.the_geom || null,
    match_log: identity.match_log || [],
    addresses, facts, timeline, conflicts, gaps,
    dob, ownership, media,
    reports,
    research_links: researchLinks({ bin, lot, name, addresses, lat: identity.lat, lng: identity.lng, builtYear: built.find(b => b.source === 'lpc_buildings')?.from || built[0]?.year }),
    sources: SOURCES,
    source_status,
  };
  profile.narrative = writeNarrative(profile);
  return profile;
}

// Which spelling to show first: the address the user searched for, then the
// landmark survey's address (usually the famous one), then whichever most
// sources agree on.
const ADDR_PRIORITY = { geosearch: 4, lpc_buildings: 3, dob_jobs: 1, lpc_designations: 1, pluto: 1, acris: 1 };
const addrScore = a => a.sources.reduce((s, x) => s + (ADDR_PRIORITY[x] || 1), 0);

const capital = s => String(s || '').replace(/^./, c => c.toUpperCase());

// ---------------------------------------------------------------- DOB

function summariseDOB(raw, timeline, gaps) {
  const byDecade = {};
  const bump = (year, key) => {
    if (!year || year < 1800) return;
    const dec = Math.floor(year / 10) * 10;
    (byDecade[dec] ||= { decade: dec, jobs: 0, violations: 0, ecb: 0, complaints: 0 })[key]++;
  };
  const jobsAll = rows(raw.dob_jobs_all);
  const seenJob = new Set();
  let firstJob = null;
  for (const j of jobsAll) {
    if (seenJob.has(j.job__)) continue;
    seenJob.add(j.job__);
    const d = isoDate(j.pre__filing_date);
    bump(yearOf(d), 'jobs');
    if (d && (!firstJob || d < firstJob)) firstJob = d;
  }
  const nowJobs = new Map();
  for (const j of rows(raw.dob_now_jobs)) {
    const base = String(j.job_filing_number || '').split('-')[0];
    if (!nowJobs.has(base) || /-I1$/.test(j.job_filing_number)) nowJobs.set(base, j);
  }
  for (const j of nowJobs.values()) bump(yearOf(isoDate(j.filing_date)), 'jobs');
  for (const v of rows(raw.dob_violations)) bump(yearOf(isoDate(v.issue_date)), 'violations');
  for (const v of rows(raw.ecb_violations)) bump(yearOf(isoDate(v.issue_date)), 'ecb');
  for (const c of rows(raw.dob_complaints)) bump(yearOf(isoDate(c.date_entered)), 'complaints');

  // Big jobs go on the timeline: new buildings, demolitions, major alterations.
  const JOB_LABEL = { NB: 'New building application filed', DM: 'Demolition application filed', A1: 'Major alteration filed (Alteration Type 1)' };
  const seenMajor = new Set();
  for (const j of rows(raw.dob_jobs_major)) {
    if (seenMajor.has(j.job__)) continue;
    seenMajor.add(j.job__);
    const d = isoDate(j.pre__filing_date);
    const desc = stripHTML(j.job_description);
    timeline.push({ date: d, precision: 'day', date_label: d ? formatDate(d) : 'Undated', category: j.job_type === 'DM' ? 'demolition' : j.job_type === 'NB' ? 'construction' : 'alteration',
      certainty: 'documented', title: JOB_LABEL[j.job_type] || `DOB job ${j.job_type}`,
      detail: [desc ? capital(desc.toLowerCase()) : '', j.job_status_descrp ? `Status: ${title(j.job_status_descrp)}.` : '', !blank(j.initial_cost) && j.initial_cost !== '$0.00' ? `Estimated cost ${j.initial_cost}.` : ''].filter(Boolean).join(' '),
      cite: [cite('dob_jobs', bisJobURL(j.job__), `Job ${j.job__}`)] });
  }
  for (const j of nowJobs.values()) {
    if (!/new building|demolition|alteration co|alt-co/i.test(j.job_type || '')) continue;
    const d = isoDate(j.filing_date);
    timeline.push({ date: d, precision: 'day', date_label: d ? formatDate(d) : 'Undated', category: /demolition/i.test(j.job_type) ? 'demolition' : /new building/i.test(j.job_type) ? 'construction' : 'alteration',
      certainty: 'documented', title: `${j.job_type} filed (DOB NOW)`, detail: stripHTML(j.job_description || ''),
      cite: [cite('dob_now', null, `Filing ${j.job_filing_number}`)] });
  }
  // Certificates of occupancy, grouped per job.
  const coByJob = new Map();
  for (const c of rows(raw.dob_co)) {
    const k = c.job_number || 'unknown';
    if (!coByJob.has(k)) coByJob.set(k, []);
    coByJob.get(k).push(c);
  }
  for (const [job, list] of coByJob) {
    const dates = list.map(c => isoDate(c.c_o_issue_date)).filter(Boolean).sort();
    const finals = list.filter(c => /final/i.test(c.issue_type || ''));
    const first = (finals.length ? finals.map(c => isoDate(c.c_o_issue_date)).filter(Boolean).sort() : dates)[0] || null;
    timeline.push({ date: first, precision: 'day', date_label: first ? formatDate(first) : 'Undated', category: 'occupancy', certainty: 'documented',
      title: finals.length ? 'Final certificate of occupancy issued' : `${list.length} temporary certificate${list.length > 1 ? 's' : ''} of occupancy issued`,
      detail: !finals.length && dates.length > 1 ? `Between ${formatDate(dates[0])} and ${formatDate(dates[dates.length - 1])}, for job ${job}.` : `For job ${job}.`,
      cite: [cite('dob_co', recURL(raw.dob_co), `Job ${job}`)] });
  }
  if (!rows(raw.dob_jobs_major).some(j => j.job_type === 'NB') && ![...nowJobs.values()].some(j => /new building/i.test(j.job_type || ''))) {
    gaps.push(`No new-building permit appears in DOB data. ${firstJob ? `DOB’s searchable job records for this building begin in ${yearOf(firstJob)}` : 'DOB’s searchable job records begin around 1989'}; older permits (including the original construction permit) survive only as scanned papers in DOB’s Building Information System and the Municipal Archives.`);
  }
  const totals = { jobs: seenJob.size + nowJobs.size, violations: rows(raw.dob_violations).length, ecb: rows(raw.ecb_violations).length, complaints: rows(raw.dob_complaints).length, certificates_of_occupancy: rows(raw.dob_co).length };
  return { totals, first_filing: firstJob, by_decade: Object.values(byDecade).sort((a, b) => a.decade - b.decade) };
}

// ---------------------------------------------------------------- ACRIS

function summariseACRIS(raw, timeline, gaps, lot, bbl) {
  const parts = raw.acris?.parts || {};
  const codes = new Map(rows(parts.codes).map(c => [c.doc__type, c]));
  const masters = rows(parts.master);
  const legalsByDoc = new Map();
  for (const l of rows(parts.legals)) {
    if (!legalsByDoc.has(l.document_id)) legalsByDoc.set(l.document_id, []);
    legalsByDoc.get(l.document_id).push(l);
  }
  const partiesByDoc = new Map();
  for (const p of rows(parts.parties)) {
    if (!partiesByDoc.has(p.document_id)) partiesByDoc.set(p.document_id, { 1: [], 2: [], 3: [] });
    (partiesByDoc.get(p.document_id)[p.party_type] ||= []).push(title(p.name));
  }
  const by_class = {};
  const deeds = [];
  let earliest = null;
  const seen = new Set();
  for (const m of masters) {
    if (seen.has(m.document_id)) continue;
    seen.add(m.document_id);
    const code = codes.get(m.doc_type) || {};
    const cls = code.class_code_description || 'OTHER DOCUMENTS';
    by_class[cls] = (by_class[cls] || 0) + 1;
    const d = isoDate(m.document_date) || isoDate(m.recorded_datetime);
    if (d && (!earliest || d < earliest)) earliest = d;
    const legal = legalsByDoc.get(m.document_id) || [];
    const unitOnly = legal.length && legal.every(l => l.unit);
    const partial = legal.some(l => l.partial_lot === 'P');
    if (m.doc_type === 'LDMK') {
      timeline.push({ date: d, precision: 'day', date_label: d ? formatDate(d) : 'Undated', category: 'landmark', certainty: 'documented',
        title: 'Landmark designation recorded with the City Register', detail: `ACRIS document ${m.document_id}.`, cite: [cite('acris', acrisDocURL(m.document_id), `Document ${m.document_id}`)] });
      continue;
    }
    if (cls !== 'DEEDS AND OTHER CONVEYANCES' || /^(RPTT|RETT)/.test(m.doc_type)) continue;
    const p = partiesByDoc.get(m.document_id) || { 1: [], 2: [] };
    const amt = Number(m.document_amt || 0);
    const deed = {
      date: d, doc_type: m.doc_type, doc_type_label: title(code.doc__type_description || m.doc_type), document_id: m.document_id,
      from: p[1] || [], to: p[2] || [], amount: amt > 0 ? amt : null, url: acrisDocURL(m.document_id),
      scope: unitOnly ? `unit ${[...new Set(legal.map(l => l.unit))].join(', ')}` : partial ? 'part of the lot' : 'entire lot',
    };
    deeds.push(deed);
    timeline.push({ date: d, precision: 'day', date_label: d ? formatDate(d) : 'Undated', category: 'ownership', certainty: 'documented',
      title: `${deed.doc_type_label} recorded${deed.scope !== 'entire lot' ? ` (${deed.scope})` : ''}`,
      detail: [deed.from.length ? `From ${deed.from.join('; ')}` : '', deed.to.length ? `to ${deed.to.join('; ')}` : '', deed.amount ? `for $${deed.amount.toLocaleString('en-US')}` : ''].filter(Boolean).join(' ').replace(/\.?$/, deed.from.length || deed.to.length ? '.' : ''),
      cite: [cite('acris', deed.url, `Document ${m.document_id}`)] });
  }
  deeds.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (raw.acris?.ok) {
    gaps.push(earliest
      ? `Online property records (ACRIS) for this lot start in ${yearOf(earliest)}. ACRIS indexes Manhattan documents back to 1966; older deeds are on microfilm at the City Register.`
      : 'No ACRIS property documents were found for this lot.');
    if (!deeds.length && masters.length) gaps.push('No deeds for this lot appear in ACRIS’s data; ownership before the current owner of record is unknown here.');
  }
  return { deeds, documents_by_class: by_class, earliest_document: earliest, total_documents: seen.size, lot: lot ? `Borough ${lot.borough}, Block ${lot.block}, Lot ${lot.lot}` : bbl };
}

// ---------------------------------------------------------------- misc

function sourceStatus(raw) {
  const list = [
    ['footprint', 'footprints'], ['pluto', 'pluto'], ['lpc_buildings', 'lpc_buildings'], ['lpc_designations', 'lpc_designations'],
    ['dob_jobs_all', 'dob_jobs'], ['dob_now_jobs', 'dob_now'], ['dob_co', 'dob_co'], ['dob_violations', 'dob_violations'],
    ['ecb_violations', 'ecb_violations'], ['dob_complaints', 'dob_complaints'], ['acris', 'acris'], ['nypl_photo', 'nypl'],
  ];
  return list.filter(([k]) => raw[k]).map(([k, src]) => {
    const r = raw[k];
    let count = Array.isArray(r.data) ? r.data.length : null;
    if (k === 'acris') count = rows(r.parts?.master).length;
    return { key: k, source: src, label: SOURCES[src].label, ok: !!r.ok, count, error: r.ok ? null : r.error, retrieved_at: r.retrieved_at };
  });
}

// Google "Maps URLs" link (no key needed): opens Street View at the nearest
// panorama to the building. Older dated images are under the clock icon there.
export function streetViewURL(lat, lng) {
  if (lat == null || lng == null) return null;
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
}

function researchLinks({ bin, lot, name, addresses, lat, lng, builtYear }) {
  const links = [];
  const sv = streetViewURL(lat, lng);
  if (sv) links.push({ group: 'See it today', label: 'Google Street View', url: sv, note: 'Opens Google Maps. Use the clock icon there to see older Street View photos, where Google has them' });
  const addr = addresses[0]?.address;
  const from = builtYear ? Math.max(1777, builtYear - 5) : 1880;
  const loc = phrase => `https://www.loc.gov/collections/chronicling-america/?${new URLSearchParams({ q: `"${phrase}"`, dates: `${from}/1963` })}`;
  if (name) links.push({ group: 'Newspapers', label: `Historic newspapers mentioning “${name}”`, url: loc(name), note: 'Library of Congress, Chronicling America (public domain papers to 1963)' });
  if (addr) links.push({ group: 'Newspapers', label: `Historic newspapers mentioning “${addr}”`, url: loc(addr), note: 'Address searches also catch ads and notices' });
  links.push({ group: 'Photos & documents', label: 'NYPL Digital Collections', url: `https://digitalcollections.nypl.org/search/index?${new URLSearchParams({ keywords: name || addr || '' })}`, note: 'Photographs, maps and prints; many are public domain' });
  if (bin) links.push({ group: 'City records', label: 'DOB Building Information System', url: `https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?bin=${bin}`, note: 'Full DOB file, including scanned older certificates of occupancy' });
  if (lot) {
    links.push({ group: 'City records', label: 'ACRIS document search', url: 'https://a836-acris.nyc.gov/DS/DocumentSearch/BBL', note: `Enter Borough ${lot.borough}, Block ${lot.block}, Lot ${lot.lot}` });
    links.push({ group: 'City records', label: 'ZoLa zoning & lot map', url: `https://zola.planning.nyc.gov/l/lot/${lot.borough}/${lot.block}/${lot.lot}`, note: 'Zoning, lot lines, landmark boundaries' });
  }
  return links;
}
