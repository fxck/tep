// Fleet-number -> vehicle-model lookup for the PID live-map.
//
// Maps a vehicle's published fleet/registration number to a rolling-stock model
// so the UI can show "Škoda 15T" instead of a bare number, and (later) pick the
// right 3D asset. The ranges below are APPROXIMATE, community-/DPP-documented
// Prague (Dopravní podnik hl. m. Prahy) fleet-number bands — they shift over
// time as vehicles are retired/renumbered, so this is best-effort enrichment,
// NOT authoritative. We deliberately return null rather than guess wrong:
// bus/trolley fleets have too many overlapping variants to range-map safely.
//
// Sources (approximate): DPP tram roster numbering conventions, vozovny.cz /
// Wikipedia "Tramvaje v Praze" fleet-number lists. Trams are the payoff (a
// handful of clean, well-known bands); metro is mapped coarsely by unit number.

// Tram fleet-number bands -> model. Ordered most-specific first; first match wins.
// `lo`/`hi` are inclusive fleet numbers; null hi means open-ended upper bound.
const TRAM_RANGES = [
  // Tatra T3 family — the long-lived workhorse, renumbered into many sub-series.
  // Modernised variants (T3R.P / T3R.PLF / T3M / T3SUCS) live within these bands;
  // we collapse them to the recognisable "Tatra T3" label.
  { lo: 6500, hi: 6799, model: 'Tatra T3' },     // T3SUCS / T3M survivors
  { lo: 8200, hi: 8599, model: 'Tatra T3R.P' },  // T3R.P modernisations
  { lo: 8600, hi: 8799, model: 'Tatra T3R.PLF' },// part-low-floor T3 rebuild

  // KT8D2 — articulated three-section Tatra (KT8D5.RN2P modernisations).
  { lo: 9001, hi: 9099, model: 'Tatra KT8D5' },

  // Škoda 14T — first Prague Škoda low-floor (Porsche-design), ~9111–9152.
  { lo: 9111, hi: 9152, model: 'Škoda 14T' },

  // Škoda 15T ForCity (Alfa) — current standard low-floor tram, 9201 upward.
  // 25T ForCity Plus is a separate later contract; if/when its band is confirmed
  // it should slot in above this open-ended band.
  { lo: 9201, hi: 9450, model: 'Škoda 15T' },
  { lo: 9451, hi: 9999, model: 'Škoda 15T' },    // continued 15T deliveries
];

// Metro rolling stock is numbered by car; map coarse bands -> unit type.
// Prague runs two families: 81-71M (Soviet-design, modernised) and the newer
// Siemens M1 (line C). Numbers below are approximate unit/car bands.
const METRO_RANGES = [
  { lo: 2200, hi: 2499, model: 'Siemens M1' }, // line C, M1 cars
  { lo: 1000, hi: 1999, model: '81-71M' },     // 81-71M modernised cars
  { lo: 4000, hi: 5999, model: '81-71M' },     // older 81-71M car blocks
];

function lookup(ranges, n) {
  for (const r of ranges) {
    if (n >= r.lo && (r.hi == null || n <= r.hi)) return r.model;
  }
  return null;
}

// getModel(reg, mode): reg = fleet/registration number string (e.g. "9241"),
// mode = our normalized mode label ('tram' | 'metro' | 'bus' | ...). Returns a
// model string or null. Conservative: unknown ranges / non-rail modes -> null.
export function getModel(reg, mode) {
  if (reg == null || reg === '') return null;
  // Fleet numbers are plain integers; tolerate stray non-digits defensively.
  const n = parseInt(String(reg).replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(n) || n <= 0) return null;

  switch (mode) {
    case 'tram':
      return lookup(TRAM_RANGES, n);
    case 'metro':
      return lookup(METRO_RANGES, n);
    // bus / trolleybus / train / other: too many variants to range-map safely.
    default:
      return null;
  }
}
