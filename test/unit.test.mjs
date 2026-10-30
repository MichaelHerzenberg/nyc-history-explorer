// Offline tests: no internet needed. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeAddress, displayAddress, splitBBL, isCondoBillingLot, isPlaceholderBIN } from '../web/lib/address.js';
import { buildProfile, isoDate, formatDate, SOURCES } from '../web/lib/profile.js';

const fixture = () => JSON.parse(readFileSync(new URL('./fixtures/1015862.raw.json', import.meta.url)));

test('address spellings from different agencies normalise to one form', () => {
  const same = ['350 Fifth Avenue', '350 5 AVENUE', '350 FIFTH AVE', '350 5th Ave.', '350 FIFTH AVENUE, New York, NY, USA'];
  for (const a of same) assert.equal(normalizeAddress(a), '350 5 AVENUE', a);
  assert.equal(normalizeAddress('33 W 33RD ST'), '33 WEST 33 STREET');
  assert.equal(normalizeAddress('1260 Avenue of the Americas'), '1260 6 AVENUE');
  assert.equal(normalizeAddress('4 St Marks Pl'), '4 SAINT MARKS PLACE');
});

test('addresses display the way people write them', () => {
  assert.equal(displayAddress('350 5 AVENUE'), '350 Fifth Avenue');
  assert.equal(displayAddress('33 WEST 33 STREET'), '33 West 33rd Street');
  assert.equal(displayAddress('1 WEST 111 STREET'), '1 West 111th Street');
  assert.equal(displayAddress('20 WEST 22 STREET'), '20 West 22nd Street');
});

test('BBL helpers', () => {
  assert.deepEqual(splitBBL('1008350041'), { borough: '1', block: '835', lot: '41' });
  assert.deepEqual(splitBBL('1008350041.00000000'), { borough: '1', block: '835', lot: '41' });
  assert.equal(splitBBL('abc'), null);
  assert.ok(isCondoBillingLot('1013327501'));
  assert.ok(!isCondoBillingLot('1008350041'));
  assert.ok(isPlaceholderBIN('1000000'));
  assert.ok(!isPlaceholderBIN('1015862'));
});

test('dates from each agency format parse correctly', () => {
  assert.equal(isoDate('11/30/1995'), '1995-11-30');
  assert.equal(isoDate('19951130'), '1995-11-30');
  assert.equal(isoDate('2013-10-07T00:00:00.000'), '2013-10-07');
  assert.equal(isoDate('1931-05-01T00:00:00Z'), '1931-05-01');
  assert.equal(isoDate(''), null);
  assert.equal(formatDate('1981-05-19'), 'May 19, 1981');
  assert.equal(formatDate('1931-01-01', 'year'), '1931');
});

test('Empire State Building: identity is linked correctly', () => {
  const { identity, raw } = fixture();
  const p = buildProfile(identity, raw);
  assert.equal(p.title, 'Empire State Building');
  assert.equal(p.identity.bin, '1015862');
  assert.equal(p.identity.bbl, '1008350041');
  assert.equal(p.address, '350 Fifth Avenue');
  // PLUTO files it under 338 Fifth Avenue; both spellings must be kept.
  assert.ok(p.addresses.some(a => a.normalized === '338 5 AVENUE'));
  assert.ok(Math.abs(p.identity.lat - 40.7484) < 0.001 && Math.abs(p.identity.lng + 73.9857) < 0.001);
});

test('opened from the map (no typed address), the famous address still comes first', () => {
  const { identity, raw } = fixture();
  const p = buildProfile({ ...identity, label: null, candidates: [] }, raw);
  assert.equal(p.address, '350 Fifth Avenue');
});

test('Empire State Building: key documented facts come from the right sources', () => {
  const { identity, raw } = fixture();
  const p = buildProfile(identity, raw);
  const f = k => p.facts.find(x => x.key === k);
  assert.match(f('built').value, /1929\s*-\s*1931/);
  assert.equal(f('built').cite[0].source, 'lpc_buildings');
  assert.match(f('architect').value, /Shreve, Lamb & Harmon/);
  assert.match(f('style').value, /Art Deco/);
  const des = p.timeline.filter(e => /^Designated/.test(e.title));
  assert.deepEqual(des.map(e => e.date).sort(), ['1981-05-19', '1981-05-19']);
  assert.ok(des.some(e => /Individual Landmark/.test(e.title)) && des.some(e => /Interior Landmark/.test(e.title)));
  assert.deepEqual(p.reports.map(r => r.url).sort(), [
    'https://s-media.nyc.gov/agencies/lpc/lp/2000.pdf', 'https://s-media.nyc.gov/agencies/lpc/lp/2001.pdf']);
  assert.ok(p.ownership.deeds.some(d => d.date === '2013-10-07' && /Esrt Empire State Building/i.test(d.to.join())));
  assert.ok(p.dob.totals.jobs > 1000);
  assert.equal(p.conflicts.length, 0, 'ESB sources agree on 1929–31 / 1931');
});

