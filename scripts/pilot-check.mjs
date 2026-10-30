#!/usr/bin/env node
// Reliability check across the Midtown pilot: builds a profile for each
// designated landmark building in the pilot area and reports how complete
// the results are. Writes docs/pilot-report.md.
//
//   npm run pilot                 (sample of 40 buildings)
//   npm run pilot -- --all        (all ~250; takes a while, be polite)
//   npm run pilot -- --limit 100

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBuilding } from '../web/lib/identity.js';
import { gatherRaw, pilotLandmarks } from '../web/lib/sources.js';
import { buildProfile } from '../web/lib/profile.js';
import { PILOT_WKT } from '../web/lib/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const all = args.includes('--all');
const limit = all ? Infinity : Number(args[args.indexOf('--limit') + 1]) || 40;

const landmarks = await pilotLandmarks(PILOT_WKT);
const byBin = new Map();
const placeholders = new Set();
for (const l of landmarks) {
  if (/^[1-5]000000$/.test(l.bin_number || '')) { placeholders.add(l.lm_name); continue; }
  if (l.bin_number && !byBin.has(l.bin_number)) byBin.set(l.bin_number, l);
}
// Spread the sample evenly through the list rather than taking the first N.
const list = [...byBin.values()].sort((a, b) => a.bin_number.localeCompare(b.bin_number));
const step = Math.max(1, list.length / Math.min(limit, list.length));
const sample = [];
for (let i = 0; i < list.length && sample.length < limit; i += step) sample.push(list[Math.floor(i)]);
if (!sample.some(l => l.bin_number === '1015862')) sample[0] = byBin.get('1015862') || sample[0];

console.log(`${byBin.size} designated landmark buildings in the pilot area; checking ${sample.length}.`);
if (placeholders.size) console.log(`Skipped ${placeholders.size} landmark record(s) with a placeholder BIN: ${[...placeholders].join(', ')}`);
const results = [];
for (const [i, l] of sample.entries()) {
  const t0 = Date.now();
  try {
    const { identity, raw: idRaw } = await resolveBuilding({ bin: l.bin_number });
    const raw = { ...idRaw, ...(await gatherRaw(identity)) };
    const p = buildProfile(identity, raw);
    const f = k => p.facts.find(x => x.key === k);
    results.push({
      bin: l.bin_number, name: l.lm_name, ok: true, seconds: (Date.now() - t0) / 1000,
      footprint: !!raw.footprint?.data?.length, address: p.address,
      built: f('built')?.value || null, architect: f('architect')?.value || null,
      lpc_survey: !!raw.lpc_buildings?.data?.length, designated: p.timeline.some(e => /^Designated/.test(e.title)),
      deeds: p.ownership.deeds.length, dob_jobs: p.dob.totals.jobs,
      events: p.timeline.length, conflicts: p.conflicts.map(c => c.field), failed_sources: p.source_status.filter(s => !s.ok).map(s => s.key),
    });
  } catch (err) {
    results.push({ bin: l.bin_number, name: l.lm_name, ok: false, error: err.message });
  }
  const r = results.at(-1);
  console.log(`${String(i + 1).padStart(3)}. ${r.ok ? '✓' : '✗'} ${r.name} (BIN ${r.bin})${r.ok ? ` — ${r.events} events, built ${r.built ?? '?'}${r.conflicts.length ? ', CONFLICT ' + r.conflicts : ''}${r.failed_sources.length ? ', failed: ' + r.failed_sources : ''}` : ' — ' + r.error}`);
  await new Promise(res => setTimeout(res, 400)); // be polite to the public APIs
}

const ok = results.filter(r => r.ok);
const pct = (n, d = ok.length) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const count = fn => ok.filter(fn).length;
const md = `# Midtown pilot reliability report

Generated ${new Date().toISOString().slice(0, 10)} by \`npm run pilot\`. Sample: ${sample.length} of the ${byBin.size} designated individual-landmark buildings inside the pilot area (23rd–59th St, 3rd–9th Ave), chosen evenly across the list.${placeholders.size ? ` ${placeholders.size} landmark record(s) carry a placeholder BIN (no real building number) and were skipped: ${[...placeholders].join(', ')}.` : ''}

| Measure | Result |
|---|---|
| Profiles assembled without error | ${ok.length} / ${results.length} (${pct(ok.length, results.length)}) |
| Building footprint found for the BIN | ${count(r => r.footprint)} (${pct(count(r => r.footprint))}) |
| Construction date found | ${count(r => r.built)} (${pct(count(r => r.built))}) |
| Architect found | ${count(r => r.architect)} (${pct(count(r => r.architect))}) |
| In LPC building survey | ${count(r => r.lpc_survey)} (${pct(count(r => r.lpc_survey))}) |
| Designation date on timeline | ${count(r => r.designated)} (${pct(count(r => r.designated))}) |
| At least one ACRIS deed/conveyance | ${count(r => r.deeds > 0)} (${pct(count(r => r.deeds > 0))}) |
| Construction-date conflict flagged | ${count(r => r.conflicts.length)} |
| Any source failed during the run | ${count(r => r.failed_sources.length)} |
| Median time per building | ${ok.length ? ok.map(r => r.seconds).sort((a, b) => a - b)[Math.floor(ok.length / 2)].toFixed(1) : '—'} s |

## Buildings checked

| Building | BIN | Built | Architect | Events | Deeds | Notes |
|---|---|---|---|---|---|---|
${results.map(r => r.ok
    ? `| ${r.name} | ${r.bin} | ${r.built ?? '—'} | ${r.architect ?? '—'} | ${r.events} | ${r.deeds} | ${[r.conflicts.length ? 'date conflict' : '', r.failed_sources.length ? 'failed: ' + r.failed_sources.join(', ') : '', !r.footprint ? 'no footprint' : ''].filter(Boolean).join('; ')} |`
    : `| ${r.name} | ${r.bin} | | | | | ERROR: ${r.error} |`).join('\n')}
`;
await writeFile(join(root, 'docs/pilot-report.md'), md);
console.log(`\nWrote docs/pilot-report.md — ${ok.length}/${results.length} assembled.`);
