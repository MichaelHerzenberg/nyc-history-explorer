// NYC History Explorer: map, search and building page.
// All data is fetched live from public sources by the visitor's browser, so
// the site needs no server or database of its own.

import { MAP_START, PILOT_POLYGON, PILOT_WKT, AERIAL_URL, AERIAL_YEARS, AERIAL_CREDIT } from './lib/config.js';
import { resolveBuilding } from './lib/identity.js';
import { gatherRaw, autocomplete, footprintsNear, footprintsInBox, pilotLandmarks, plutoAddresses, searchNewspapers } from './lib/sources.js';
import { buildProfile } from './lib/profile.js';
import { normalizeAddress, displayAddress } from './lib/address.js';

const $ = sel => document.querySelector(sel);
const panel = $('#panel-body');

// ---------------------------------------------------------------- DOM helper
// Builds elements with text content only (never innerHTML), so text from
// outside sources can't inject markup.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href' || k === 'src') { const u = safeURL(v); if (u) el.setAttribute(k, u); }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const safeURL = u => (/^(https?:|#|data\/|blob:)/i.test(String(u || '')) ? String(u) : null);
const ext = (url, ...kids) => h('a', { href: url, target: '_blank', rel: 'noopener' }, ...kids);
const show = (...nodes) => { panel.replaceChildren(...nodes.filter(Boolean)); $('#panel').scrollTop = 0; };

// ---------------------------------------------------------------- map
const map = L.map('map', { zoomControl: true }).setView([MAP_START.lat, MAP_START.lng], MAP_START.zoom);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Building data: NYC Open Data',
}).addTo(map);
const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#9a3b1e';
L.polygon(PILOT_POLYGON.map(([x, y]) => [y, x]), { color: accent, weight: 2, dashArray: '6 6', fill: false, interactive: false })
  .addTo(map).bindTooltip('Midtown pilot area', { sticky: true });

// ---------------------------------------------------------------- aerial photos by year
// "Then and now": lay a historical aerial photo over the street map, pick the
// year with a slider and fade between then and now.
const aerial = { layer: null, year: null, opacity: 0.85 };
const AerialControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const status = h('div', { class: 'aerial-status', 'aria-live': 'polite' });
    const yearOut = h('output', { class: 'aerial-year' }, 'Off');
    const slider = h('input', { type: 'range', min: 0, max: AERIAL_YEARS.length, step: 1, value: 0, 'aria-label': 'Aerial photo year' });
    const fade = h('input', { type: 'range', min: 10, max: 100, step: 5, value: aerial.opacity * 100, 'aria-label': 'Photo opacity', disabled: true });
    slider.addEventListener('input', () => {
      const i = Number(slider.value);
      fade.disabled = i === 0;
      setAerial(i === 0 ? null : AERIAL_YEARS[i - 1], status);
      yearOut.textContent = i === 0 ? 'Off' : String(AERIAL_YEARS[i - 1]);
    });
    fade.addEventListener('input', () => {
      aerial.opacity = Number(fade.value) / 100;
      aerial.layer?.setOpacity(aerial.opacity);
    });
    const box = h('div', { class: 'aerial-control leaflet-bar' },
      h('div', { class: 'aerial-head' }, h('span', {}, 'Aerial photo'), yearOut),
      slider,
      h('div', { class: 'aerial-ticks', 'aria-hidden': 'true' }, h('span', {}, 'Off'), h('span', {}, AERIAL_YEARS[0]), h('span', {}, AERIAL_YEARS[AERIAL_YEARS.length - 1])),
      h('label', { class: 'aerial-fade' }, 'Fade to today ', fade),
      status);
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    return box;
  },
});
function setAerial(year, status) {
  if (aerial.layer) { aerial.layer.remove(); aerial.layer = null; }
  aerial.year = year;
  status.textContent = '';
  if (!year) return;
  let loaded = 0, failed = 0;
  aerial.layer = L.tileLayer(AERIAL_URL.replace('{year}', year), {
    maxZoom: 19, maxNativeZoom: 18, opacity: aerial.opacity,
    attribution: `${year} aerial photo: ${AERIAL_CREDIT[year] || AERIAL_CREDIT.default} (CC BY 4.0)`,
  })
    .on('tileload', () => { loaded++; status.textContent = ''; })
    .on('tileerror', () => {
      failed++;
      if (!loaded && failed >= 4 && aerial.year === year) status.textContent = `The City's ${year} photos didn't load here. Try another year.`;
    })
    .addTo(map);
}
map.addControl(new AerialControl());

