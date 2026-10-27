// Works out *which building* the user means and links its identifiers:
// typed address -> NYC GeoSearch (City's official address file, PAD) -> BIN + BBL
// map click     -> building footprint under the point -> BIN -> BBL
// Every step is logged in `identity.match_log` so the user can see how the
// records were connected.

import { geosearch, footprintByBIN, footprintAtPoint } from './sources.js';
import { isPlaceholderBIN, isCondoBillingLot } from './address.js';

export async function resolveBuilding(query) {
  const raw = {};
  const log = [];
  let bin = null, bbl = null, label = null, lat = null, lng = null, candidates = [];

  if (query.text) {
    raw.geosearch = await geosearch(query.text);
    if (!raw.geosearch.ok) throw new Error('Address lookup failed: ' + raw.geosearch.error);
    const feats = raw.geosearch.data.features || [];
    if (!feats.length) throw new Error(`No NYC address matched “${query.text}”.`);
    candidates = feats.map(f => ({
      label: f.properties.label, bin: f.properties.addendum?.pad?.bin, bbl: f.properties.addendum?.pad?.bbl,
      borough: f.properties.borough,
    }));
    const f = feats[0];
    bin = f.properties.addendum?.pad?.bin;
    bbl = f.properties.addendum?.pad?.bbl;
    label = f.properties.label.replace(/, New York, NY, USA$/, '');
    [lng, lat] = f.geometry.coordinates;
    log.push({ step: 'Address → BIN & BBL', source: 'geosearch', detail: `“${query.text}” matched ${label} (BIN ${bin}, BBL ${bbl})` });
  } else if (query.lat != null) {
    raw.footprint_at_point = await footprintAtPoint(query.lat, query.lng);
    const hit = raw.footprint_at_point.data?.[0];
    if (!hit) throw new Error('No building footprint at that spot. Try clicking directly on a building.');
    bin = hit.bin;
    log.push({ step: 'Map point → BIN', source: 'footprints', detail: `Point falls inside footprint of BIN ${bin}` });
  } else if (query.bin) {
    bin = String(query.bin);
    if (isPlaceholderBIN(bin)) throw new Error(`BIN ${bin} is a placeholder the City uses when a site has no building number, so it can't identify a building. Search by address instead.`);
  } else {
    throw new Error('Nothing to look up.');
  }

  let footprint = null;
  if (bin && !isPlaceholderBIN(bin)) {
    raw.footprint = await footprintByBIN(bin);
    footprint = raw.footprint.data?.[0] || null;
  }
  if (footprint) {
    if (!bbl) {
      bbl = footprint.base_bbl;
      log.push({ step: 'BIN → BBL', source: 'footprints', detail: `Footprint lists tax lot ${bbl}` });
    } else if (footprint.base_bbl && footprint.base_bbl !== bbl) {
      log.push({ step: 'Check', source: 'footprints', detail: `Footprint's lot (${footprint.base_bbl}) differs from address lot (${bbl}); using the address lot.` });
    } else {
      log.push({ step: 'Cross-check', source: 'footprints', detail: `Footprint for BIN ${bin} confirms lot ${bbl}` });
    }
    if (lat == null && footprint.the_geom) [lng, lat] = centroid(footprint.the_geom);
  } else if (bin && !isPlaceholderBIN(bin)) {
    log.push({ step: 'Check', source: 'footprints', detail: `No footprint found for BIN ${bin} (building may be demolished or BIN retired).` });
  }
  if (isPlaceholderBIN(bin)) {
    log.push({ step: 'Warning', source: 'geosearch', detail: `BIN ${bin} is a placeholder: the City has no building ID for this address. Building-level records (DOB) will be missing.` });
  }
  const plutoBBL = footprint?.mappluto_bbl || bbl;
  if (plutoBBL !== bbl) {
    log.push({ step: 'Condo lot', source: 'footprints', detail: `Tax data (PLUTO) is filed under billing lot ${plutoBBL}` });
  }
  if (isCondoBillingLot(bbl) || isCondoBillingLot(plutoBBL)) {
    log.push({ step: 'Note', source: 'pluto', detail: 'This is a condominium; individual units have their own lots and deeds, which are not all gathered here.' });
  }
  return {
    identity: { bin, bbl, plutoBBL, lat, lng, label, name: footprint?.name || null, geometry: footprint?.the_geom || null, match_log: log, candidates },
    raw,
  };
}

export function centroid(geom) {
  const ring = geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : geom.coordinates[0];
  let x = 0, y = 0;
  const pts = ring.slice(0, -1);
  for (const [px, py] of pts) { x += px; y += py; }
  return [x / pts.length, y / pts.length];
}
