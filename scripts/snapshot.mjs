#!/usr/bin/env node
// Builds a building profile from the live sources and saves it.
//
//   node scripts/snapshot.mjs "350 Fifth Avenue"
//   node scripts/snapshot.mjs --bin 1015862
//   node scripts/snapshot.mjs --bin 1015862 --fixture   (also refresh the test fixture)
//
// Writes:
//   data/raw/<BIN>.json            every raw response, exactly as received (not published)
//   web/data/buildings/<BIN>.json  the normalised profile the app displays

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuilding } from '../web/lib/identity.js';
import { gatherRaw } from '../web/lib/sources.js';
import { buildProfile } from '../web/lib/profile.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, n === '--bin' ? 2 : 1).slice(1)[0] ?? true : null; };

export async function snapshot(query, { saveRaw = true, quiet = false } = {}) {
  const { identity, raw: idRaw } = await resolveBuilding(query);
  const raw = { ...idRaw, ...(await gatherRaw(identity)) };
  const profile = buildProfile(identity, raw);
  const bin = identity.bin;
  await mkdir(join(root, 'web/data/buildings'), { recursive: true });
  await writeFile(join(root, 'web/data/buildings', `${bin}.json`), JSON.stringify(profile, null, 1));
  if (saveRaw) {
    await mkdir(join(root, 'data/raw'), { recursive: true });
    await writeFile(join(root, 'data/raw', `${bin}.json`), JSON.stringify({ identity, raw }));
  }
  if (!quiet) {
    console.log(`${profile.title}  (BIN ${bin}, BBL ${identity.bbl})`);
    for (const s of profile.source_status) console.log(`  ${s.ok ? '✓' : '✗'} ${s.label}${s.ok ? ` — ${s.count} record(s)` : ` — ${s.error}`}`);
    console.log(`  timeline events: ${profile.timeline.length}, gaps noted: ${profile.gaps.length}, conflicts: ${profile.conflicts.length}`);
  }
  return { identity, raw, profile };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bin = flag('--bin');
  const fixture = flag('--fixture');
  const query = bin ? { bin } : { text: args.join(' ') || '350 Fifth Avenue, Manhattan' };
  const { identity, raw } = await snapshot(query);
  if (fixture) {
    await writeFile(join(root, 'test/fixtures', `${identity.bin}.raw.json`), JSON.stringify({ identity, raw }));
    console.log('Fixture updated.');
  }
}