const landmarkLayer = L.layerGroup().addTo(map);
const footprintLayer = L.layerGroup().addTo(map);
let selectedLayer = null;

pilotLandmarks(PILOT_WKT).then(list => {
  const seen = new Set();
  for (const l of list) {
    if (!l.latitude || seen.has(l.bin_number)) continue;
    seen.add(l.bin_number);
    L.circleMarker([+l.latitude, +l.longitude], { radius: 5, color: '#fff', weight: 1.5, fillColor: accent, fillOpacity: 0.9 })
      .bindTooltip(l.lm_name || 'Landmark')
      .on('click', () => go({ bin: l.bin_number }))
      .addTo(landmarkLayer);
  }
}).catch(() => { /* the map still works without the landmark dots */ });

// Outlines of every building become clickable once zoomed in.
let fpTimer = null, fpRequest = 0;
map.on('moveend', () => {
  clearTimeout(fpTimer);
  if (map.getZoom() < 17) { footprintLayer.clearLayers(); return; }
  fpTimer = setTimeout(async () => {
    const req = ++fpRequest;
    const b = map.getBounds();
    try {
      const gj = await footprintsInBox(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
      if (req !== fpRequest) return;
      footprintLayer.clearLayers();
      L.geoJSON(gj, {
        style: { color: accent, weight: 1, fillOpacity: 0.08 },
        onEachFeature: (f, layer) => {
          const p = f.properties || {};
          layer.bindTooltip(p.name || `Built ${p.construction_year || '?'}`, { sticky: true });
          layer.on('click', e => { L.DomEvent.stopPropagation(e); go({ bin: p.bin }); });
        },
      }).addTo(footprintLayer);
    } catch { /* ignore; user can still search */ }
  }, 350);
});

map.on('click', e => {
  if (map.getZoom() < 16) {
    L.popup().setLatLng(e.latlng).setContent('Zoom in to pick a single building.').openOn(map);
    return;
  }
  go({ lat: e.latlng.lat, lng: e.latlng.lng });
});

function highlight(profile) {
  if (selectedLayer) selectedLayer.remove();
  selectedLayer = null;
  if (profile.geometry) {
    selectedLayer = L.geoJSON(profile.geometry, { style: { color: accent, weight: 3, fillOpacity: 0.25 }, interactive: false }).addTo(map);
    map.fitBounds(selectedLayer.getBounds(), { maxZoom: 18, padding: [30, 30] });
  } else if (profile.identity.lat) {
    selectedLayer = L.circleMarker([profile.identity.lat, profile.identity.lng], { radius: 9, color: accent }).addTo(map);
    map.setView([profile.identity.lat, profile.identity.lng], 18);
  }
}

// ---------------------------------------------------------------- routing
function go(query) {
  if (query.bin) location.hash = `bin=${encodeURIComponent(query.bin)}`;
  else if (query.text) location.hash = `q=${encodeURIComponent(query.text)}`;
  else loadBuilding(query);
}
window.addEventListener('hashchange', route);
function route() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('bin')) loadBuilding({ bin: p.get('bin') });
  else if (p.get('q')) { $('#q').value = p.get('q'); loadBuilding({ text: p.get('q') }); }
  else showIntro();
}

