// Address normalisation. City datasets spell the same address many ways:
// "350 Fifth Avenue", "350 5 AVENUE", "350 FIFTH AVE", "W 33RD ST".
// normalizeAddress() turns them all into one comparable form, e.g.
// "350 5 AVENUE" and "33 WEST 33 STREET".

const ORDINAL_WORDS = {
  FIRST: '1', SECOND: '2', THIRD: '3', FOURTH: '4', FIFTH: '5', SIXTH: '6',
  SEVENTH: '7', EIGHTH: '8', NINTH: '9', TENTH: '10', ELEVENTH: '11', TWELFTH: '12',
};

const WORDS = {
  AVE: 'AVENUE', AV: 'AVENUE', AVENUE: 'AVENUE',
  ST: 'STREET', STR: 'STREET', STREET: 'STREET',
  PL: 'PLACE', PLZ: 'PLAZA', SQ: 'SQUARE', BLVD: 'BOULEVARD', BWAY: 'BROADWAY',
  RD: 'ROAD', DR: 'DRIVE', LN: 'LANE', TER: 'TERRACE', PKWY: 'PARKWAY',
  W: 'WEST', E: 'EAST', N: 'NORTH', S: 'SOUTH',
  AMERICAS: 'AMERICAS',
};

export function normalizeAddress(input) {
  if (!input) return '';
  let s = String(input).toUpperCase();
  s = s.split(',')[0];                      // drop ", New York, NY, USA"
  s = s.replace(/[.#]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = s.split(' ').map((t, i, all) => {
    if (ORDINAL_WORDS[t]) return ORDINAL_WORDS[t];
    const ord = t.match(/^(\d+)(ST|ND|RD|TH)$/);
    if (ord) return ord[1];
    // "ST" straight after the house number and before a name is SAINT
    // ("4 ST MARKS PLACE"); everywhere else it is STREET.
    if (t === 'ST' && i === 1 && /^\d/.test(all[0]) && all[i + 1] && !/^\d/.test(all[i + 1])) {
      return 'SAINT';
    }
    return WORDS[t] || t;
  });
  let out = tokens.join(' ');
  out = out.replace(/\bAVENUE OF THE AMERICAS\b/, '6 AVENUE');
  return out;
}

// Pull the house number off a normalised address ("350 5 AVENUE" -> "350").
export function houseNumber(normalized) {
  const m = String(normalized).match(/^(\d+[A-Z]?(?:-\d+)?)\s/);
  return m ? m[1] : null;
}

// BBL = borough (1 digit) + block (5) + lot (4). Manhattan is borough 1.
export function splitBBL(bbl) {
  const s = String(bbl || '').split('.')[0];
  if (!/^\d{10}$/.test(s)) return null;
  return { borough: s[0], block: String(Number(s.slice(1, 6))), lot: String(Number(s.slice(6))) };
}

// Condominium "billing" lots are numbered 7501–7599. Their individual units
// carry separate lots, which matters for ownership records.
export function isCondoBillingLot(bbl) {
  const p = splitBBL(bbl);
  return !!p && Number(p.lot) >= 7501 && Number(p.lot) <= 7599;
}

// BINs ending in 000000 (e.g. 1000000) are DOB placeholders, not real buildings.
export function isPlaceholderBIN(bin) {
  return /^[1-5]000000$/.test(String(bin || ''));
}

// Human-friendly form of a normalised address:
// "350 5 AVENUE" -> "350 Fifth Avenue", "33 WEST 33 STREET" -> "33 West 33rd Street".
const AVENUE_WORDS = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth', 'Eleventh', 'Twelfth'];
const ordinal = n => (n % 100 >= 11 && n % 100 <= 13 ? `${n}th` : n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'));

export function displayAddress(normalized) {
  const t = String(normalized || '').split(' ').filter(Boolean);
  return t.map((w, i) => {
    if (i === 0 && /^\d/.test(w)) return w;
    if (/^\d+$/.test(w)) {
      const n = Number(w), next = t[i + 1];
      if (next === 'AVENUE' && n <= 12) return AVENUE_WORDS[n];
      if (['STREET', 'AVENUE', 'PLACE', 'DRIVE', 'ROAD'].includes(next)) return ordinal(n);
      return w;
    }
    return w[0] + w.slice(1).toLowerCase();
  }).join(' ');
}