test('every timeline event, fact and story sentence is cited', () => {
  const { identity, raw } = fixture();
  const p = buildProfile(identity, raw);
  for (const e of p.timeline) {
    assert.ok(e.cite.length > 0, `uncited event: ${e.title}`);
    for (const c of e.cite) assert.ok(SOURCES[c.source], `unknown source ${c.source}`);
    assert.ok(['documented', 'recorded'].includes(e.certainty));
  }
  for (const f of p.facts) assert.ok(f.cite.length > 0, `uncited fact: ${f.label}`);
  for (const para of p.narrative.paragraphs) {
    for (const s of para.sentences) {
      assert.ok(s.refs.length > 0, `uncited sentence: ${s.text}`);
      for (const r of s.refs) assert.ok(p.narrative.citations[r - 1], `dangling footnote ${r}`);
    }
  }
  // Timeline is in date order (undated last).
  const dates = p.timeline.map(e => e.date || '9999');
  assert.deepEqual(dates, [...dates].sort());
});

test('disagreeing construction dates are flagged, not hidden', () => {
  const { identity, raw } = fixture();
  raw.pluto.data[0].yearbuilt = '1950';
  const p = buildProfile(identity, raw);
  const c = p.conflicts.find(x => x.field === 'Construction date');
  assert.ok(c, 'conflict expected');
  assert.ok(c.values.some(v => v.value === '1950' && v.source === 'pluto'));
  assert.ok(p.narrative.paragraphs[0].sentences.some(s => /disagree/.test(s.text)));
});

test('a source that is down is reported as a gap and nothing crashes', () => {
  const { identity, raw } = fixture();
  raw.acris = { name: 'acris', ok: false, error: 'HTTP 503 from data.cityofnewyork.us', parts: {} };
  raw.lpc_buildings = { name: 'lpc_buildings', ok: false, error: 'Timed out' };
  const p = buildProfile(identity, raw);
  assert.ok(p.gaps.some(g => /ACRIS property records .* could not be reached/.test(g)));
  assert.ok(p.gaps.some(g => /Landmarks Preservation Commission’s building survey/.test(g)));
  assert.equal(p.ownership.deeds.length, 0);
  assert.equal(p.source_status.find(s => s.key === 'acris').ok, false);
});

test('a building with no records at all still produces an honest page', () => {
  const p = buildProfile({ bin: '1999999', bbl: '1099990001', lat: 40.75, lng: -73.98, label: '1 TEST STREET', match_log: [] }, {});
  assert.equal(p.timeline.length, 0);
  assert.ok(p.gaps.some(g => /No construction date/.test(g)));
  assert.equal(p.narrative.paragraphs.length, 1);
});

test('a year inside the LPC construction range is not a conflict', () => {
  const { identity, raw } = fixture();
  raw.pluto.data[0].yearbuilt = '1930';
  assert.equal(buildProfile(identity, raw).conflicts.length, 0);
});

test('no wiki sources are used anywhere (owner decision, Oct 2026)', () => {
  const { identity, raw } = fixture();
  const json = JSON.stringify(buildProfile(identity, raw)).toLowerCase();
  for (const w of ['wikidata', 'wikipedia', 'wikimedia']) assert.ok(!json.includes(w), `found ${w}`);
});

test('citations name the source, publisher, record and access date', () => {
  const { identity, raw } = fixture();
  const p = buildProfile(identity, raw, { now: new Date('2026-10-30T12:00:00Z') });
  const c = p.narrative.citations.find(x => x.url === 'https://s-media.nyc.gov/agencies/lpc/lp/2000.pdf');
  assert.ok(c, 'LPC report cited');
  assert.equal(c.publisher, 'NYC Landmarks Preservation Commission');
  assert.equal(c.accessed, '2026-10-30');
  for (const x of p.narrative.citations) assert.ok(x.label && x.publisher && x.url, JSON.stringify(x));
});