// ---------------------------------------------------------------- search box
const input = $('#q'), sugg = $('#suggestions');
let acTimer = null, acItems = [], acIndex = -1;
input.addEventListener('input', () => {
  clearTimeout(acTimer);
  const text = input.value.trim();
  if (text.length < 3) { sugg.hidden = true; return; }
  acTimer = setTimeout(async () => {
    try {
      const r = await autocomplete(text);
      acItems = (r.features || []).filter(f => f.properties.borough === 'Manhattan' || /New York, NY/.test(f.properties.label)).slice(0, 6);
      if (!acItems.length) acItems = (r.features || []).slice(0, 6);
      acIndex = -1;
      sugg.replaceChildren(...acItems.map((f, i) => h('li', { role: 'option', id: `s${i}`, onmousedown: ev => { ev.preventDefault(); pick(i); } },
        f.properties.label.replace(/, USA$/, ''))));
      sugg.hidden = !acItems.length;
    } catch { sugg.hidden = true; }
  }, 200);
});
input.addEventListener('keydown', e => {
  if (sugg.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    acIndex = (acIndex + (e.key === 'ArrowDown' ? 1 : -1) + acItems.length) % acItems.length;
    [...sugg.children].forEach((li, i) => li.setAttribute('aria-selected', i === acIndex));
  } else if (e.key === 'Enter' && acIndex >= 0) { e.preventDefault(); pick(acIndex); }
  else if (e.key === 'Escape') sugg.hidden = true;
});
input.addEventListener('blur', () => setTimeout(() => { sugg.hidden = true; }, 150));
function pick(i) {
  const f = acItems[i];
  sugg.hidden = true;
  input.value = f.properties.label.replace(/, USA$/, '');
  const bin = f.properties.addendum?.pad?.bin;
  if (bin && !/^\d000000$/.test(bin)) go({ bin }); else go({ text: input.value });
}
$('#search').addEventListener('submit', e => {
  e.preventDefault();
  sugg.hidden = true;
  const text = input.value.trim();
  if (text) go({ text: /manhattan|new york|, ny/i.test(text) ? text : `${text}, Manhattan` });
});

// ---------------------------------------------------------------- near me
$('#nearme').addEventListener('click', () => {
  if (!navigator.geolocation) { show(errorBox('This browser cannot share its location.')); return; }
  show(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Finding your location… (your browser will ask permission)'));
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    L.circle([lat, lng], { radius: Math.min(accuracy, 200), color: accent, weight: 1, fillOpacity: 0.1 }).addTo(map);
    map.setView([lat, lng], 18);
    try {
      // Phones are often 10–50 m off in Midtown's canyons, so search a little wider than the reported accuracy.
      const radius = Math.max(40, Math.min(150, Math.round(accuracy * 1.5)));
      const near = await footprintsNear(lat, lng, radius);
      if (!near.length) { show(errorBox(`No buildings found within ${radius} m of you.`)); return; }
      const addrs = await plutoAddresses([...new Set(near.map(b => b.mappluto_bbl || b.base_bbl).filter(Boolean))]).catch(() => []);
      const addrBy = new Map(addrs.map(a => [String(a.bbl).split('.')[0], a.address]));
      const dist = b => { const [x, y] = centroidOf(b.the_geom); return metres(lat, lng, y, x); };
      near.sort((a, b) => dist(a) - dist(b));
      show(h('div', {},
        h('h2', {}, 'Buildings near you'),
        h('p', { class: 'src' }, `Within about ${radius} m (your location is accurate to ±${Math.round(accuracy)} m). Nearest first. Corner and multi-entrance buildings may appear once per address lot.`),
        h('ul', { class: 'pick' }, near.slice(0, 15).map(b => h('li', {}, h('button', { onclick: () => go({ bin: b.bin }) },
          h('div', {}, b.name || displayAddress(normalizeAddress(addrBy.get(String(b.mappluto_bbl || b.base_bbl)) || '')) || `Building ${b.bin}`),
          h('div', { class: 'sub' }, [addrBy.get(String(b.mappluto_bbl || b.base_bbl)) && b.name ? displayAddress(normalizeAddress(addrBy.get(String(b.mappluto_bbl || b.base_bbl)))) : null,
            b.construction_year ? `built ${b.construction_year}` : null, `${Math.round(dist(b))} m away`].filter(Boolean).join(' · ')))))),
      ));
    } catch (err) { show(errorBox('Could not look up nearby buildings: ' + err.message)); }
  }, err => show(errorBox(err.code === 1 ? 'Location permission was declined. You can still search by address or tap the map.' : 'Could not get your location: ' + err.message)),
  { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
});
const centroidOf = g => { const r = g.type === 'MultiPolygon' ? g.coordinates[0][0] : g.coordinates[0]; const p = r.slice(0, -1); return [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length]; };
const metres = (la1, lo1, la2, lo2) => { const R = 6371000, r = Math.PI / 180; const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r; const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); };

