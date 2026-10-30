// Writes the readable "story" from a profile. Every sentence is built only
// from facts already in the profile and carries footnote numbers back to
// their sources. No AI model is used, so it costs nothing and cannot invent
// anything. Only official and archival sources are used (no wikis).
// A later version can hand the same cited facts to an AI model for more
// fluent prose; the citation structure stays the same.

import { formatDate } from './profile.js';

const fact = (p, key) => p.facts.find(f => f.key === key);
const list = items => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export function writeNarrative(p) {
  const citations = [];
  // Same source + same link = same footnote number.
  const ref = cs => (cs || []).map(c => {
    const url = c.url || p.sources[c.source]?.url;
    let i = citations.findIndex(x => x.source === c.source && x.url === url);
    if (i < 0) {
      const src = p.sources[c.source] || {};
      citations.push({ source: c.source, url, label: src.label, publisher: src.publisher, note: c.note, accessed: p.generated_at?.slice(0, 10) });
      i = citations.length - 1;
    }
    return i + 1;
  });
  const end = s => s.replace(/\.*$/, '.');
  const S = (text, cs) => ({ text, refs: [...new Set(ref(cs))] });
  const paragraphs = [];

  // 1. Origins
  const origin = [];
  const name = p.title;
  const addr = p.address;
  const addrSources = (p.addresses[0]?.sources || []).map(s => ({ source: s }));
  origin.push(S(name !== addr && addr ? `${name} stands at ${addr}, Manhattan.` : `This building stands at ${addr || name}, Manhattan.`, addrSources));
  if (p.addresses.length > 1) {
    origin.push(S(`City records also list it as ${list(p.addresses.slice(1, 4).map(a => a.address))}.`, p.addresses.slice(1, 4).flatMap(a => a.sources.map(s => ({ source: s })))));
  }
  const built = fact(p, 'built');
  const arch = fact(p, 'architect');
  const dev = fact(p, 'developer');
  if (built) {
    let s = `It was built ${/[–-]/.test(built.value) ? 'in ' + built.value.replace(/\s*-\s*/, '–') : 'in ' + built.value}`;
    const cs = [...built.cite.filter(c => c.source === built.cite[0].source)];
    if (arch) { s += `, designed by ${arch.value}`; cs.push(...arch.cite.slice(0, 1)); }
    if (dev) { s += `, for ${dev.value}`; cs.push(...dev.cite); }
    origin.push(S(s + '.', cs));
  }
  const style = fact(p, 'style'), mats = fact(p, 'materials'), use = fact(p, 'original_use');
  const described = [style && `style “${style.value}”`, mats && `materials “${mats.value}”`, use && `original use “${use.value}”`].filter(Boolean);
  if (described.length) {
    origin.push(S(`Its survey record lists ${list(described)}.`, [...(style?.cite || []), ...(mats?.cite || []), ...(use?.cite || [])]));
  }
  const conflict = p.conflicts.find(c => c.field === 'Construction date');
  if (conflict) {
    origin.push(S(`Sources disagree on the date: ${list(conflict.values.map(v => `${v.value} (${p.sources[v.source]?.label || v.source})`))}.`, conflict.values.map(v => ({ source: v.source }))));
  }
  paragraphs.push({ heading: 'Origins', sentences: origin });

  // 2. Recognition
  const recog = [];
  const desig = p.timeline.filter(e => e.category === 'landmark' && /^Designated|^Included/.test(e.title));
  for (const e of desig) recog.push(S(`On ${e.date_label}, the Landmarks Preservation Commission ${e.title.replace(/^Designated a/, 'designated it a').replace(/^Included in/, 'included it in')}.`, e.cite));
  if (recog.length) paragraphs.push({ heading: 'Recognition', sentences: recog });

  // 3. Later life: DOB and property records
  const later = [];
  const t = p.dob?.totals;
  if (t && (t.jobs || t.violations)) {
    const firstYear = p.dob.first_filing?.slice(0, 4);
    later.push(S(`Department of Buildings data${firstYear ? ` from ${firstYear} onward` : ''} holds ${t.jobs.toLocaleString('en-US')} job filing${t.jobs === 1 ? '' : 's'}, ${t.violations.toLocaleString('en-US')} DOB violation${t.violations === 1 ? '' : 's'}, ${t.ecb.toLocaleString('en-US')} ECB violation${t.ecb === 1 ? '' : 's'} and ${t.complaints.toLocaleString('en-US')} complaint${t.complaints === 1 ? '' : 's'} for this building.`,
      [{ source: 'dob_jobs' }, { source: 'dob_violations' }, { source: 'ecb_violations' }, { source: 'dob_complaints' }]));
    const majors = p.timeline.filter(e => e.category === 'alteration' && e.certainty === 'documented' && e.cite[0]?.source?.startsWith('dob'));
    if (majors.length) {
      const last = majors[majors.length - 1];
      later.push(S(`Of these, ${majors.length} ${majors.length === 1 ? 'is a major alteration' : 'are major alterations'} (changes of use, egress or occupancy); the most recent was filed ${last.date_label}.`, [last.cite[0]]));
    }
  }
  const owner = fact(p, 'owner');
  if (owner) later.push(S(`The city tax roll lists ${owner.value} as the current owner of record.`, owner.cite));
  const deeds = p.ownership?.deeds || [];
  if (deeds.length) {
    const d = deeds[deeds.length - 1];
    later.push(S(end(`ACRIS holds ${deeds.length} deed${deeds.length === 1 ? '' : 's'}, lease${deeds.length === 1 ? '' : 's'} or other conveyance${deeds.length === 1 ? '' : 's'} for the lot; the most recent ${d.doc_type_label.toLowerCase()}${d.date ? `, dated ${formatDate(d.date)}` : ''}, ${d.to.length ? `went to ${list(d.to)}` : `covers ${d.scope}`}`), [{ source: 'acris', url: d.url }]));
  }
  if (later.length) paragraphs.push({ heading: 'Later life in the records', sentences: later });

  return {
    paragraphs,
    citations,
    method: 'Written automatically from the records cited. No AI model was used and nothing beyond the cited sources was added.',
  };
}
