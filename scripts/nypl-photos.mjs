#!/usr/bin/env node
// Finds the single best public-domain NYPL photograph for each landmark in
// the Midtown pilot and saves it to web/data/nypl-photos.json, which the
// website reads. The NYPL API key is used only here, never on the public
// site, and is never written to the repository.
//
//   NYPL_TOKEN=xxxx node scripts/nypl-photos.mjs
//   node scripts/nypl-photos.mjs --token-file /path/to/token   (file holds just the token)
//   options: --max-requests 1000   hard cap on API calls this run (NYPL allows 10,000/day)
//            --refresh             re-check buildings already in the file
//            --limit 20            only the first N unchecked buildings
//
// Cost per building: 1 search, plus up to 4 catalogue lookups to confirm a candidate.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pilotLandmarks, soqlURL } from '../web/lib/sources.js';
import { PILOT_WKT, DATASETS } from '../web/lib/config.js';
import { isPlaceholderBIN } from '../web/lib/address.js';
import { matchTitle, acceptRecord } from './photo-match.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'web/data/nypl-photos.json');
const API = 'https://api.repo.nypl.org/api/v2';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const tokenFile = opt('--token-file');
const token = (process.env.NYPL_TOKEN || (tokenFile ? await readFile(tokenFile, 'utf8') : '')).trim();
if (!token) { console.error('No NYPL API token. Set NYPL_TOKEN or use --token-file.'); process.exit(1); }
const maxRequests = Number(opt('--max-requests', 1000));
const limit = Number(opt('--limit', Infinity));
const refresh = args.includes('--refresh');

let requests = 0;
async function nypl(path, params = {}) {
  if (requests >= maxRequests) throw Object.assign(new Error('request cap reached'), { cap: true });
  requests++;
  const url = `${API}/${path}${Object.keys(params).length ? '?' + new URLSearchParams(params) : ''}`;
  const res = await fetch(url, { headers: { Authorization: `Token token="${token}"`, 'User-Agent': 'NYCHistoryExplorer/0.1 (https://github.com/MichaelHerzenberg/nyc-history-explorer)' } });
  if (res.status === 401) throw new Error('NYPL rejected the token (HTTP 401)');
  if (res.status === 429) throw Object.assign(new Error('NYPL daily limit reached (HTTP 429)'), { cap: true });
  if (!res.ok) throw new Error(`NYPL HTTP ${res.status}`);
  return (await res.json()).nyplAPI;
}
const asList = x => (Array.isArray(x) ? x : x ? [x] : []);
const text = v => (v == null ? null : typeof v === 'string' ? v : v.$ ?? null);

let store = { photos: {}, checked: {} };
try { store = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* first run */ }

const landmarks = await pilotLandmarks(PILOT_WKT);
const byBin = new Map();
for (const l of landmarks) {
  if (!l.bin_number || isPlaceholderBIN(l.bin_number)) continue;
  const b = byBin.get(l.bin_number) || { bin: l.bin_number, name: l.lm_name, addresses: new Set() };
  if (l.desig_addr) b.addresses.add(l.desig_addr);
  byBin.set(l.bin_number, b);
}
// Construction start years from the LPC survey (NYC Open Data; doesn't use the NYPL quota).
const bins = [...byBin.keys()];
for (let i = 0; i < bins.length; i += 80) {
  const url = soqlURL(DATASETS.lpcBuildings, { $select: 'bin,date_low', $where: `bin in (${bins.slice(i, i + 80).map(b => `'${b}'`).join(',')})`, $limit: '1000' });
  for (const r of await (await fetch(url)).json()) {
    const y = Number(r.date_low);
    if (y > 1600 && byBin.has(r.bin)) byBin.get(r.bin).builtFrom = y;
  }
}

const todo = [...byBin.values()].filter(b => refresh || !store.checked[b.bin]).slice(0, limit);
console.log(`${byBin.size} pilot landmarks; ${todo.length} to check; request cap ${maxRequests}.`);

let found = 0;
for (const b of todo) {
  try {
    const query = b.name.replace(/\([^)]*\)/g, ' ').trim();
    const r = await nypl('items/search', { q: query, field: 'title', publicDomainOnly: 'true', per_page: '50' });
    const candidates = asList(r.response?.result)
      .filter(x => x.typeOfResource === 'still image' && x.imageID)
      .map((x, rank) => ({ x, rank, m: matchTitle(x.title, { name: b.name, addresses: [...b.addresses] }) }))
      .filter(c => c.m)
      .sort((a, c) => c.m.score - a.m.score || a.rank - c.rank);
    store.checked[b.bin] = new Date().toISOString().slice(0, 10);
    // Confirm candidates against their catalogue records (date, genre, collection).
    let chosen = null;
    const rejected = [];
    const badTitles = new Set();
    let checks = 0;
    for (const c of candidates) {
      if (checks >= 4) break;
      if (badTitles.has(c.x.title)) continue; // identical titles are usually more of the same (e.g. menus)
      checks++;
      const mods = (await nypl(`items/mods/${c.x.uuid}`)).response?.mods || {};
      const oi = asList(mods.originInfo)[0] || {};
      const date = text(asList(oi.dateIssued)[0]) || text(asList(oi.dateCreated)[0]) || text(asList(oi.dateOther)[0]);
      const year = Number(String(date || '').match(/\b(1[6-9]\d\d|20\d\d)\b/)?.[1]) || null;
      const genre = asList(mods.genre).map(text).filter(Boolean).join('; ') || null;
      const chain = [];
      let host = mods.relatedItem;
      while (host && chain.length < 4) { const t = text(host.titleInfo?.title); if (t) chain.push(t); host = host.relatedItem; }
      const collection = chain.reverse().join(' › ') || null;
      const verdict = acceptRecord(c.m, { year, genre, collection }, b.builtFrom);
      if (verdict.ok) { chosen = { c, date, year, collection }; break; }
      badTitles.add(c.x.title);
      rejected.push(`“${c.x.title.slice(0, 60)}” (${verdict.why})`);
    }
    if (!chosen) {
      delete store.photos[b.bin];
      console.log(`  – ${b.name}: no confident match${rejected.length ? '; rejected ' + rejected.join(', ') : ''}`);
      continue;
    }
    const best = chosen.c.x;
    const { date, collection } = chosen;
    store.photos[b.bin] = {
      bin: b.bin, building: b.name, built_from: b.builtFrom || null, title: best.title, date, collection,
      image_id: best.imageID, uuid: best.uuid,
      image: `https://images.nypl.org/index.php?id=${encodeURIComponent(best.imageID)}&t=w`,
      page: `https://digitalcollections.nypl.org/items/${best.uuid}`,
      rights: best.rightsStatement || null, rights_uri: best.rightsStatementURI || null,
      match: chosen.c.m.rule, query,
    };
    found++;
    console.log(`  ✓ ${b.name}: “${best.title}”${date ? ` (${date})` : ''}`);
  } catch (err) {
    console.log(`  ✗ ${b.name}: ${err.message}`);
    if (err.cap || /token/.test(err.message)) break;
  }
  await new Promise(res => setTimeout(res, 300));
}

store.generated_at = new Date().toISOString();
store.source = 'NYPL Digital Collections API, public-domain still images only; one photo per building chosen by title match (scripts/photo-match.mjs).';
await writeFile(OUT, JSON.stringify(store, null, 1));
console.log(`\nDone: ${found} new photos, ${Object.keys(store.photos).length} buildings with a photo in total. API requests used this run: ${requests}.`);