// ---------------------------------------------------------------- loading a building
let loadToken = 0;
let current = null;
async function loadBuilding(query) {
  const token = ++loadToken;
  const prog = h('progress', { max: 13, value: 0 });
  const msg = h('span', {}, 'Identifying the building…');
  show(h('div', {}, h('div', { class: 'loading' }, h('div', { class: 'spinner' }), msg), prog));
  try {
    const { identity, raw: idRaw } = await resolveBuilding(query);
    if (token !== loadToken) return;
    msg.textContent = `Gathering records for BIN ${identity.bin}…`;
    const raw = { ...idRaw, ...(await gatherRaw(identity, { onProgress: (d, n) => { prog.max = n; prog.value = d; } })) };
    if (token !== loadToken) return;
    const profile = buildProfile(identity, raw);
    current = { profile, raw };
    renderProfile(profile, raw);
    highlight(profile);
    document.title = `${profile.title} · NYC History Explorer`;
  } catch (err) {
    if (token !== loadToken) return;
    // Offline or a source outage: fall back to a saved snapshot if we have one.
    if (query.bin) {
      try {
        const res = await fetch(`data/buildings/${encodeURIComponent(query.bin)}.json`);
        if (res.ok) {
          const profile = await res.json();
          renderProfile(profile, null, `Live sources could not be reached (${err.message}). Showing a saved copy from ${new Date(profile.generated_at).toLocaleDateString()}.`);
          highlight(profile);
          return;
        }
      } catch { /* fall through */ }
    }
    show(errorBox(err.message));
  }
}

function errorBox(text) {
  return h('div', {}, h('div', { class: 'notice' }, text), h('p', {}, h('a', { href: '#' }, '← Back to start')));
}

// ---------------------------------------------------------------- intro
function showIntro() {
  document.title = 'NYC History Explorer';
  show(h('div', { class: 'intro' },
    h('h1', {}, 'The history of New York, one building at a time'),
    h('p', {}, 'Search an address, tap a building on the map, or use “Near me” while you walk. We gather official city records, landmark reports and property documents, and assemble them into a sourced timeline with full citations.'),
    h('div', { class: 'try' },
      h('button', { class: 'btn', onclick: () => go({ bin: '1015862' }) }, 'Try the Empire State Building'),
      h('button', { class: 'btn btn-quiet', onclick: () => go({ bin: '1022581' }) }, 'One Times Square')),
    h('p', { class: 'src' }, 'Pilot area: Midtown Manhattan, 23rd–59th Streets, 3rd–9th Avenues (dashed outline). Red dots are designated landmarks. Zoom in to click any building. Search works across the whole city.'),
    h('div', { class: 'method' }, 'How to read this site: every statement links to its source. ',
      h('b', {}, 'Documented'), ' = official record or landmark research. ',
      h('b', {}, 'Recorded'), ' = administrative city data (often approximate). ',
      'Community-edited sites such as Wikipedia are not used.'),
  ));
}

