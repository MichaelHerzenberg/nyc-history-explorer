// Decides whether an NYPL catalogue record is really a photograph of a given
// building. Search results are loose: "Empire State Building" also returns the
// unrelated Empire Building, "Brill Building" a fish, "The Windermere" a play,
// "Carnegie Hall" restaurant menus, and old buildings with the same name (the
// 1831 St. Thomas' Church on Broadway). So a photo is accepted only when:
//   1. its title names the building (rules below) and it isn't ephemera;
//   2. it is not dated before the building was built;
//   3. short or generic names also have a New York reference in the title
//      or in NYPL's collection name.
// Pure functions, tested in test/unit.test.mjs.

import { normalizeAddress } from '../web/lib/address.js';

const GENERIC = new Set(['the', 'a', 'of', 'and', 'building', 'buildings', 'house', 'houses', 'hall', 'town', 'church',
  'chapel', 'cathedral', 'club', 'hotel', 'theater', 'theatre', 'school', 'library', 'public', 'company', 'office',
  'apartments', 'apartment', 'tower', 'center', 'residence', 'street', 'avenue', 'new', 'york', 'city', 'former',
  'formerly', 'now', 'saint', 'st', 'national', 'american', 'united', 'states', 'bank', 'store', 'studio', 'studios',
  'annex', 'west', 'east', 'north', 'south', 'branch', 'grand', 'house', 'mansion', 'inc', 'department']);
const STREET_WORDS = new Set(['broadway', 'madison', 'park', 'lexington', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth',
  'third', 'second', 'first', 'tenth', 'americas', 'central', 'avenue', 'street', 'square', 'times', 'herald', 'union',
  'plaza', 'place', 'circle', 'court', 'terrace']);
const AVENUE_WORDS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
// Catalogue titles that are not photographs of a building.
const EPHEMERA = /\[held by\]|\bmenu\b|certificate|\bposter\b|letter-?heads?|stage production|\bprogram(me)?\b|\bticket\b|\binvitation\b/i;
const EPHEMERA_GENRE = /menus|certificates|posters|programs|ephemera|portraits|tickets|invitations|sheet music|letterheads/i;

const words = s => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
const compact = s => words(s).join('').replace(/^the/, '');
// Split a title into clauses so a name never matches across punctuation
// ("Central Park Plaza: Hotel Sherry-Netherland" is not "Plaza Hotel").
const clauses = t => String(t || '').split(/[:;()"[\]]|--|\s-\s|,/).map(compact).filter(Boolean);

const distinctive = s => words(s).filter(w => !GENERIC.has(w));

// "(Former) Yale Club of New York City Building (now Penn Club)" -> "Yale Club of New York City Building"
// "St. Thomas' Church and St. Thomas' Parish House" -> "St. Thomas' Church"
// "New York Public Library, Muhlenberg Branch" -> "New York Public Library Muhlenberg Branch"
export function nameCore(name) {
  const s = String(name || '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = s.split(/,| and (?=[A-Z])/).map(x => x.trim()).filter(Boolean);
  let core = parts[0] || '';
  if (parts[1] && distinctive(core).length === 0 && !/^(now|formerly|later)\b/i.test(parts[1])) core = `${core} ${parts[1]}`;
  return core.replace(/^the\s+/i, '');
}

// Strong names have two or more distinctive words ("Grand Central Terminal" -> central, terminal).
export function isWeakName(core) {
  return distinctive(core).length < 2;
}

export function streetPatterns(address) {
  const n = normalizeAddress(address).replace(/^[\dA-Z-]+\s+/, '').replace(/\b(WEST|EAST|NORTH|SOUTH)\s+/g, '');
  const m = n.match(/^(\d+)\s+(STREET|AVENUE|PLACE)$/);
  if (m) {
    const num = Number(m[1]);
    const kind = m[2] === 'STREET' ? 'st(reet)?' : m[2] === 'AVENUE' ? 'av(e|enue)?' : 'pl(ace)?';
    const alts = [`${num}(st|nd|rd|th)?`];
    if (m[2] === 'AVENUE' && AVENUE_WORDS[num]) alts.push(AVENUE_WORDS[num]);
    return [new RegExp(`\\b(${alts.join('|')})\\.?\\s+${kind}\\b`, 'i')];
  }
  if (!n) return [];
  const w = n.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/);
  if (w.length === 1) return [new RegExp(`\\b${w[0]}\\b`, 'i')]; // e.g. broadway
  const kind = w.pop();
  const k = kind === 'avenue' ? 'av(e|enue)?' : kind === 'street' ? 'st(reet)?' : kind;
  return [new RegExp(`\\b${w.join('\\s+')}\\s+${k}\\b`, 'i')];
}

const NYC_CUE = /\b(new york|n\.\s?y\.?|manhattan|nyc)\b/i;

// Title-only check. Returns { score, rule, needsNYC } or null.
export function matchTitle(title, { name, addresses = [] }) {
  const t = String(title || '');
  if (EPHEMERA.test(t)) return null;
  const core = nameCore(name);
  const streets = addresses.flatMap(streetPatterns);
  const streetHit = streets.some(re => re.test(t));
  // Does the title mention New York apart from inside the building's own name?
  const rest = t.replace(new RegExp(core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  const nyc = NYC_CUE.test(rest) || streetHit;
  const c = compact(core);
  if (c.length >= 6 && clauses(t).some(cl => cl.includes(c))) {
    // A short name must be a whole phrase of the title on its own:
    // "Hotel Chelsea" or "Town Hall, 43rd Street" yes; "Jamaica Town Hall" or
    // "James W. Gerard" (for The Gerard) no.
    if (isWeakName(core) && !clauses(t).some(cl => cl === c)) return null;
    return { score: nyc ? 3 : 2, rule: `title names “${core}”${streetHit ? ' and its street' : nyc ? ' and New York' : ''}`, needsNYC: isWeakName(core) && !nyc };
  }
  // A distinctive word of the name (not a street name) + one of the building's streets.
  const key = distinctive(core).find(w => w.length >= 5 && !STREET_WORDS.has(w) && !AVENUE_WORDS.includes(w));
  // A different house number in the title ("Fifth Avenue, No. 8") means a different building.
  const houseNos = addresses.map(a => (normalizeAddress(a).match(/^(\d+)/) || [])[1]).filter(Boolean);
  const titleNos = [...t.matchAll(/\bNos?\.?\s*(\d+)/gi)].map(x => x[1]);
  const otherNumber = titleNos.length && !titleNos.some(n => houseNos.includes(n));
  if (key && streetHit && !otherNumber && words(t).includes(key)) {
    return { score: 1, rule: `title contains “${key}” and the building’s street`, needsNYC: false };
  }
  return null;
}

// Catalogue-record check, after fetching the item's details.
// record = { year, genre, collection }; builtFrom = first construction year or null.
export function acceptRecord(m, record, builtFrom) {
  if (record.genre && EPHEMERA_GENRE.test(record.genre)) return { ok: false, why: `catalogued as ${record.genre}` };
  if (builtFrom && record.year && record.year < builtFrom - 1) return { ok: false, why: `dated ${record.year}, before the building (${builtFrom})` };
  if (m.needsNYC && !NYC_CUE.test(record.collection || '')) return { ok: false, why: 'no New York reference' };
  return { ok: true };
}
