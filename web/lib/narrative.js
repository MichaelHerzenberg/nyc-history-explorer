// Writes the readable "story" from a profile: the headlines, not the paperwork.
// Who built it, when, for whom; how it changed; who is there now and before.
// Every sentence is built only from facts already in the profile and carries
// footnote numbers back to their sources. No AI model is used, so it costs
// nothing and cannot invent anything. Only official and archival sources are
// used (no wikis). Routine records (permits, violations, mortgages, deeds)
// stay out of the story; they are on the page under "Full records".

import { formatDate } from './profile.js';

const fact = (p, key) => p.facts.find(f => f.key === key);
const list = items => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const lower = s => String(s || '').toLowerCase();

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
  const S = (text, cs) => ({ text, refs: [...new Set(ref(cs))] });
  const paragraphs = [];

  // 1. Origins: who built it, when, for whom, what it is.
  const origin = [];
  const name = p.title, addr = p.address;
  const addrSources = (p.addresses[0]?.sources || []).slice(0, 2).map(s => ({ source: s }));
  origin.push(S(name !== addr && addr ? `${name} stands at ${addr}, Manhattan.` : `This building stands at ${addr || name}, Manhattan.`, addrSources));
  const built = fact(p, 'built'), arch = fact(p, 'architect'), dev = fact(p, 'developer');
  if (built) {
    let s = `It was built in ${built.value.replace(/\s*-\s*/, '–')}`;
    const cs = [built.cite[0]];
    // LPC lists "D. H. Burnham & Company (arch), George A. Fuller Co. (bldr)".
    const parts = arch ? arch.value.split(/[;,](?![^[]*\])\s*(?=[^,;]*\((?:arch|bldr|engineer|eng)\))/i) : [];
    const designers = parts.filter(x => !/\(bldr\)|\(eng(ineer)?\)/i.test(x)).map(x => x.replace(/\s*\(arch\)/i, '').trim());
    const builders = parts.filter(x => /\(bldr\)/i.test(x)).map(x => x.replace(/\s*\(bldr\)/i, '').trim());
    if (designers.length) { s += `, designed by ${list(designers)}`; cs.push(arch.cite[0]); }
    if (builders.length) s += ` and built by ${list(builders)}`;
    if (dev) { s += `, for ${dev.value}`; cs.push(dev.cite[0]); }
    origin.push(S(s + '.', cs));
  }
  const style = fact(p, 'style'), type = fact(p, 'type'), floors = fact(p, 'floors'), height = fact(p, 'height'), use = fact(p, 'original_use');
  const typeWord = type && !/s$/i.test(type.value.trim()) && !/\band\b/i.test(type.value) ? lower(type.value) : 'building';
  const what = [style && style.value.split(',')[0].trim(), typeWord].filter(Boolean).join(' ');
  const size = [floors && `${floors.value} floors`, height && `a roof height of about ${height.value}`].filter(Boolean);
  if (style || type || size.length) {
    origin.push(S(`${/^[aeiou]/i.test(what) ? 'An' : 'A'} ${what}${size.length ? `, it has ${list(size)}` : ''}${use ? `; its original use was ${lower(use.value)}` : ''}.`,
      [style?.cite[0], type?.cite[0], floors?.cite[0], height?.cite[0], use?.cite[0]].filter(Boolean)));
  }
  const conflict = p.conflicts.find(c => c.field === 'Construction date');
  if (conflict) {
    origin.push(S(`Records disagree on the date: ${list(conflict.values.map(v => `${v.value} (${p.sources[v.source]?.label || v.source})`))}.`, conflict.values.map(v => ({ source: v.source }))));
  }
  const photo = p.media?.[0];
  if (photo) origin.push(S(`The New York Public Library holds a public-domain historical image${photo.date ? ` dated ${photo.date}` : ''}: “${photo.title.trim().replace(/\.$/, '')}”.`, photo.cite));
  paragraphs.push({ heading: 'Origins', sentences: origin });

  // 2. Changes over time: major alterations, demolition, landmark status.
  const changes = [];
  for (const e of p.timeline.filter(e => e.major && (e.category === 'alteration' || e.category === 'demolition'))) {
    if (e.cite[0]?.source === 'pluto') changes.push(S(`City Planning records a major alteration in ${e.date_label}.`, e.cite));
    else {
      const by = (e.detail.match(/Alteration architect: (.*?)\.?$/) || [])[1];
      changes.push(S(`${e.category === 'demolition' ? 'Demolished' : 'Altered'} ${/^\d/.test(e.date_label) ? 'in ' : ''}${e.date_label}${by ? ` to designs by ${by}` : ''}.`, e.cite));
    }
  }
  const desig = p.timeline.filter(e => e.category === 'landmark' && /^Designated|^Included/.test(e.title));
  const byDate = new Map();
  for (const e of desig) { if (!byDate.has(e.date_label)) byDate.set(e.date_label, []); byDate.get(e.date_label).push(e); }
  for (const [date, es] of byDate) {
    const kinds = es.filter(e => e.title.startsWith('Designated')).map(e => `a New York City ${e.title.replace(/^Designated a New York City /, '')}`);
    const districts = es.filter(e => e.title.startsWith('Included')).map(e => e.title.split(': ')[1] || 'a designated historic district');
    if (kinds.length) changes.push(S(`On ${date}, the Landmarks Preservation Commission designated it ${list(kinds)}.`, es.flatMap(e => e.cite)));
    if (districts.length) changes.push(S(`On ${date}, it became part of the ${list(districts)}.`, es.flatMap(e => e.cite)));
  }
  if (changes.length) paragraphs.push({ heading: 'Changes over time', sentences: changes });

  // 3. Businesses here: now and before.
  const biz = [];
  const t = p.tenants || { current: [], past: [] };
  if (t.current.length) {
    const shown = t.current.slice(0, 8);
    biz.push(S(`Businesses here on current City records include ${list(shown.map(x => x.name))}${t.current.length > shown.length ? ` (${t.current.length} in all)` : ''}.`, shown.flatMap(x => x.cite)));
  }
  const earlier = t.past.filter(x => !x.lease).slice(0, 6);
  if (earlier.length) {
    biz.push(S(`Earlier ones include ${list(earlier.map(x => `${x.name}${x.to ? ` (until ${x.to.slice(0, 4)})` : ''}`))}.`, earlier.flatMap(x => x.cite)));
  }
  const leases = t.past.filter(x => x.lease).slice(0, 5);
  if (leases.length) {
    biz.push(S(`Recorded leases name ${list(leases.map(x => `${x.name}${x.from ? ` (${formatDate(x.from).replace(/^.* (\d{4})$/, '$1')})` : ''}`))} as tenants.`, leases.flatMap(x => x.cite)));
  }
  if (biz.length) paragraphs.push({ heading: 'Businesses here', sentences: biz });

  return {
    paragraphs,
    citations,
    method: 'Written automatically from the records cited. No AI model was used and nothing beyond the cited sources was added.',
  };
}