// ---------------------------------------------------------------- building page
const CERT = { documented: 'Documented', recorded: 'Recorded' };
const FILTERS = [
  ['all', 'All'], ['building', 'Building & alterations'], ['landmark', 'Landmark'],
  ['ownership', 'Ownership'], ['occupancy', 'Occupancy'],
];
const filterOf = c => (['construction', 'alteration', 'demolition'].includes(c) ? 'building' : c);

function renderProfile(p, raw, warning) {
  const srcLink = c => {
    const s = p.sources[c.source];
    return ext(c.url || s?.url, s?.label || c.source);
  };
  const srcLine = cites => h('div', { class: 'src' }, 'Source: ', cites.map((c, i) => [i ? ' · ' : '', srcLink(c), c.note && c.note !== p.sources[c.source]?.label ? ` (${c.note})` : '']));

  const badges = [];
  const lm = p.facts.find(f => f.key === 'landmark');
  if (lm) badges.push(h('span', { class: 'badge lm' }, lm.value));
  const built = p.facts.find(f => f.key === 'built');
  if (built) badges.push(h('span', { class: 'badge' }, `Built ${built.value}`));
  badges.push(h('span', { class: 'badge' }, `BIN ${p.identity.bin}`), h('span', { class: 'badge' }, `BBL ${p.identity.bbl}`));
  if (p.identity.condo) badges.push(h('span', { class: 'badge' }, 'Condominium'));

  // Story
  const fnLink = n => h('sup', { class: 'fn' }, h('a', { href: `#cite-${n}`, onclick: e => { e.preventDefault(); document.getElementById(`cite-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); } }, `[${n}]`));
  const story = h('section', { class: 'block story' }, h('h2', {}, 'The story so far'),
    p.narrative.paragraphs.map(para => [
      p.narrative.paragraphs.length > 1 ? h('h3', {}, para.heading) : null,
      h('p', {}, para.sentences.map(s => [s.text, s.refs.map(fnLink), ' '])),
    ]),
    h('p', { class: 'method' }, p.narrative.method),
    h('h3', {}, `Citations (${p.narrative.citations.length})`),
    h('ol', { class: 'citations' }, p.narrative.citations.map((c, i) => h('li', { id: `cite-${i + 1}` },
      h('b', {}, c.label || c.source), c.publisher ? `, ${c.publisher}` : '', c.note ? `. ${c.note}` : '',
      c.accessed ? `. Accessed ${c.accessed}. ` : '. ', ext(c.url, c.url)))));

  // Photo (one per building, from NYPL)
  const ph = p.media?.[0];
  const photo = ph ? h('section', { class: 'block' }, h('h2', {}, 'Historical image'),
    h('figure', { class: 'photo' },
      ext(ph.page, h('img', { src: ph.image, alt: ph.title, loading: 'lazy' })),
      h('figcaption', {}, h('b', {}, ph.title), ph.date ? ` (${ph.date})` : '', h('br'),
        'From The New York Public Library', ph.collection ? `, ${ph.collection}` : '', '. ',
        ph.rights_uri ? ext(ph.rights_uri, 'Public domain (rights statement)') : 'Public domain', ' · ', ext(ph.page, 'View at NYPL'), h('br'),
        h('span', { class: 'src' }, `Matched automatically because the ${ph.match}. Please report a wrong match.`)))) : null;

  // Timeline with filters
  const tl = h('ol', { class: 'timeline' });
  const renderTL = f => tl.replaceChildren(...p.timeline.filter(e => f === 'all' || filterOf(e.category) === f).map(e =>
    h('li', { class: e.certainty },
      h('div', { class: 'tl-date' }, e.date_label, h('span', { class: `cert ${e.certainty}` }, CERT[e.certainty])),
      h('div', { class: 'tl-title' }, e.title),
      e.detail ? h('div', { class: 'tl-detail' }, e.detail) : null,
      srcLine(e.cite))));
  const present = new Set(p.timeline.map(e => filterOf(e.category)));
  const chips = h('div', { class: 'chips', role: 'toolbar', 'aria-label': 'Filter timeline' },
    FILTERS.filter(([k]) => k === 'all' || present.has(k)).map(([k, label]) => h('button', {
      class: 'chip', 'aria-pressed': k === 'all' ? 'true' : 'false',
      onclick: ev => { chips.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false')); ev.currentTarget.setAttribute('aria-pressed', 'true'); renderTL(k); },
    }, label)));
  renderTL('all');
  const timeline = h('section', { class: 'block' }, h('h2', {}, `Timeline (${p.timeline.length})`),
    h('p', { class: 'legend' }, '● Documented: official record   ○ Recorded: administrative data (often approximate)'),
    chips, p.timeline.length ? tl : h('p', {}, 'No dated events were found in the available records.'));

  // Facts
  const facts = h('section', { class: 'block' }, h('h2', {}, 'Key facts'),
    h('dl', { class: 'facts' }, p.facts.map(f => [h('dt', {}, f.label), h('dd', {}, f.value, srcLine(f.cite))])));

  // Conflicts and gaps
  const unknowns = h('section', { class: 'block' }, h('h2', {}, 'What we don’t know (yet)'),
    p.conflicts.map(c => h('div', { class: 'notice' }, h('b', {}, `Conflicting records: ${c.field}. `),
      c.values.map((v, i) => [i ? '; ' : '', `${v.value} (${p.sources[v.source]?.label || v.source})`]), '. ', c.note || '')),
    h('ul', { class: 'plain' }, p.gaps.map(g => h('li', {}, g))));

  // Records at a glance
  const t = p.dob.totals;
  const maxDec = Math.max(1, ...p.dob.by_decade.map(d => d.jobs + d.violations + d.ecb + d.complaints));
  const records = h('section', { class: 'block' }, h('h2', {}, 'City records at a glance'),
    h('table', { class: 'mini' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Decade'), h('th', { class: 'num' }, 'DOB jobs'), h('th', { class: 'num' }, 'Violations'), h('th', { class: 'num' }, 'ECB'), h('th', { class: 'num' }, 'Complaints'), h('th', {}, ''))),
      h('tbody', {}, p.dob.by_decade.map(d => h('tr', {}, h('td', {}, `${d.decade}s`), h('td', { class: 'num' }, d.jobs.toLocaleString()), h('td', { class: 'num' }, d.violations.toLocaleString()), h('td', { class: 'num' }, d.ecb.toLocaleString()), h('td', { class: 'num' }, d.complaints.toLocaleString()),
        h('td', {}, h('span', { class: 'bar', style: `width:${Math.round(60 * (d.jobs + d.violations + d.ecb + d.complaints) / maxDec)}px` })))))),
    h('p', { class: 'src' }, `Totals: ${t.jobs.toLocaleString()} job filings, ${t.violations.toLocaleString()} DOB violations, ${t.ecb.toLocaleString()} ECB violations, ${t.complaints.toLocaleString()} complaints, ${t.certificates_of_occupancy} certificates of occupancy. Electronic DOB data starts around 1989.`),
    h('details', {}, h('summary', {}, `Property documents in ACRIS (${p.ownership.total_documents})`),
      h('p', { class: 'src' }, p.ownership.lot),
      h('ul', { class: 'plain' }, Object.entries(p.ownership.documents_by_class).map(([k, n]) => h('li', {}, `${k.toLowerCase()}: ${n}`))),
      p.ownership.deeds.length ? h('table', { class: 'mini' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Type'), h('th', {}, 'From → To'))),
        h('tbody', {}, p.ownership.deeds.map(d => h('tr', {}, h('td', {}, d.date || '—'), h('td', {}, ext(d.url, d.doc_type_label)),
          h('td', {}, `${d.from.join('; ') || '?'} → ${d.to.join('; ') || '?'}`))))) : null));

  // Dig deeper
  const groups = {};
  for (const l of p.research_links) (groups[l.group] ||= []).push(l);
  const newsOut = h('div', {});
  const name = p.title !== p.address ? p.title : null;
  const from = Math.max(1777, (parseInt(p.facts.find(f => f.key === 'built')?.value, 10) || 1885) - 5);
  const newsBtn = h('button', { class: 'btn btn-quiet', onclick: async () => {
    newsBtn.disabled = true;
    newsOut.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spinner' }), 'Searching the Library of Congress…'));
    const r = await searchNewspapers(name || p.address, from, 1963);
    if (!r.ok) { newsOut.replaceChildren(h('p', { class: 'src' }, `The Library of Congress did not answer (${r.error}). Use the newspaper links above instead.`)); return; }
    const results = (r.data.results || []).filter(x => x.url || x.id);
    newsOut.replaceChildren(h('p', { class: 'src' }, `${r.data.pagination?.of?.toLocaleString?.() ?? results.length} page(s) contain the phrase. These are keyword matches: read each to confirm it is about this building.`),
      h('ul', { class: 'plain' }, results.map(x => h('li', {}, ext(x.url || x.id, x.title || 'Newspaper page'), x.date ? ` · ${x.date}` : ''))));
  } }, `Search old newspapers for “${name || p.address}”`);
  const deeper = h('section', { class: 'block' }, h('h2', {}, 'Dig deeper'),
    p.reports.length ? h('p', {}, 'Landmark designation reports: ', p.reports.map((r, i) => [i ? ' · ' : '', ext(r.url, r.label + ' (PDF)')])) : null,
    Object.entries(groups).map(([g, ls]) => [h('h3', {}, g), h('ul', { class: 'plain' }, ls.map(l => h('li', {}, ext(l.url, l.label), l.note ? h('span', { class: 'src' }, ` · ${l.note}`) : null)))]),
    newsBtn, newsOut);

  // How we matched + sources
  const how = h('section', { class: 'block' }, h('h2', {}, 'How this page was assembled'),
    h('details', {}, h('summary', {}, 'How the building was identified'),
      h('ul', { class: 'plain' }, p.match_log.map(m => h('li', {}, h('b', {}, m.step + ': '), m.detail))),
      h('p', { class: 'src' }, 'Also known at: ', p.addresses.map((a, i) => [i ? '; ' : '', a.address, ` (${a.sources.map(s => p.sources[s]?.label || s).join(', ')})`]))),
    h('details', {}, h('summary', {}, 'Sources checked'),
      h('table', { class: 'mini' }, h('tbody', {}, p.source_status.map(s => h('tr', {},
        h('td', { class: s.ok ? 'status-ok' : 'status-bad' }, s.ok ? '✓' : '✗'),
        h('td', {}, ext(p.sources[s.source]?.url, s.label)),
        h('td', { class: 'num' }, s.ok ? `${s.count ?? '—'}` : s.error)))))),
    h('p', { class: 'src' }, `Assembled ${new Date(p.generated_at).toLocaleString()} from live public data. `,
      h('a', { href: '#', onclick: e => { e.preventDefault(); download(`${p.identity.bin}-profile.json`, p); } }, 'Download this profile (JSON)'),
      raw ? [' · ', h('a', { href: '#', onclick: e => { e.preventDefault(); download(`${p.identity.bin}-raw-sources.json`, raw); } }, 'Download raw source data')] : null));

  show(
    warning ? h('div', { class: 'notice' }, warning) : null,
    h('h1', { class: 'bname' }, p.title),
    p.title !== p.address ? h('p', { class: 'addr' }, p.address, ', Manhattan') : null,
    h('div', { class: 'badges' }, badges),
    story, photo, timeline, facts, unknowns, records, deeper, how,
  );
}

function download(name, obj) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

route();
