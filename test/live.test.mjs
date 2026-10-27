// Live tests: talk to the real public sources. Run with `npm run test:live`.
// These confirm the sources still answer the way the app expects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBuilding } from '../web/lib/identity.js';
import { gatherRaw, footprintsNear, pilotLandmarks, autocomplete } from '../web/lib/sources.js';
import { buildProfile } from '../web/lib/profile.js';
import { PILOT_WKT } from '../web/lib/config.js';

test('typed address -> Empire State Building, with all core sources answering', async () => {
  const { identity, raw: idRaw } = await resolveBuilding({ text: '350 Fifth Avenue, Manhattan' });
  assert.equal(identity.bin, '1015862');
  assert.equal(identity.bbl, '1008350041');
  const raw = { ...idRaw, ...(await gatherRaw(identity)) };
  const p = buildProfile(identity, raw);
  const failed = p.source_status.filter(s => !s.ok && !['wikidata', 'commons'].includes(s.key));
  assert.deepEqual(failed.map(s => `${s.key}: ${s.error}`), [], 'core city sources should all answer');
  assert.equal(p.title, 'Empire State Building');
  assert.ok(p.timeline.some(e => e.date === '1981-05-19'));
}, { timeout: 120000 });

test('map click on the building -> BIN', async () => {
  const { identity } = await resolveBuilding({ lat: 40.74844, lng: -73.98565 });
  assert.equal(identity.bin, '1015862');
}, { timeout: 60000 });

test('"near me" at Times Square lists One Times Square among nearby buildings', async () => {
  const near = await footprintsNear(40.756165, -73.986556, 40);
  assert.ok(near.some(b => b.bin === '1022581'), JSON.stringify(near.map(b => b.bin)));
}, { timeout: 60000 });

test('pilot landmark layer loads', async () => {
  const lm = await pilotLandmarks(PILOT_WKT);
  assert.ok(lm.length > 200, `got ${lm.length}`);
  assert.ok(lm.some(l => l.bin_number === '1015862'));
}, { timeout: 60000 });

test('address autocomplete answers', async () => {
  const r = await autocomplete('350 fifth');
  assert.ok(r.features.some(f => /350 FIFTH AVENUE, New York/.test(f.properties.label)));
}, { timeout: 30000 });
