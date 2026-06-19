import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import './globals.css';
import { init3DLayer } from './vehicles3d.js';
import { proceduralMeshProvider } from './meshProvider.js';
import { dbgEnabled, dbgFrame, dbgTagSnapshot, dbgLag } from './motionDebug.js';
import { initPins } from './pins.js';
import { initChaseCam } from './chaseCam.js';
import { initTimeMachine } from './timeMachine.js';
import { registerPWA } from './pwa.js';
// React chrome bridge: the engine PUSHES live state into these slices and
// REGISTERS command callbacks; the React island (mountUI) reads/dispatches.
import {
  stats as statsSlice, selected as selSlice, filters as filtersSlice,
  layers as layersSlice, camera as cameraSlice, view as viewSlice,
  panels as panelsSlice, stop as stopSlice,
  setActions, setHelpers,
} from './lib/bridge.js';
import { mountUI } from './app/mount.jsx';
import { initCar } from './car.js';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
// Basemap follows the chrome theme AT LOAD (dark chrome → dark map). Both styles
// are OpenFreeMap + the SAME 'openmaptiles' vector source with a 'building'
// source-layer, so the 3D-buildings layer works identically on either. Picking
// the style once at init keeps the custom WebGL layer / precision transform safe
// (no runtime setStyle re-add). Mid-session theme flips apply on reload.
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/positron';
function initialThemeIsNight() {
  let mode = 'day';   // fresh-visitor default: LIGHT (mirrors lib/theme.js readMode default)
  try { const s = localStorage.getItem('pidtheme'); if (s === 'day' || s === 'night' || s === 'auto') mode = s; } catch { /* ignore */ }
  if (mode === 'night') return true;
  if (mode === 'day') return false;
  let h;
  try { h = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', hour12: false }).format(new Date()), 10); } catch { h = NaN; }
  if (!Number.isFinite(h)) h = new Date().getHours();
  return h >= 19 || h < 7;   // Auto = night 19:00–07:00 Prague (mirrors ThemeToggle)
}
const NIGHT_AT_LOAD = initialThemeIsNight();
const MAP_STYLE = import.meta.env.VITE_MAP_STYLE || (NIGHT_AT_LOAD ? STYLE_DARK : STYLE_LIGHT);
// Apply the matching chrome theme to <html> immediately (before React mounts) so the
// chrome never flashes the wrong theme or mismatches the basemap on first paint. The
// theme store (lib/theme.js) takes over once React mounts.
try { document.documentElement.dataset.theme = NIGHT_AT_LOAD ? 'night' : 'day'; } catch { /* noop */ }

// INTERPOLATE-ONLY motion: glide each vehicle along its REAL inter-fix interval,
// then HOLD at the last real fix. We never EXTRAPOLATE past a known fix —
// extrapolation (the old "coast") overshot whenever a vehicle slowed/stopped or
// rounded a curve, and the next real fix then yanked it BACKWARD. Holding at a
// real position is honest and the next fix simply resumes a forward glide.
const MIN_DUR = 1500;
const MAX_DUR = 90000;        // fixes arrive ~20-80s apart; the glide spans the real interval
const FALLBACK_DUR = 8000;    // no usable timestamp delta
const SNAP_KMH = 200;         // an implied move faster than this = data jump → snap once, don't streak
const SD_SNAP_KM = 3;         // chainage discontinuity (km) → snap
const SD_BACK_KM = 0.4;       // backward chainage beyond this (km) → real reversal/trip → snap
const SD_DEAD_KM = 0.015;     // sub-15m forward move → hold (kills stop/jitter wobble)
const JUMP_SNAP_M = 2500;     // point-mode (no shape) glitch guard
const DRAW_INTERVAL = 33;
const MESH_MINZOOM = 15;      // below this, 3D meshes are too small to read -> keep the 2D dots+labels
                             // visible instead (was 13, which left a z13-15 band showing tiny/invisible
                             // meshes but no dots and no pins — "nothing there"). Dots carry through to 15.
// Corrective-slide model: a snap/trip-change/shape-load gap is reconciled by
// sliding to the truth at a CONSTANT catch-up speed (linear decay = no
// front-loaded lurch), over a per-correction duration scaled by the gap and
// clamped. So a 60 m correction eases in ~1.7 s, a 1 km one in ~6 s — both
// SMOOTH, neither an instant teleport nor a lightspeed streak. A gap beyond
// SNAP_HARD_M is treated as broken data and snapped instantly (rare).
const SMOOTH_MS = 450;        // floor slide duration (a tiny correction still eases, never pops)
const CATCHUP_MPS = 25;       // CONSTANT catch-up speed (≈90 km/h ceiling) for the lat/lon ease-out
                              // of a SNAP / shape-load gap: a correction slides at this rate
                              // REGARDLESS of size, so it's smooth — not a 162 km/h streak (was 45).
const SMOOTH_MAX_MS = 60000;  // a large correction may reconcile over this long — but always at
                              // ≤CATCHUP_MPS, i.e. smooth, never a teleport and never a streak.
const SNAP_HARD_M = 1500;     // ≈ CATCHUP_MPS·SMOOTH_MAX_MS: only a GPS-glitch gap beyond what the
                              // capped slide can cover in that window snaps once (truly rare).

// --- forward-prediction (dead-reckoning) motion -----------------------------
// The vehicle no longer FREEZES between the sparse (~40s) fixes: it dead-reckons
// FORWARD along the shape at an estimated chainage speed (vSd, an EMA of recent
// Δsd/Δt), then reconciles when the next fix lands. Reconciliation is BOUNDED
// VELOCITY CORRECTION (see SPEED_CAP_MULT / CONV_TAU below): the fix error enters
// ONLY as a velocity term (err/CONV_TAU added to cruise) that is HARD-CLAMPED to a
// believable multiple of the vehicle's own cruise BEFORE it is integrated — so the
// rendered position can never sprint to "catch up" no matter how big the error is
// (the violent darting that an err-driven position chase produced). Two guards stop
// runaway prediction:
//   • DWELL gate — state_position 'at_stop' ⇒ speed 0, so it PARKS at a stop
//     instead of sailing through it (the overshoot that used to snap back).
//   • LEAD cap — predict at most a per-mode lead (≈ the mode's fix interval) /
//     MAX_LEAD_KM past the last fix; a stale feed then holds rather than crossing the city.
// Latency-compensated: the dead-reckoned target uses the real fix AGE (now − fix
// time), so it ≈ the actual CURRENT position and the render tracks it smoothly
// instead of lagging a whole fix behind.
const V_EMA = 0.45;            // speed-estimate smoothing (EMA weight of each new fix)
// Per-mode forward-prediction LEAD: how far past the last fix the dead-reckon may run.
// MUST cover the FULL worst-case age of a fix before its successor lands — i.e. the fix
// INTERVAL *plus* the staleness with which fixes arrive — else, on a long gap, the target
// hits the lead cap and the dot STALLS until the next fix (then the bounded corrector has to
// claw back the whole stall). Measured midday (p90): interval tram 82 s, trolley 65 s, bus
// 50 s, train 72 s, metro 14 s; staleness p90 ≈ 61 s on top. So lead ≈ p90(interval) +
// p90(staleness) + margin. Lead is a MAX (only engaged when fixes are sparse), so a generous
// value degrades gracefully toward faster cadence; the MAX_LEAD_KM + next-stop caps still bound
// the actual excursion, so over-provisioning the time lead cannot dart or overrun a stop.
const MAX_LEAD_MS_BY_MODE = { tram: 150000, trolleybus: 110000, bus: 95000, train: 120000, metro: 25000, ferry: 75000, funicular: 80000, cablecar: 80000, gondola: 80000, other: 80000 };
const leadMs = (mode) => MAX_LEAD_MS_BY_MODE[mode] || 60000;
const MAX_LEAD_KM = 1.5;       // absolute distance backstop for a stale/dead feed (raised from 0.9 so
                               // the per-mode TIME lead, not the distance, governs normal motion).
// --- BOUNDED VELOCITY-CORRECTION reconciliation (replaces the error-proportional chase) ---
// The old dart: err/CATCHUP_TAU_MS(550) pegged at MAX_CATCHUP_MULT(12)×vmax = 780 km/h on any
// err>~119 m, and routine inter-fix blocks are 132 m(p50)/345 m(p90)/1.4 km(max) — so EVERY fix
// darted. Fix: the error NEVER moves position; it becomes a VELOCITY term (err/CONV_TAU) summed
// onto cruise and HARD-CLAMPED to ≤SPEED_CAP_MULT×cruise BEFORE integration. Position only ever
// advances by a clamped velocity×dt, so darting is impossible regardless of error magnitude —
// peak draw speed is a believable ~1.6×cruise (tram ~28 km/h), not 780.
const SPEED_CAP_MULT = 1.6;    // rendered speed ≤ 1.6× the vehicle's OWN cruise (vSd). The ~0.6×cruise
                               // headroom closes routine lag within a fix interval; tram peak ≈28 km/h.
                               // THE anti-dart bound — never raise past ~1.8.
const BACK_MULT = 0.08;        // an over-prediction settles backward at ≤0.08×vmax (tram ~5 km/h): a
                               // gentle, barely-perceptible correction, never a fast reverse/teleport.
const CRUISE_FLOOR = 0.20;     // when vEff≈0 the corrector may target ≥0.20×vmax so a just-departed/cold
                               // vehicle pulls away (tram ~13 km/h). Only raises when vEff is below it.
const MIN_CAP_FRAC = 0.30;     // floor for the speed-cap denominator so the cap isn't 0 when cruise≈0:
                               // a cold/stopped vehicle may ramp to SPEED_CAP_MULT×0.30×vmax.
const ACCEL_TAU_MS = 800;      // velocity-onset smoothing (1−exp(−dt/τ)): a fix never step-changes the
                               // rendered speed; a believable sub-second accel ramp. ≪ CONV_TAU.
// Convergence time-constant: residual err is bled into velocity over ~this long, PER MODE. Metro is
// floored well above its 5 s fix gap so the dense+noisy feed doesn't pulse; sparse modes are short
// enough to close a residual within ~one fix interval (measured fix p50: metro 5 s, bus 19 s, tram 50 s).
const CONV_TAU_MS_BY_MODE = { metro: 12000, train: 12000, bus: 12000, trolleybus: 20000, tram: 22000, ferry: 15000, funicular: 20000, cablecar: 20000, gondola: 20000, other: 15000 };
const convTau = (mode) => CONV_TAU_MS_BY_MODE[mode] || 15000;
const SD_MOVE_KM = 0.012;      // a fix advancing < this (≈12 m) is treated as stationary → hold
const APPROACH_KM = 0.05;      // within this distance of the NEXT STOP, ease the velocity down so a
                               // vehicle DECELERATES into the stop (gated to real stops, NOT the lead cap).
const SD_PARK_KM = 0.010;      // final ~10 m of that approach (or any distance while dwelling): decay the
                               // velocity fully to ZERO so the dot PARKS at the platform, not creeps onto it.
// Per-mode chainage-speed ceiling (km/h) — clamps only the velocity ESTIMATE so a
// single glitchy fix can't inject an absurd predicted speed. Real motion is
// governed by the measured EMA; this is just a sanity ceiling.
const VMAX_KMH = { tram: 65, metro: 90, train: 150, bus: 70, trolleybus: 65, ferry: 35, funicular: 30, cablecar: 30, gondola: 30, other: 95 };
const vmaxKmMs = (mode) => (VMAX_KMH[mode] || 90) / 3.6e6; // km per millisecond

// --- bidirectional track separation (item A) --------------------------------
// Opposing directions share one coincident centerline in the GTFS shapes. We
// shift each vehicle to the RIGHT of its travel heading so the two directions
// form parallel tracks. Pure RENDER offset (applied before the corrective slide
// targets it) — motion semantics (no-teleport / no-backward) are untouched.
const TRACK_OFF_RAIL = 3.0;   // metres, right-of-heading, for rail modes (tram/metro/train)
const TRACK_OFF_ROAD = 2.5;   // metres, right-of-heading, for road modes (bus/trolleybus/other)
const TRACK_END_FADE_M = 12;  // chainage window at each shape END where the offset eases to 0
                              // (the tangent flips at termini — separating there would jitter).
const RAIL_MODES = new Set(['tram', 'metro', 'train']);
// --- heading easing (item B) ------------------------------------------------
const HDG_EASE_TAU_MS = 200;  // exp time-constant: per-frame factor = 1 - exp(-dt/TAU)

const MODE_LABELS = {
  tram: 'Tram', metro: 'Metro', train: 'Train', bus: 'Bus',
  trolleybus: 'Trolleybus', ferry: 'Ferry', funicular: 'Funicular',
  cablecar: 'Cable car', gondola: 'Gondola', other: 'Other',
};
const LEGEND = [
  ['tram', '#D2192C'], ['metro', '#00A562'], ['bus', '#007DA8'],
  ['train', '#1A66B0'], ['trolleybus', '#8E44AD'],
];

// The HUD / legend / controls / dashboard chrome is now the React island
// (src/app + src/chrome), driven by the bridge slices. The engine pushes live
// state via statsSlice/selSlice/etc and registers commands via setActions below.

// --- math helpers -----------------------------------------------------------
const lerp = (a, b, t) => a + (b - a) * t;
function distMeters(lon1, lat1, lon2, lat2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearingDeg(lon1, lat1, lon2, lat2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
  const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// Shortest signed angular difference b-a in degrees, in (-180, 180].
function angDiff(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360; else if (d < -180) d += 360;
  return d;
}

// Lateral RIGHT-of-heading offset for bidirectional track separation (item A).
// Mutates+returns {lon,lat,hdg}: shifts the point to the vehicle's right so the
// two travel directions split onto parallel tracks. `mode` picks the magnitude;
// `fade` (0..1) tapers it to 0 near the shape termini where the tangent flips.
// Pure render offset — applied BEFORE applyError so the corrective slide targets
// the offset position (no extra slide). hdg is unchanged.
function offsetRight(p, mode, fade) {
  if (fade <= 0) return p;
  const off = (RAIL_MODES.has(mode) ? TRACK_OFF_RAIL : TRACK_OFF_ROAD) * fade;
  const rad = Math.PI / 180;
  const rightBrg = (p.hdg + 90) * rad;                 // 90° clockwise of travel heading
  const cosLat = Math.cos(p.lat * rad) || 1e-6;
  p.lat += (Math.cos(rightBrg) * off) / 111320;
  p.lon += (Math.sin(rightBrg) * off) / (111320 * cosLat);
  return p;
}
// End-fade factor for a chainage `sdKm` on a shape of `totalKm`: 1 in the
// interior, easing linearly to 0 within TRACK_END_FADE_M of either terminus.
function endFade(sdKm, totalKm) {
  if (!(totalKm > 0)) return 0;
  const w = TRACK_END_FADE_M / 1000;
  if (w <= 0) return 1;
  const d = Math.min(sdKm, totalKm - sdKm);            // km to the nearer end
  return Math.max(0, Math.min(1, d / w));
}

// --- shape store ------------------------------------------------------------
const shapes = new Map();      // shape_id -> {pts:[[lon,lat]], cum:[km], total, hasDist} | 'pending'
const shapeColor = new Map();  // shape_id -> '#rrggbb' (from a vehicle on it)
let routesDirty = false;

function buildShape(arr) {
  const pts = [], cum = [];
  for (const p of arr || []) { pts.push([p[0], p[1]]); cum.push(typeof p[2] === 'number' ? p[2] : 0); }
  const total = cum.length ? cum[cum.length - 1] : 0;
  // Sanity-check the chainage↔geometry mapping. Some GTFS shapes have a TELEPORTING
  // VERTEX (a big spatial jump for a near-zero shape_dist delta) or non-monotonic
  // shape_dist; advancing sd smoothly across such a segment darts the vehicle 100 m+
  // in one frame (the rare "math/other" stupidly-fast outliers). If we find one, we
  // distrust this shape's chainage and fall its vehicles back to smooth GPS-lerp point
  // mode (hasDist=false) — no rail snapping, but no darting.
  let hasDist = total > 0;
  if (hasDist) {
    for (let i = 1; i < pts.length; i++) {
      const dChainM = (cum[i] - cum[i - 1]) * 1000;        // chainage delta in metres
      if (dChainM < -1) { hasDist = false; break; }        // non-monotonic chainage
      const dSpaceM = distMeters(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
      if (dSpaceM > 150 && dSpaceM > 4 * Math.max(dChainM, 1)) { hasDist = false; break; } // teleport vertex
    }
  }
  return { pts, cum, total, hasDist };
}
function pointAtDist(shape, dist) {
  const { pts, cum, total } = shape;
  if (pts.length < 2) return null;
  const d = Math.max(0, Math.min(dist, total));
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < d) lo = mid + 1; else hi = mid; }
  const i = Math.max(0, lo - 1);
  const seg = (cum[i + 1] - cum[i]) || 1e-9;
  const f = (d - cum[i]) / seg;
  const [lo1, la1] = pts[i], [lo2, la2] = pts[i + 1];
  return [lo1 + (lo2 - lo1) * f, la1 + (la2 - la1) * f, bearingDeg(lo1, la1, lo2, la2)];
}

// True once a vehicle's route geometry is loaded (so curState positions it
// ON the rail rather than by raw point-mode lerp). Used by motionDebug to
// attribute the point→rail switch.
function shapeReady(v) {
  const s = v.shp ? shapes.get(v.shp) : null;
  return !!(s && s !== 'pending' && s.hasDist && v.sd != null);
}

async function fetchMissingShapes(ids) {
  const missing = [...new Set(ids)].filter((id) => id && !shapes.has(id));
  if (!missing.length || !API_BASE) return;
  missing.forEach((id) => shapes.set(id, 'pending'));
  const chunks = [];
  for (let i = 0; i < missing.length; i += 100) chunks.push(missing.slice(i, i + 100));
  // Fetch all chunks CONCURRENTLY. Awaiting them sequentially serialized ~10
  // round-trips of ~1.7 MB each on a cold load — multiple seconds during which every
  // routed vehicle holds frozen at its last fix waiting for its geometry. Parallel,
  // the whole set lands in ~one round-trip (browser caps concurrency itself).
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const r = await fetch(`${API_BASE}/api/shapes?ids=${chunk.join(',')}`);
      if (!r.ok) { chunk.forEach((id) => shapes.delete(id)); return; }
      const data = await r.json();
      const toCache = new Map();
      for (const id of chunk) {
        shapes.set(id, buildShape(data[id]));
        if (data[id] && data[id].length) toCache.set(id, data[id]);   // persist RAW geometry
      }
      if (toCache.size) idbPutShapes(toCache);                          // survive refresh (IndexedDB)
      routesDirty = true;
    } catch { chunk.forEach((id) => shapes.delete(id)); }
  }));
}

// --- IndexedDB shape cache --------------------------------------------------
// Static GTFS geometry survives a refresh locally. WHY: /api/shapes is HTTP-cacheable
// for 24 h, but the cache key is the whole `?ids=` batch URL, and the batch composition
// shifts as the live fleet changes — so a refresh is a near-total cache MISS that
// re-downloads ~3.8 MB / ~1.2 s, during which every routed vehicle holds frozen at its
// last fix. Keyed per shape_id in IndexedDB, a refresh hydrates geometry in ~ms and
// motion starts at once (the snapshot already carries sd+vsd). Busted only when the
// server's gtfs_meta.last_ingest (surfaced as meta.gtfsVersion) changes — i.e. when
// PID republishes its GTFS feed.
const IDB_NAME = 'tep', IDB_SHAPES = 'shapes', IDB_META = 'meta';
let _idb = null;
function idbOpen() {
  return new Promise((resolve) => {
    if (_idb || typeof indexedDB === 'undefined') return resolve(_idb);
    let req;
    try { req = indexedDB.open(IDB_NAME, 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_SHAPES)) db.createObjectStore(IDB_SHAPES);
      if (!db.objectStoreNames.contains(IDB_META)) db.createObjectStore(IDB_META);
    };
    req.onsuccess = () => { _idb = req.result; resolve(_idb); };
    req.onerror = () => resolve(null);
  });
}
function idbStore(name, mode) {
  try { return _idb ? _idb.transaction(name, mode).objectStore(name) : null; } catch { return null; }
}
function idbGetAllShapes() {
  return new Promise((resolve) => {
    const os = idbStore(IDB_SHAPES, 'readonly'); if (!os) return resolve(null);
    const out = new Map();
    const cur = os.openCursor();
    cur.onsuccess = (e) => { const c = e.target.result; if (c) { out.set(c.key, c.value); c.continue(); } else resolve(out); };
    cur.onerror = () => resolve(out);
  });
}
function idbPutShapes(map) {
  const os = idbStore(IDB_SHAPES, 'readwrite'); if (!os) return;
  try { for (const [k, v] of map) os.put(v, k); } catch { /* quota / db closing */ }
}
function idbClearShapes() { const os = idbStore(IDB_SHAPES, 'readwrite'); if (os) try { os.clear(); } catch {} }
function idbGetMeta(k) {
  return new Promise((resolve) => {
    const os = idbStore(IDB_META, 'readonly'); if (!os) return resolve(null);
    const r = os.get(k); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null);
  });
}
function idbPutMeta(k, v) { const os = idbStore(IDB_META, 'readwrite'); if (os) try { os.put(v, k); } catch {} }

// Hydrate the in-memory shape map from IDB BEFORE the first snapshot (optimistic — a
// warm refresh routes vehicles instantly), then validate the GTFS epoch in the
// background and drop the cache if PID has republished since it was written.
async function initShapeCache() {
  await idbOpen();
  if (!_idb) return;
  try {
    const cached = await idbGetAllShapes();
    if (cached) for (const [id, raw] of cached) { if (!shapes.has(id)) shapes.set(id, buildShape(raw)); }
    if (cached && cached.size) routesDirty = true;
  } catch { /* ignore — fall through to the network path */ }
  validateShapeCache();   // NOT awaited: never delay first paint on the version check
}
async function validateShapeCache() {
  try {
    const r = await fetch(`${API_BASE}/api/meta`); if (!r.ok) return;
    const ver = (await r.json()).gtfsVersion;
    if (!ver) return;
    const stored = await idbGetMeta('gtfsVersion');
    if (stored == null) { idbPutMeta('gtfsVersion', ver); return; }   // first run: record, don't wipe
    if (stored !== ver) {
      // PID republished GTFS — cached geometry may be stale. Drop the store and clear
      // the in-memory map so the next snapshot tick re-fetches fresh shapes (one slow
      // refresh, warm again thereafter).
      idbClearShapes(); idbPutMeta('gtfsVersion', ver);
      shapes.clear(); routesDirty = true;
    }
  } catch { /* offline / no meta — keep using the cache */ }
}

// --- interpolation state ----------------------------------------------------
const fleet = new Map();
let stopsList = [];            // [[lon,lat,name],...] kept for the command palette search
const stopPos = new Map();     // station name -> [lon,lat] (for the hybrid-motion ETA anchor)
const nsSdCache = new Map();   // `${shapeId}|${stopName}` -> chainage km | null (next-stop projection cache)
let mapReady = false;
let lastSnapshotT = 0;
let replayActive = false;      // true while the Time Machine owns the view (live render muted)

// --- 3D vehicle layer state (motion model above is UNTOUCHED) ---------------
let veh3d = null;                                       // controller from init3DLayer
let render3D = localStorage.getItem('pid3d') !== '0';   // 3D is the default; only an explicit 2D pick ('0') opts out
let dotsShown = true;                                   // current veh-dot/halo visibility (avoids per-frame churn)
let nightGlow = NIGHT_AT_LOAD;                          // night-mode 2D vehicle glow (headlight feel for the dots); follows the basemap theme
let lastDots2D = 0;                                     // last 2D-dot setData timestamp (throttle the GeoJSON rebuild ~30Hz)
const DOTS_2D_MS = 33;                                  // ~30fps cap for the 2D dot rebuild (dead-reckoning makes finer pointless)

const propsOf = (v) => ({
  id: v.id, line: v.line, mode: v.mode, color: v.color || '#7A8290',
  spd: v.spd, dl: v.dl, hdsg: v.hdsg || '',
  // Rich per-vehicle fields (worker source.js). All may be null/absent — guard on read.
  st: v.st ?? null,        // state_position: 'at_stop' | 'on_track'
  reg: v.reg ?? null,      // fleet (registration) number
  model: v.model ?? null,  // rolling-stock model (e.g. "Tatra T3R.P") — drives the 3D silhouette/livery CLASS
  ac: v.ac ?? null, usb: v.usb ?? null, wheel: v.wheel ?? null, // amenity booleans
  op: v.op ?? null,        // operator, e.g. "DPP"
  canc: v.canc ?? null,    // is_canceled bool
  tnum: v.tnum ?? null,    // train / trip short number
  ns: v.ns ?? null,        // next stop {name, eta(sec), seq}
});

// --- rich per-vehicle data rendering (item C) -------------------------------
// Shared dark-theme styles + HTML builders used by BOTH the veh-dot popup (here)
// and the Selected card (controls.js, via the helpers passed into initControls),
// so the two surfaces render identical badges. Every field is guarded (nullable).
(() => {
  if (document.getElementById('rich-style')) return;
  const s = document.createElement('style');
  s.id = 'rich-style';
  s.textContent = `
    .rich { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 6px; }
    .rb { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; line-height: 1;
          padding: 3px 7px; border-radius: 999px; background: rgba(255,255,255,0.08);
          color: var(--text); border: 1px solid rgba(255,255,255,0.12); white-space: nowrap; }
    .rb.dwell-stop { background: rgba(46,204,113,0.16); border-color: rgba(46,204,113,0.45); color: #8fe7b4; }
    .rb.dwell-go { background: rgba(255,255,255,0.06); color: var(--muted); }
    .rb.canc { background: rgba(210,25,44,0.18); border-color: rgba(210,25,44,0.55); color: #ff8a93;
               font-weight: 800; letter-spacing: 0.4px; }
    .rb.amen { padding: 3px 6px; }
    .rich-next { margin-top: 6px; font-size: 12px; color: var(--text); }
    .rich-next .eta { color: var(--demo); font-weight: 700; }
    .rich-meta { margin-top: 4px; font-size: 11px; color: var(--muted); }
    .rich-meta b { color: var(--text); font-weight: 700; }`;
  document.head.appendChild(s);
})();

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmtEta(sec) {
  if (sec == null) return null;
  if (sec <= 0) return 'due';
  if (sec < 60) return `${sec}s`;
  return `${Math.round(sec / 60)} min`;
}
// Dwell badge: "● At stop" when state_position is 'at_stop', else "→ En route".
function dwellBadge(p) {
  if (!p || p.st == null) return '';
  const atStop = p.st === 'at_stop';
  return `<span class="rb ${atStop ? 'dwell-stop' : 'dwell-go'}">${atStop ? '● At stop' : '→ En route'}</span>`;
}
// Amenity icons (only when explicitly true): ♿ wheelchair, ❄ a/c, USB.
function amenitiesHtml(p) {
  if (!p) return '';
  const out = [];
  if (p.wheel === true) out.push('<span class="rb amen" title="Wheelchair accessible">♿</span>');
  if (p.ac === true) out.push('<span class="rb amen" title="Air conditioned">❄</span>');
  if (p.usb === true) out.push('<span class="rb amen" title="USB charging">USB</span>');
  return out.join('');
}
// The badge row: cancelled flag + dwell + amenities.
function badgeRow(p) {
  if (!p) return '';
  const inner = `${p.canc === true ? '<span class="rb canc">CANCELLED</span>' : ''}${dwellBadge(p)}${amenitiesHtml(p)}`;
  return inner ? `<div class="rich">${inner}</div>` : '';
}
// Next stop line: "Next: <name> · <ETA>".
function nextStopHtml(p) {
  if (!p || !p.ns || !p.ns.name) return '';
  const eta = fmtEta(p.ns.eta);
  return `<div class="rich-next">Next: <b>${esc(p.ns.name)}</b>${eta ? ` · <span class="eta">${esc(eta)}</span>` : ''}</div>`;
}
// Fleet # / operator / train # meta line(s).
function richMetaHtml(p) {
  if (!p) return '';
  const bits = [];
  if (p.reg != null && p.reg !== '') bits.push(`Vehicle <b>#${esc(p.reg)}</b>`);
  if (p.op != null && p.op !== '') bits.push(`<b>${esc(p.op)}</b>`);
  if (p.tnum != null && p.tnum !== '') bits.push(`Train <b>#${esc(p.tnum)}</b>`);
  return bits.length ? `<div class="rich-meta">${bits.join(' · ')}</div>` : '';
}
// Full rich block (badges + next stop + meta) shared by popup and Selected card.
function richBlockHtml(p) {
  return `${badgeRow(p)}${nextStopHtml(p)}${richMetaHtml(p)}`;
}
const richHtml = { badgeRow, nextStopHtml, richMetaHtml, richBlockHtml, fmtEta, dwellBadge, amenitiesHtml };

// --- control-panel state (mutated by controls.js, read here every frame) -----
// Filter modes are GROUPS: the 5 primary modes plus an "other" bucket for the
// long tail (ferry/funicular/cablecar/gondola/other), so the panel stays compact.
const FILTER_MODES = [
  ['tram', 'Tram', '#D2192C'], ['metro', 'Metro', '#00A562'], ['bus', 'Bus', '#007DA8'],
  ['train', 'Train', '#1A66B0'], ['trolleybus', 'Trolleybus', '#8E44AD'], ['other', 'Other', '#7A8290'],
];
const PRIMARY_MODES = new Set(['tram', 'metro', 'bus', 'train', 'trolleybus']);
const PIN_MINZOOM = 15;        // pins accompany the 3D meshes (same threshold) — below this the 2D
                              // dots + their veh-label line numbers carry the labelling, so no gap.
const PIN_CAP = 160;           // hard cap on simultaneously-rendered pins (perf)
const SELECT_HEX = '#ffd400';  // highlight tint for the selected vehicle's mesh

const ui = {
  modes: new Set(FILTER_MODES.map((m) => m[0])), // all groups enabled initially
  lines: [],                                      // active line filter — a SET of lines (uppercased); [] = all
  pins: true,                                     // show floating line pins in 3D
  selectedId: null,                               // picked vehicle id (highlight + follow)
  follow: false,                                  // camera tracks the selected vehicle
};
const lineKey = (l) => String(l == null ? '' : l).trim().toUpperCase();
const filterGroup = (mode) => (PRIMARY_MODES.has(mode) ? mode : 'other');
function passesFilter(v) {
  const p = v.props;
  if (!ui.modes.has(filterGroup(p.mode))) return false;
  if (ui.lines.length && !ui.lines.includes(lineKey(p.line))) return false; // ANY-of the picked lines
  return true;
}

let pins = null, chaseCam = null, timeMachine = null, car = null;
let lastCarTs = 0;   // previous frame timestamp for the car physics dt
let reducedMotion = false;                       // prefers-reduced-motion (set at map load)
const motionMs = (ms) => (reducedMotion ? 0 : ms); // zero camera-ease durations when reduced motion is on
// Push the current selection (props + follow flag) into the React bridge so the
// VehicleCard / Narration surfaces update. Replaces the old controls.updateSelection.
function pushSelected() {
  const v = ui.selectedId != null ? fleet.get(ui.selectedId) : null;
  selSlice.set(v ? { props: { ...v.props, kmh: v.kmh ?? null, moving: v.moving ?? null }, follow: ui.follow } : null);
}
// Reflect the live ui.modes/ui.line filter into the React bridge (checkbox state).
function syncFiltersSlice() {
  const modes = {};
  for (const [k] of FILTER_MODES) modes[k] = ui.modes.has(k);
  filtersSlice.set({ modes, lines: ui.lines.slice() });
}
function selectVehicle(id) {
  ui.selectedId = id;
  panelsSlice.patch({ cardHidden: false });        // (re)selecting always shows the card
  stopSlice.set(null);                             // a vehicle and a stop card never co-exist
  pushSelected();
  scheduleUrlSync();                               // item E: sel=<id>
}
function clearSelection() {
  ui.selectedId = null;
  ui.follow = false;
  panelsSlice.patch({ cardHidden: false });        // reset for the next selection
  stopChase();                                   // item F: release the chase camera
  pushSelected();
  const src = map.getSource('sel');
  if (src) src.setData({ type: 'FeatureCollection', features: [] });
  scheduleUrlSync();                             // item E: reflect cleared sel/follow in the URL
}

// The forward-prediction integrator lives in stepMotion() (run once per frame);
// the rendered chainage is kept in v.sd and the samplers below read it directly.

// On-rail position: chainage along the loaded shape, WITHOUT the error offset.
// Returns null when the shape isn't usable yet (caller falls back to point mode).
// hdg is the EASED heading (v.hdgE, advanced once/frame in easeHeadings) so the
// per-vertex tangent snap is smoothed; the lateral track offset (item A) uses it
// too. Falls back to the raw tangent until the easer has initialised v.hdgE.
function railPos(v) {
  const shape = v.shp ? shapes.get(v.shp) : null;
  if (shape && shape !== 'pending' && shape.hasDist && v.sd != null) {
    const p = pointAtDist(shape, v.sd);
    if (p) {
      const hdg = v.hdgE != null ? v.hdgE : p[2];
      return offsetRight({ lon: p[0], lat: p[1], hdg }, v.props && v.props.mode, endFade(v.sd, shape.total));
    }
  }
  return null;
}

// Straight-line point-mode position (raw GPS lerp), WITHOUT the error offset.
// Used until the route shape loads, and as the from-anchor we smooth away from.
// Also returns the eased heading; track offset applies at full strength (no shape
// ends to fade against in point mode).
function pointPos(v, ts) {
  const t = v.dur > 0 ? Math.min(1, (ts - v.t0) / v.dur) : 1;
  const raw = v.brg != null ? v.brg : bearingDeg(v.fromLon, v.fromLat, v.toLon, v.toLat);
  const p = {
    lon: lerp(v.fromLon, v.toLon, t),
    lat: lerp(v.fromLat, v.toLat, t),
    hdg: v.hdgE != null ? v.hdgE : raw,
  };
  return offsetRight(p, v.props && v.props.mode, 1);
}

// Raw (un-eased, un-offset) heading tangent at the vehicle's CURRENT chainage —
// the target the per-frame easer steers v.hdgE toward. Mirrors railPos/pointPos
// geometry but returns only the bearing.
function rawHeading(v) {
  const shape = v.shp ? shapes.get(v.shp) : null;
  if (shape && shape !== 'pending' && shape.hasDist && v.sd != null) {
    const p = pointAtDist(shape, v.sd);
    if (p) return p[2];
  }
  return v.brg != null ? v.brg : bearingDeg(v.fromLon, v.fromLat, v.toLon, v.toLat);
}

// Add the decaying corrective offset. LINEAR decay = CONSTANT catch-up speed
// (no front-loaded lurch — the old k² ease moved ~71 m in the first frame for a
// 500 m correction). ~0/no-op when motion was continuous (eT0 null or k≤0).
function applyError(v, ts, p) {
  if (v.eT0 == null) return p;
  const k = 1 - (ts - v.eT0) / (v.eDur || SMOOTH_MS);
  if (k > 0) { p.lon += v.eLon * k; p.lat += v.eLat * k; }
  return p;
}

// Slide duration to ease a `gapM`-metre correction at the constant catch-up
// speed, clamped: tiny gaps still ease over SMOOTH_MS, huge ones cap at MAX.
function slideDur(gapM) {
  return Math.max(SMOOTH_MS, Math.min(SMOOTH_MAX_MS, (gapM / CATCHUP_MPS) * 1000));
}

// Routed vehicle whose shape isn't usable yet (still fetching, or bad geometry):
// HOLD at the last real GPS fix instead of straight-line-lerping across the gap —
// that lerp is exactly what cut chords through buildings. It snaps onto the
// polyline the instant the shape lands (stepMotion + renderPos then carry it
// smoothly along the track).
function holdAtFix(v) {
  return { lon: v.toLon, lat: v.toLat, hdg: v.hdgE != null ? v.hdgE : (v.brg != null ? v.brg : 0) };
}

// The rendered position. INVARIANT: a routed vehicle (has chainage) is ALWAYS on
// its polyline — we render straight at railPos with NO lat/lon offset, so it can
// never drift off the line. Reconciliation happens along the chainage (stepMotion,
// forward-only) + the renderPos speed limiter. Only a genuine no-chainage feed
// (rare) falls back to the smoothed GPS lerp.
function curState(v, ts) {
  const rp = railPos(v);
  if (rp) return rp;                            // ON the polyline — never nudged off it
  if (v.sd != null) return holdAtFix(v);        // routed but shape not ready → hold at the real fix
  return applyError(v, ts, pointPos(v, ts));    // genuine point-mode → smoothed GPS lerp
}

// renderPos — the position actually DRAWN each frame. It wraps curState with a
// universal per-frame SPEED LIMITER: a dot may never move more than the vehicle
// plausibly could this frame (≈1.4×vmax). This is a final-stage safety net that
// catches "stupidly fast" darts from ANY cause — most importantly bad GTFS shape
// geometry (a teleporting vertex maps a tiny chainage step to a 60-150 m spatial
// jump). Memoized per (v, ts) so the 2D draw / pins / selection all agree and it
// costs one compute per vehicle per frame. NOT used by applySnapshot's gap math
// (that needs the raw curState) — only by the draw path.
function renderPos(v, ts) {
  if (v.rTs === ts && v.rCache) return v.rCache;
  const p = curState(v, ts);
  if (v.warp) {
    // Legitimate discontinuity (new trip / shape change / real reversal): jump
    // straight onto the new on-rail point this frame — do NOT clamp, or it would
    // slow-slide a straight chord across the map (off the line) to get there.
    v.warp = false;
  } else if (v.rLon != null && v.rPosTs != null && ts > v.rPosTs) {
    const dt = ts - v.rPosTs;
    const maxMoveM = vmaxKmMs(v.props && v.props.mode) * 1.4 * 1000 * dt; // metres this frame at 1.4×vmax
    const movedM = distMeters(v.rLon, v.rLat, p.lon, p.lat);
    if (movedM > maxMoveM && movedM > 0) {                 // clamp the dart toward the target
      const f = maxMoveM / movedM;
      p.lon = v.rLon + (p.lon - v.rLon) * f;
      p.lat = v.rLat + (p.lat - v.rLat) * f;
    }
  }
  v.rLon = p.lon; v.rLat = p.lat; v.rPosTs = ts; v.rTs = ts; v.rCache = p;
  return p;
}

// Position + heading `backMeters` BEHIND the vehicle's current chainage along its
// shape (negative = ahead). The 3D layer uses this to place each car of an
// articulated vehicle on the real track, so it bends through curves. backMeters=0
// equals curState; point-mode (no shape yet) projects back along the heading.
function sampleAlong(v, ts, backMeters) {
  const shape = v.shp ? shapes.get(v.shp) : null;
  if (shape && shape !== 'pending' && shape.hasDist && v.sd != null) {
    const sdKm = v.sd - backMeters / 1000;
    const p = pointAtDist(shape, sdKm);
    if (p) {
      // EASED heading (body-rigid: same v.hdgE for every chord sample so trucks
      // don't fan out) + the SAME right-of-heading track offset curState uses, so
      // body centre and both trucks sit on the offset parallel track together.
      const hdg = v.hdgE != null ? v.hdgE : p[2];
      const off = offsetRight({ lon: p[0], lat: p[1], hdg }, v.props && v.props.mode, endFade(sdKm, shape.total));
      return off; // routed: stay exactly on the (offset) rail — no lat/lon error nudge
    }
  }
  const st = curState(v, ts); // already offset + eased
  if (!backMeters) return st;
  const rad = Math.PI / 180;
  const lat2 = st.lat - (backMeters * Math.cos(st.hdg * rad)) / 111320;
  const lon2 = st.lon - (backMeters * Math.sin(st.hdg * rad)) / (111320 * Math.cos(st.lat * rad));
  return { lon: lon2, lat: lat2, hdg: st.hdg };
}

const map = new maplibregl.Map({
  container: 'map', style: MAP_STYLE,
  // Boot zoomed in + tilted so the default 3D view actually shows the tram models
  // (meshes need zoom >= MESH_MINZOOM). A camera hash in the URL still overrides this.
  center: [14.4213, 50.0875], zoom: 15.5, pitch: 50, hash: true, maxPitch: 60, attributionControl: { compact: true },
});
// Native controls live BOTTOM-right so they never collide with the floating app
// bar (which is a compact island up top, not a full-width strip).
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true, showZoom: true }), 'bottom-right');
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), 'bottom-right');

// Every app source + layer (route lines, heatmap, stops, vehicles + halo/dot/label,
// selection ring) PLUS the 3D vehicle custom layer and the 3D buildings. Factored
// out so it runs on the initial 'load' AND can be re-run after a basemap setStyle()
// swap (which wipes the entire style). veh3d is created before the first call so the
// custom layer can slot in below 'veh-label'.
function addAppLayers() {
  // Aerial photo overlay (Layers toggle). A raster basemap laid over the vector
  // tiles but BENEATH the vector label layer, so street/place names stay legible
  // on top of the imagery; our routes/stops/vehicles (added below) sit above it.
  // Esri World Imagery: global, ~0.3 m in cities (incl. Prague), free with
  // attribution, no key. TODO: upgrade to IPR Praha / ČÚZK ortophoto WMTS for
  // higher-res + historical years (pairs with the Time Machine) once verified.
  map.addSource('aerial', {
    type: 'raster',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  });
  let firstSymbol;
  for (const l of map.getStyle().layers) { if (l.type === 'symbol') { firstSymbol = l.id; break; } }
  map.addLayer({
    id: 'aerial', type: 'raster', source: 'aerial',
    layout: { visibility: layersSlice.get().aerial ? 'visible' : 'none' },
    paint: { 'raster-opacity': 1, 'raster-fade-duration': 250 },
  }, firstSymbol);

  map.addSource('routes', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'route-lines', type: 'line', source: 'routes',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 15, 3.5],
      'line-opacity': 0.35,
    },
  });

  // Delay heatmap — geographic avg-delay overlay, hidden until toggled in Layers.
  // Fed on demand from /api/analytics/heatmap (weight = normalized avg delay).
  map.addSource('heat', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'heatmap', type: 'heatmap', source: 'heat', layout: { visibility: 'none' },
    paint: {
      'heatmap-weight': ['interpolate', ['linear'], ['get', 'w'], 0, 0.05, 1, 1],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 4.5],
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 10, 22, 16, 55],
      // The feed is bucketed into a ~500m grid, so at street zoom each cell renders
      // as an isolated fixed-radius bullseye (not a smooth field) — the density read
      // stops making sense well before street level. The heatmap is an OVERVIEW
      // layer: hold it to ~z11.5, then fade it out FAST so it's gone by ~z13.5,
      // where per-vehicle delay is the right read instead.
      'heatmap-opacity': ['interpolate', ['linear'], ['zoom'], 11.5, 0.7, 12.5, 0.45, 13.5, 0],
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(0,0,0,0)', 0.2, '#2ee68a', 0.45, '#f5d90a', 0.7, '#f0820a', 1, '#d2192c'],
    },
  });

  map.addSource('stops', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'stops', type: 'circle', source: 'stops', minzoom: 14,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 2, 17, 4],
      'circle-color': '#ffffff', 'circle-stroke-color': '#333', 'circle-stroke-width': 1,
      'circle-opacity': 0.9,
    },
  });

  map.addSource('vehicles', { type: 'geojson', data: { type: 'FeatureCollection', features: [] }, promoteId: 'id' });
  // Delay-on-the-dot: the halo encodes PUNCTUALITY (the attention axis) while the
  // dot below keeps the mode color (identity axis). GPU-evaluated, zero per-frame
  // JS. CRITICAL null guard: dl is nullable AND 0 == on-time, so a bare ramp would
  // coerce unknown (null) → 0 → green (a correctness lie). We case on typeof first:
  // a real number ramps early→azure / ontime→green / late→amber→orange→red; an
  // unknown delay stays a faint neutral grey ring.
  // Night-only vehicle GLOW — a soft warm-white pool under each dot so the whole
  // fleet reads as "lit" after dark (the headlight feel the 3D meshes already get,
  // extended to every vehicle at every zoom). Bottom of the vehicle stack, large +
  // heavily blurred. Visibility is gated by applyVehGlow() to (night AND 2D dots
  // active) — in 3D mesh zoom the real head/tail lights take over, so it hides.
  map.addLayer({
    id: 'veh-glow', type: 'circle', source: 'vehicles',
    layout: { visibility: 'none' },
    paint: {
      // PERF: kept small — big blurred circles × ~2000 dots is heavy GPU fill. A
      // tight, lightly-blurred warm pool still reads as "lit" without the overdraw.
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 9, 16, 13],
      'circle-color': '#ffe7b0',          // warm headlight white
      'circle-blur': 0.7,                  // soft-ish pool, not a hard disc
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 10, 0.16, 14, 0.28, 16, 0.36],
      'circle-pitch-alignment': 'map',     // lies flat on the ground plane when tilted
    },
  });
  map.addLayer({
    id: 'veh-halo', type: 'circle', source: 'vehicles',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 6, 14, 11, 16, 16],
      // Null guard WITHOUT `typeof` (MapLibre has no typeof): coalesce dl to a
      // sentinel; if it's the sentinel the delay is unknown → neutral grey ring.
      // Otherwise dl is a real number (0 included) and ramps early→late.
      'circle-color': [
        'case', ['==', ['coalesce', ['get', 'dl'], -99999], -99999],
        '#7A8290',           // unknown delay → neutral
        ['interpolate', ['linear'], ['get', 'dl'],
          -120, '#3b9eff',   // running early → azure
          0, '#2ee68a',      // on time → green
          120, '#f5d90a',    // ~2 min late → amber
          240, '#f0820a',    // ~4 min late → orange
          420, '#d2192c'],   // 7+ min late → red
      ],
      'circle-opacity': [
        'case', ['==', ['coalesce', ['get', 'dl'], -99999], -99999], 0.10, 0.34,
      ],
    },
  });
  map.addLayer({
    id: 'veh-dot', type: 'circle', source: 'vehicles',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 14, 6.5, 16, 9],
      'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.4,
    },
  });
  map.addLayer({
    id: 'veh-label', type: 'symbol', source: 'vehicles', minzoom: 13,
    layout: {
      'text-field': ['get', 'line'], 'text-font': ['Noto Sans Bold'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 13, 10, 16, 12], 'text-allow-overlap': false,
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': ['get', 'color'], 'text-halo-width': 1.6 },
  });

  // Selection highlight: a bright ring tracking the picked vehicle (works in 2D
  // and 3D — drawn on the map plane; updated each frame in animate()).
  map.addSource('sel', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'sel-ring', type: 'circle', source: 'sel',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 18, 16, 24],
      'circle-color': 'rgba(255,212,0,0.12)',
      'circle-stroke-color': SELECT_HEX, 'circle-stroke-width': 2.5,
    },
  });

  // 3D vehicle custom layer (guarded): insert BELOW 'veh-label' so labels draw over
  // meshes. veh3d is created before addAppLayers() runs (see the load handler).
  if (veh3d && veh3d.supported && !map.getLayer(veh3d.customLayer.id)) {
    map.addLayer(veh3d.customLayer, 'veh-label');
  }
  addBuildings3D();   // urban 3D massing — controllable via the Layers "3D buildings" toggle
}

map.on('load', () => {
  // The 3D layer controller is created FIRST: addAppLayers() inserts its custom
  // layer, and re-adding after a style swap reuses this SAME controller (its
  // onRemove is a no-op + onAdd rebuilds the scene — built for style reloads).
  veh3d = init3DLayer(map, { meshProvider: proceduralMeshProvider() });
  if (!veh3d.supported) render3D = false; // no WebGL2/instancing -> stay 2D forever
  addAppLayers();

  // Click a vehicle → select it. Details render in the React VehicleCard (the old
  // MapLibre HTML popup was removed — it clashed with the component-library chrome).
  map.on('click', 'veh-dot', (e) => {
    const p = e.features[0].properties;
    selectVehicle(p.id);
    const v = fleet.get(p.id);
    if (v) { const s = curState(v, performance.now()); map.easeTo({ center: [s.lon, s.lat], duration: motionMs(350) }); }
  });
  map.on('mouseenter', 'veh-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'veh-dot', () => { map.getCanvas().style.cursor = ''; });

  // Stops: click → StopCard (station name + live arrivals); hover → pointer.
  map.on('click', 'stops', (e) => {
    const f = e.features && e.features[0]; if (!f) return;
    const name = f.properties && f.properties.name;
    const c = (f.geometry && f.geometry.coordinates) || [e.lngLat.lng, e.lngLat.lat];
    if (!name) return;
    if (ui.selectedId != null) clearSelection();   // stop + vehicle card never co-exist
    stopSlice.set({ name, lon: c[0], lat: c[1] });
  });
  map.on('mouseenter', 'stops', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'stops', () => { map.getCanvas().style.cursor = ''; });
  // A user-initiated PAN cancels follow (the camera would otherwise fight a drag
  // that's deliberately moving away from the vehicle).
  const userGesture = (e) => {
    if (e.originalEvent && ui.follow) {
      ui.follow = false;
      stopChase();                                 // item F: release the chase camera on manual gesture
      pushSelected();
      scheduleUrlSync();                            // item E: follow=0 now
    }
  };
  map.on('dragstart', userGesture);
  // Zooming while following must NOT break follow — instead hand the user's chosen
  // zoom to the chase cam, which holds it (and keeps tracking position/bearing).
  // Gated on originalEvent so the chase cam's own jumpTo zoom changes don't recurse.
  map.on('zoom', (e) => {
    if (e.originalEvent && ui.follow && chaseCam) chaseCam.setZoom(map.getZoom());
  });

  applyRenderMode(true); // set initial layer visibility + pitch (no easeTo on init)
  viewSlice.set({ render3D, supports3D: !!(veh3d && veh3d.supported), reducedMotion });

  // Accessibility: honor prefers-reduced-motion for CAMERA eases (the per-vehicle
  // interpolation loop — the product — is NEVER gated; chrome animation is handled
  // by the globals.css @media block). motionMs() zeroes ease durations when set.
  try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reducedMotion = mq.matches;
    viewSlice.patch({ reducedMotion });
    mq.addEventListener('change', (e) => { reducedMotion = e.matches; viewSlice.patch({ reducedMotion }); });
  } catch { /* matchMedia absent — leave motion on */ }

  // Keep the React camera sliders in sync when the user drag-tilts/rotates the map.
  const syncCamSlice = () => cameraSlice.set({ pitch: Math.round(map.getPitch()), bearing: Math.round((map.getBearing() + 360) % 360) });
  map.on('pitch', syncCamSlice);
  map.on('rotate', syncCamSlice);
  syncCamSlice();

  // --- chase camera (item F): created AFTER veh3d so it can compose with the
  // custom 3D layer's camera. updateSelectionAndFollow() drives it. Guarded so a
  // chase-cam fault never blanks the map (follow falls back to map.jumpTo).
  try { chaseCam = initChaseCam(map); } catch (err) { chaseCam = null; console.warn('[chaseCam] init failed:', err && err.message); }

  // Drivable arcade car (WASD/arrows). Controller only — its pose is fed to
  // veh3d.setCar() + the chase cam each frame in animate() while driving. The
  // canMove predicate blocks driving INTO 3D buildings: project the candidate
  // ground point and hit-test the building-footprint layer. If buildings are
  // hidden/absent the car roams freely (no footprints to collide with).
  car = initCar({
    canMove: (lon, lat) => {
      if (!map.getLayer || !map.getLayer('buildings-3d')) return true;
      try {
        if (map.getLayoutProperty('buildings-3d', 'visibility') === 'none') return true;
        const pt = map.project([lon, lat]);
        if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) return true;
        const hits = map.queryRenderedFeatures(pt, { layers: ['buildings-3d'] });
        return !hits || hits.length === 0;
      } catch { return true; }
    },
  });

  // Floating line pins (3D). The control panel / HUD / dashboard are the React island.
  pins = initPins({ map, onSelect: (id) => selectVehicle(id) });

  // --- register the command + data registry the React chrome dispatches to ----
  const setMapLayer = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
  const actions = {
    set2D: () => { if (render3D) { render3D = false; applyRenderMode(false); scheduleUrlSync(); } },
    set3D: () => { if (!render3D && veh3d && veh3d.supported) { render3D = true; applyRenderMode(false); scheduleUrlSync(); } },
    toggle3D: () => (render3D ? actions.set2D() : actions.set3D()),
    toggleFollow: () => {
      if (ui.selectedId == null) return;
      ui.follow = !ui.follow;
      pushSelected();
      scheduleUrlSync();
    },
    clearSelection: () => clearSelection(),
    closeStop: () => stopSlice.set(null),
    // Hide just the popup card while KEEPING the selection + follow alive (close
    // the card without losing the camera lock). Re-clicking the vehicle, or
    // selecting another, shows it again (selectVehicle resets cardHidden).
    hideCard: () => panelsSlice.patch({ cardHidden: true }),
    resetView: () => map.easeTo({ pitch: render3D ? 50 : 0, bearing: 0, duration: motionMs(500) }),
    share: (cb) => shareView(typeof cb === 'function' ? cb : () => {}),
    // filters
    setMode: (key, on) => { if (on) ui.modes.add(key); else ui.modes.delete(key); syncFiltersSlice(); scheduleUrlSync(); },
    // Multi-line filter: a SET of lines, match ANY. add/remove/clear/replace.
    addLine: (str) => { const v = lineKey(str); if (v && !ui.lines.includes(v)) { ui.lines = [...ui.lines, v]; syncFiltersSlice(); scheduleUrlSync(); } },
    removeLine: (str) => { const v = lineKey(str); if (ui.lines.includes(v)) { ui.lines = ui.lines.filter((l) => l !== v); syncFiltersSlice(); scheduleUrlSync(); } },
    setLines: (arr) => { ui.lines = [...new Set((arr || []).map(lineKey).filter(Boolean))]; syncFiltersSlice(); scheduleUrlSync(); },
    clearLines: () => { if (ui.lines.length) { ui.lines = []; syncFiltersSlice(); scheduleUrlSync(); } },
    setLine: (str) => actions.setLines(str ? [str] : []),          // back-compat (single)
    onPickLine: (line) => actions.addLine(line),                    // command palette / analytics row → add
    toggleTimeMachine: () => { if (timeMachine && timeMachine.toggle) timeMachine.toggle(); },
    // Time Machine replay (the React <TimeMachine/> panel drives the vanilla engine).
    replayLoad: (opts) => { if (timeMachine && timeMachine.load) timeMachine.load(opts); },
    replayPlayPause: () => { if (timeMachine && timeMachine.togglePlay) timeMachine.togglePlay(); },
    replayScrub: (frac) => { if (timeMachine && timeMachine.scrub) timeMachine.scrub(frac); },
    replaySetSpeed: (x) => { if (timeMachine && timeMachine.setSpeed) timeMachine.setSpeed(x); },
    // Snap back to the live feed (used by the "Live" pill + visibility resync).
    goLive: () => resyncLive(),
    // layers
    setLayer: (name, on) => {
      if (name === 'routes') setMapLayer('route-lines', on);
      else if (name === 'stops') setMapLayer('stops', on);
      else if (name === 'aerial') {
        setMapLayer('aerial', on);
        // Flat grey 3D massing over real photographed roofs reads wrong — auto-hide
        // the 3D buildings while aerial is on; restore the user's choice when off.
        setMapLayer('buildings-3d', on ? false : !!layersSlice.get().buildings);
      }
      else if (name === 'buildings') setMapLayer('buildings-3d', on);
      else if (name === 'heatmap') setHeatmap(on);
      else if (name === 'pins') ui.pins = !!on;
      layersSlice.patch({ [name]: !!on });
    },
    // 3D building see-through control (0..1). Live-applies to the extrusion layer
    // and records it in the layers slice so the Controls slider stays in sync.
    setBuildingOpacity: (v) => {
      const op = Math.max(0, Math.min(1, Number(v)));
      if (!Number.isFinite(op)) return;
      if (map.getLayer('buildings-3d')) map.setPaintProperty('buildings-3d', 'fill-extrusion-opacity', op);
      // When buildings turn see-through, x-ray the 3D fleet so vehicles behind
      // them stay visible (the building depth-buffer write would otherwise hide them).
      if (veh3d && veh3d.setXray) veh3d.setXray(op < 0.7);
      layersSlice.patch({ buildingOpacity: op });
    },
    // camera
    setPitch: (v) => map.setPitch(+v),
    setBearing: (v) => map.setBearing(+v),
    // selection / navigation
    selectVehicle: (id) => selectVehicle(id),
    flyToVehicle: (id) => {
      const v = fleet.get(id);
      if (v) { const s = curState(v, performance.now()); map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 15), ...(reducedMotion && { duration: 0 }) }); }
    },
    flyToStop: (lon, lat) => { if (isFinite(lon) && isFinite(lat)) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 15), ...(reducedMotion && { duration: 0 }) }); },
    // theme -> 3D night look + headlights
    setNight: (isNight) => { if (veh3d && veh3d.setNight) veh3d.setNight(!!isNight); applyBasemap(!!isNight); },
    // Drivable arcade car: enter forces 3D + a street-level zoom, spawns the car at
    // the map centre, hands the keyboard to the car, and the chase cam follows it.
    toggleCar: () => {
      if (!car || !veh3d || !veh3d.supported) return;
      if (car.active) {
        car.stop();
        veh3d.setCar(null);
        if (chaseCam) chaseCam.reset();
        try { map.keyboard.enable(); } catch { /* noop */ }
        if (veh3d.setXray) veh3d.setXray((layersSlice.get().buildingOpacity ?? 0.30) < 0.7);
        panelsSlice.set((s) => ({ ...s, driving: false }));
      } else {
        if (!render3D) actions.set3D();
        ui.follow = false; stopChase(); pushSelected();   // car owns the camera now (stopChase reset clears userZoom)
        const c = map.getCenter();
        car.start(c.lng, c.lat, map.getBearing());
        // Close third-person framing: hold the chase at a street-level zoom (the
        // default vehicle-chase ~16.5 sits too far out for a car). setZoom is the
        // chase cam's user-zoom override; it eases in from the current view.
        const CAR_ZOOM = 18.3;
        if (chaseCam) chaseCam.setZoom(CAR_ZOOM);
        if (map.getZoom() < 16.5) map.easeTo({ zoom: 17, duration: 400 });
        try { map.keyboard.disable(); } catch { /* noop */ }   // arrows steer, don't pan
        if (veh3d.setXray) veh3d.setXray(true);   // keep the car visible above buildings while driving
        panelsSlice.set((s) => ({ ...s, driving: true }));
      }
    },
  };
  setActions(actions);
  // Engine is live (actions wired + veh3d created). Let the theme controller
  // re-assert the night look now (its setNight at React mount may have been a no-op).
  try { window.dispatchEvent(new Event('pid-ready')); } catch { /* noop */ }
  // getSelScreen: project the SELECTED vehicle's live drawn position to screen px,
  // fresh against the current camera + motion. The React VehicleCard rAF-polls this
  // to anchor itself over the vehicle (no per-frame React re-render). Returns
  // { onScreen:false } when nothing is selected or the selection is filtered out.
  const getSelScreen = () => {
    if (ui.selectedId == null) return { onScreen: false };
    const sel = fleet.get(ui.selectedId);
    if (!sel || !passesFilter(sel)) return { onScreen: false };
    const s = renderPos(sel, performance.now());
    if (!s || !isFinite(s.lon) || !isFinite(s.lat)) return { onScreen: false };
    const pt = map.project([s.lon, s.lat]);
    return { x: pt.x, y: pt.y, onScreen: true };
  };
  // Sorted unique ACTIVE lines (for the multi-line filter's autocomplete): one
  // entry per line with its mode/color + live count, mode-ordered then natural.
  const getLines = () => {
    const order = Object.fromEntries(FILTER_MODES.map((m, i) => [m[0], i]));
    const m = new Map();
    for (const v of fleet.values()) {
      const p = v.props;
      if (!p || p.line == null || p.line === '') continue;
      const key = lineKey(p.line);
      const e = m.get(key);
      if (e) e.n += 1;
      else m.set(key, { key, line: String(p.line), mode: p.mode, color: p.color || '#7A8290', n: 1 });
    }
    return [...m.values()].sort((a, b) => {
      const am = order[a.mode] ?? 99, bm = order[b.mode] ?? 99;
      if (am !== bm) return am - bm;
      const an = parseInt(a.line, 10), bn = parseInt(b.line, 10);
      if (!isNaN(an) && !isNaN(bn) && an !== bn) return an - bn;
      return a.line.localeCompare(b.line, undefined, { numeric: true });
    });
  };
  setHelpers({ getFleet: () => fleet, getStops: () => stopsList, getSelScreen, getLines, apiBase: API_BASE });
  syncFiltersSlice();

  hydrateFromUrl();   // shareable URL state (item E): apply ?view/modes/line/sel/follow

  // Mount the React chrome island now that the engine's actions/helpers exist.
  try { mountUI(); } catch (err) { console.warn('[ui] mount failed:', err && err.message); }

  mapReady = true;
  requestAnimationFrame(animate);
  loadStops();
  start();

  // Ride-along narration rail is now a React chrome surface (reads selSlice).

  // Time Machine replay owns its own 'replay-veh' source/layer; we just mute the
  // live representation while it's active so the two never overlap.
  try {
    timeMachine = initTimeMachine({
      map, apiBase: API_BASE,
      // On-rail replay: project a historical chainage onto its shape (same as live).
      projectOnShape: (sid, d) => { const s = shapes.get(sid); return (s && s !== 'pending' && s.hasDist) ? pointAtDist(s, d) : null; },
      loadShapes: (ids) => { try { fetchMissingShapes(ids); } catch { /* ignore */ } },
      onEnter: () => {
        replayActive = true;
        setDots(false);
        if (veh3d && veh3d.supported) veh3d.hideMeshes();
        if (pins) pins.clear();
        const src = map.getSource('vehicles'); if (src) src.setData(EMPTY_FC);
      },
      onExit: () => { replayActive = false; },
      onOpenChange: (open) => panelsSlice.patch({ timeMachine: !!open }),
    });
  } catch (err) { console.warn('[timeMachine] init failed:', err && err.message); }
});

// 3D building extrusion. OpenFreeMap positron exposes an 'openmaptiles' vector
// source with a 'building' source-layer. Controllable via the Layers toggle
// (setLayer('buildings', …)). Guarded: skips silently if the source isn't present.
function addBuildings3D() {
  try {
    if (map.getLayer('buildings-3d')) return;
    if (!map.getSource('openmaptiles')) return;
    const beforeId = map.getLayer('veh-halo') ? 'veh-halo' : undefined;
    map.addLayer({
      id: 'buildings-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building',
      minzoom: 14,
      paint: {
        'fill-extrusion-color': '#aeb4c0',
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'],
          14, 0, 15.5, ['coalesce', ['get', 'render_height'], ['get', 'height'], 8]],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], ['get', 'min_height'], 0],
        'fill-extrusion-opacity': 0.30,   // default see-through: the fleet is the hero, buildings are context
      },
    }, beforeId);
    // Default opacity is below the x-ray threshold, so draw the fleet THROUGH the
    // glassy buildings from the start (otherwise vehicles behind them would cull).
    if (veh3d && veh3d.setXray) veh3d.setXray(true);
  } catch (err) {
    console.warn('[buildings-3d] skipped:', err && err.message);
  }
}

// --- basemap theme swap (live day/night flip) -------------------------------
// The basemap follows the chrome theme. Flipping themes mid-session calls
// applyBasemap(): setStyle() to the dark/light OpenFreeMap style, then on the
// resulting 'style.load' re-add every app layer + re-hydrate the data sources.
// Both styles share the 'openmaptiles' source, so the 3D buildings + custom WebGL
// fleet layer rebuild cleanly (vehicles3d onRemove is a no-op, onAdd rebuilds). The
// camera/hash are preserved by setStyle; vehicles/sel self-heal on the next frame.
let currentStyleUrl = MAP_STYLE;
function reAddAfterStyleSwap() {
  addAppLayers();                                   // re-add sources/layers + 3D layer + buildings
  const isNight = currentStyleUrl === STYLE_DARK;
  nightGlow = isNight;                               // 2D vehicle glow follows the basemap theme
  if (veh3d) {
    if (veh3d.invalidateColors) veh3d.invalidateColors(); // fresh InstancedMeshes → force color re-upload
    if (veh3d.setNight) veh3d.setNight(isNight);    // re-apply night dimming/headlights onto the rebuilt scene
  }
  // Re-added layers come back at their style defaults — restore the user's toggles.
  const L = layersSlice.get();
  const vis = (id, on) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'); };
  vis('route-lines', L.routes);
  vis('stops', L.stops);
  vis('aerial', L.aerial);
  vis('buildings-3d', L.buildings && !L.aerial); // aerial suppresses 3D massing
  const op = L.buildingOpacity ?? 0.30;
  if (map.getLayer('buildings-3d')) map.setPaintProperty('buildings-3d', 'fill-extrusion-opacity', op);
  if (veh3d && veh3d.setXray) veh3d.setXray(op < 0.7);
  // Re-hydrate data (vehicles/sel repopulate on the next animate() frame).
  rebuildRoutes();
  loadStops();
  setHeatmap(L.heatmap);
  applyRenderMode(true);                             // restore 2D/3D visibility + pitch, no animation
}
function applyBasemap(isNight) {
  const url = isNight ? STYLE_DARK : STYLE_LIGHT;
  if (url === currentStyleUrl) return;              // already on the right basemap
  currentStyleUrl = url;
  // Do NOT gate on map.isStyleLoaded(): the 3D custom layer calls triggerRepaint()
  // every frame, so the map is almost never reported "settled" and that guard would
  // bail here (after poisoning currentStyleUrl), leaving the LIVE day↔night flip
  // stuck until a full reload. applyBasemap only ever runs after the initial 'load'
  // (the theme engine starts on React mount, which is inside the map 'load' handler),
  // so calling setStyle directly is safe.
  map.once('style.load', reAddAfterStyleSwap);
  map.setStyle(url, { diff: false });               // full reload → clean custom-layer teardown/rebuild
}

// --- delay heatmap loader (Layers toggle) -----------------------------------
let heatTimer = 0;
async function loadHeatmap() {
  if (!API_BASE) return;
  try {
    const r = await fetch(`${API_BASE}/api/analytics/heatmap?window=60&step=0.005`);
    if (!r.ok) return;
    const d = await r.json();
    if (d.disabled || !Array.isArray(d.cells)) return;
    const features = d.cells.map((c) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
      // normalize avg delay → 0..1 weight (0 = on time, 1 ≈ +4 min late). Typical
      // delays are 15-60s, so a tight divisor is needed or the overlay is invisible.
      properties: { w: Math.max(0, Math.min(1, (c.avgDelaySec || 0) / 240)) },
    }));
    const src = map.getSource('heat');
    if (src) src.setData({ type: 'FeatureCollection', features });
  } catch { /* ignore — heatmap is best-effort */ }
}
function setHeatmap(on) {
  if (map.getLayer('heatmap')) map.setLayoutProperty('heatmap', 'visibility', on ? 'visible' : 'none');
  clearInterval(heatTimer);
  if (on) { loadHeatmap(); heatTimer = setInterval(loadHeatmap, 60000); }
}

map.on('error', (e) => console.warn('[map]', e && e.error && e.error.message));

function rebuildRoutes() {
  const features = [];
  for (const [id, s] of shapes) {
    if (s === 'pending' || !s.pts || s.pts.length < 2) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: s.pts },
      properties: { color: shapeColor.get(id) || '#94a3b8' },
    });
  }
  const src = map.getSource('routes');
  if (src) src.setData({ type: 'FeatureCollection', features });
}

async function loadStops() {
  if (!API_BASE) return;
  try {
    const r = await fetch(`${API_BASE}/api/stops`);
    if (!r.ok) return;
    const { stops } = await r.json();
    // PID GTFS lists every platform / post / direction as its OWN stop point, so a
    // single station (especially metro+tram+bus interchanges) is many coincident
    // dots. Collapse points sharing a name into ONE station marker at their centroid
    // — far less clutter, and a station is the meaningful unit to click / search.
    const byName = new Map();
    for (const s of (stops || [])) {
      const name = s[2]; if (!name) continue;
      let g = byName.get(name);
      if (!g) { g = { name, lon: 0, lat: 0, n: 0 }; byName.set(name, g); }
      g.lon += s[0]; g.lat += s[1]; g.n += 1;
    }
    const stations = [...byName.values()].map((g) => [g.lon / g.n, g.lat / g.n, g.name]);
    stopsList = stations;                             // command palette stop search + click
    stopPos.clear(); nsSdCache.clear();
    for (const s of stations) stopPos.set(s[2], [s[0], s[1]]); // name -> pos for the motion ETA anchor
    const features = stations.map((s) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [s[0], s[1]] }, properties: { name: s[2] } }));
    const src = map.getSource('stops');
    if (src) src.setData({ type: 'FeatureCollection', features });
  } catch {}
}

function applySnapshot(snap) {
  if (!snap || !Array.isArray(snap.v)) return;
  lastSnapshotT = snap.t || 0;
  const now = performance.now();
  const seen = new Set();
  const shapeIds = [];

  for (const nv of snap.v) {
    seen.add(nv.id);
    if (nv.shp) { shapeIds.push(nv.shp); if (nv.color) shapeColor.set(nv.shp, nv.color); }
    const ex = fleet.get(nv.id);
    if (!ex) {
      fleet.set(nv.id, {
        fromLon: nv.lon, fromLat: nv.lat, toLon: nv.lon, toLat: nv.lat,
        shp: nv.shp || null, spd: nv.spd, brg: nv.brg,
        t0: now, dur: MIN_DUR, ts: nv.ts || 0,
        // Forward-prediction state: the rendered chainage `sd` chases a dead-reckoned,
        // lead-capped, dwell-gated target `sdTarget` at the estimated speed `vSd`.
        // (null sd ⇒ the feed has no chainage for this vehicle ⇒ pure point-mode.)
        // SEED vSd from the worker's chainage-speed estimate so a freshly-loaded
        // vehicle dead-reckons IMMEDIATELY instead of freezing until its own 2nd fix
        // (~20-40s). Falls back to 0 when the field is absent (old feed).
        sd: nv.sd, sdTarget: nv.sd, vSd: (typeof nv.vsd === 'number' ? nv.vsd : 0),
        vRender: (typeof nv.vsd === 'number' ? nv.vsd : 0),  // rendered chainage velocity; seed = cold-start glide
        kmh: nv.spd != null && nv.spd !== '' ? Math.round(Number(nv.spd)) : null, moving: null,
        fixTs: nv.ts || Date.now(), fixMono: now, motT: now, dwell: nv.st === 'at_stop',
        eLon: 0, eLat: 0, eT0: null, eDur: SMOOTH_MS, railed: false,
        hdgE: nv.brg != null ? nv.brg : null, hdgET: null, // eased heading (item B), set on first sight
        props: propsOf(nv),
      });
      continue;
    }
    ex.props = propsOf(nv);
    ex.brg = nv.brg;
    ex.spd = nv.spd;
    const moved = nv.ts ? nv.ts > ex.ts : (nv.lon !== ex.toLon || nv.lat !== ex.toLat);
    if (!moved) continue;

    // Real elapsed time since the last fix — basis for the velocity estimate and
    // the "is this move physically possible?" test.
    const dt = nv.ts && ex.fixTs && nv.ts > ex.fixTs ? nv.ts - ex.fixTs : FALLBACK_DUR;

    let dbgBranch = 'glide', dbgImpliedKmh = 0, dbgFwdKm = 0;

    const st = curState(ex, now);                        // where the dot is RIGHT NOW (rendered)
    const farPt = distMeters(st.lon, st.lat, nv.lon, nv.lat) > JUMP_SNAP_M;
    // GPS-lerp anchors — used only until the route shape geometry loads (point mode).
    ex.fromLon = farPt ? nv.lon : st.lon;
    ex.fromLat = farPt ? nv.lat : st.lat;
    ex.toLon = nv.lon; ex.toLat = nv.lat;

    // --- forward-prediction retarget: update the truth anchor + speed estimate ---
    const shapeChanged = ex.shp !== (nv.shp || null);
    ex.shp = nv.shp || null;
    ex.dwell = nv.st === 'at_stop';                      // dwell gate parks the prediction at stops
    if (nv.sd == null) {
      // No chainage in the feed → pure point-mode (GPS lerp), no prediction.
      ex.sd = ex.sdTarget = null; ex.vSd = 0;
      dbgBranch = farPt ? 'point-snap' : 'point';
    } else if (shapeChanged || ex.sd == null || ex.sdTarget == null) {
      // New trip / first shaped fix → appear AT the fix on the rail, zero speed.
      ex.sd = ex.sdTarget = nv.sd; ex.vSd = 0; ex.vRender = 0; ex.warp = true;
      dbgBranch = 'newtrip';
    } else {
      const dSd = nv.sd - ex.sdTarget;                   // signed advance since the last fix (km)
      dbgFwdKm = dSd;
      const impliedKmh = (Math.abs(dSd) / Math.max(dt, 1)) * 3600000;
      dbgImpliedKmh = Math.round(impliedKmh);
      const bigDisc = Math.abs(dSd) > SD_SNAP_KM;        // big chainage discontinuity
      const backRev = dSd < -SD_BACK_KM;                 // real reversal / trip turnaround
      const tooFast = impliedKmh > SNAP_KMH;             // physically impossible → data jump
      if (bigDisc || backRev || tooFast) {
        // One clean correction: snap render + truth to the fix on the rail, reset
        // speed, and WARP so renderPos jumps there this frame (no off-rail chord).
        ex.sd = ex.sdTarget = nv.sd; ex.vSd = 0; ex.vRender = 0; ex.warp = true;
        dbgBranch = bigDisc ? 'snap-disc' : backRev ? 'snap-back' : 'snap-fast';
      } else {
        // NORMAL: update the forward velocity estimate (EMA, clamped ≥0 and ≤vmax)
        // and advance the truth anchor. Leave ex.sd (the RENDERED chainage) ALONE —
        // stepMotion reconciles it FORWARD-ONLY toward the new dead-reckoned target,
        // so a fix landing behind the prediction never reverses the render (the old
        // "backward teleport"). Backward GPS noise → vActual 0 ⇒ a brief hold/coast.
        const vActual = Math.max(0, dSd) / Math.max(dt, 1); // km/ms, never negative
        const vClamped = Math.min(vActual, vmaxKmMs(ex.props.mode));
        // Metro: the feed is dense (~5 s) and synthetic-feeling, so a fresh per-fix
        // self-estimate passes a ~24 km/h speed swing that the corrector renders as
        // jitter. The worker carries a cross-tick median+EMA of the SAME chainage speed
        // (source.js VSD_MEDIAN_MODES), so for metro we render that smoothed value
        // directly instead of the noisy self-estimate. Other modes self-estimate as before.
        if (ex.props.mode === 'metro' && typeof nv.vsd === 'number') {
          ex.vSd = Math.min(Math.max(0, nv.vsd), vmaxKmMs(ex.props.mode));
        } else {
          ex.vSd = lerp(ex.vSd != null ? ex.vSd : vClamped, vClamped, V_EMA);
        }
        ex.sdTarget = nv.sd;
        dbgBranch = dSd < -1e-9 ? 'hold-back' : (dSd < SD_MOVE_KM ? 'hold' : 'glide');
      }
    }

    // Fix clocks — stepMotion reads fixTs for latency-comp + the lead cap.
    ex.fixTs = nv.ts || (ex.fixTs + dt);
    ex.fixMono = now;
    ex.t0 = now;
    ex.dur = Math.max(MIN_DUR, Math.min(MAX_DUR, dt));
    ex.ts = nv.ts || ex.ts + 1;

    // Derived ground-truth speed for the Inspector: prefer the chainage velocity
    // estimate (vSd, km/ms → km/h) — reported `spd` is NULL for all rail. This is
    // what tells the card a tram is MOVING even though Golemio's state_position
    // over-reports 'at_stop' for trams (≈40% of the fleet at any instant).
    ex.kmh = (ex.sd != null && ex.vSd != null) ? Math.round(ex.vSd * 3600000)
      : (nv.spd != null && nv.spd !== '' ? Math.round(Number(nv.spd)) : null);
    ex.moving = ex.kmh != null ? ex.kmh >= 3 : null;

    // --- reconciliation ---------------------------------------------------
    // ROUTED vehicles (ex.sd != null) render PURELY on the polyline: chainage
    // easing (stepMotion, forward-only) owns smooth catch-up and a legitimate
    // discontinuity warps instantly onto the new on-rail point (set above) — so a
    // vehicle is NEVER offset off its line and never slides a chord through
    // buildings. Only genuine point-mode (no chainage in the feed — rare) uses the
    // lat/lon corrective slide. gapM/smoothed are still computed for telemetry.
    ex.eT0 = null;                          // clear so curState reads the clean target
    const tgt = curState(ex, now);
    const gapM = distMeters(st.lon, st.lat, tgt.lon, tgt.lat);
    const smoothed = gapM <= SNAP_HARD_M;
    if (ex.sd == null && smoothed && gapM > 0) {
      ex.eLon = st.lon - tgt.lon;           // point-mode only: slide from where the dot WAS...
      ex.eLat = st.lat - tgt.lat;
      ex.eT0 = now;
      ex.eDur = slideDur(gapM);             // ...over a gap-scaled, capped duration
    } else {
      ex.eLon = ex.eLat = 0;
    }

    if (dbgEnabled()) dbgTagSnapshot(ex, {
      branch: dbgBranch, smoothed, gapM,
      // signed predicted speed (m/s): vSd is clamped ≥0 so a 'glide' never reads
      // backward (backwardGlides MUST stay 0). Framerate-independent.
      glideMps: ex.vSd != null ? ex.vSd * 1e6 : 0,
      slideMps: smoothed ? (gapM * 1000 / ex.eDur) : 0, // corrective-slide speed (≤CATCHUP_MPS)
      fwdKm: dbgFwdKm, impliedKmh: dbgImpliedKmh,
    });
  }
  for (const id of fleet.keys()) if (!seen.has(id)) fleet.delete(id);

  tryBindPendingSel();                             // item E: bind a URL-hydrated sel once it appears
  fetchMissingShapes(shapeIds);
  if (routesDirty) { rebuildRoutes(); routesDirty = false; }

  statsSlice.patch({ count: snap.n ?? fleet.size, src: snap.src || 'waiting', ageMs: 0 });
  if (ui.selectedId != null && seen.has(ui.selectedId)) pushSelected(); // keep the Inspector live (speed/delay/stop)
}

// Forward-prediction integrator — run ONCE per frame BEFORE any position read.
// For each shaped vehicle, advance the rendered chainage v.sd toward a
// dead-reckoned, latency-compensated, lead-capped, dwell-gated target, FORWARD
// ONLY (never reverse). This is what keeps vehicles MOVING smoothly between the
// sparse (~40 s) fixes instead of freezing — while the forward-only rule means a
// late/behind fix can never yank them backward (the old teleport).
// Project a stop's lon/lat onto a vehicle's route shape → cumulative chainage (km).
// Planar (equirectangular) nearest-point over the polyline; cheap + cached per
// (shape, stop). Powers the hybrid-motion ETA anchor.
function projectChainage(shape, lon, lat) {
  const pts = shape.pts, cum = shape.cum;
  if (!pts || pts.length < 2 || !cum) return null;
  const cosLat = Math.cos(lat * Math.PI / 180);
  let best = Infinity, bestSd = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], ay = pts[i][1];
    const dx = (pts[i + 1][0] - ax) * cosLat, dy = pts[i + 1][1] - ay;
    const px = (lon - ax) * cosLat, py = lat - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let t = (px * dx + py * dy) / len2; if (t < 0) t = 0; else if (t > 1) t = 1;
    const ex = px - t * dx, ey = py - t * dy;
    const d2 = ex * ex + ey * ey;
    if (d2 < best) { best = d2; bestSd = cum[i] + (cum[i + 1] - cum[i]) * t; }
  }
  return bestSd;
}
function nextStopChainage(v) {
  const ns = v.props && v.props.ns;
  if (!ns || !ns.name || !v.shp) return null;
  const shape = shapes.get(v.shp);
  if (!shape || shape === 'pending' || !shape.hasDist) return null; // retry once the shape loads (don't cache null)
  // Prefer the PRECISE next-stop platform position (the worker emits ns.lon/ns.lat
  // from next_stop.id — accurate to a few metres). Fall back to the station
  // centroid (collapsed by name) when the precise position isn't in the feed yet.
  const precise = (typeof ns.lon === 'number' && typeof ns.lat === 'number') ? [ns.lon, ns.lat] : null;
  const key = v.shp + '|' + (precise ? ns.lon + ',' + ns.lat : ns.name);
  if (nsSdCache.has(key)) return nsSdCache.get(key);
  const pos = precise || stopPos.get(ns.name);
  const out = pos ? projectChainage(shape, pos[0], pos[1]) : null;
  nsSdCache.set(key, out);
  return out;
}

function stepMotion(ts) {
  const nowWall = Date.now();
  for (const v of fleet.values()) {
    if (v.sd == null || v.sdTarget == null) continue;   // point-mode vehicles don't predict
    let dt = v.motT != null ? ts - v.motT : DRAW_INTERVAL;
    v.motT = ts;
    if (dt < 0) dt = 0; else if (dt > 1000) dt = 1000;  // clamp tab-inactive / first-frame gaps
    const shape = v.shp ? shapes.get(v.shp) : null;
    const total = (shape && shape !== 'pending' && shape.hasDist) ? shape.total : null;

    // STOP-AWARE bound — the fix for "glides through / parks past the stop". The
    // next stop's chainage (next_stop.id projected onto the shape) is RELIABLE,
    // unlike Golemio's schedule clock (minute-rounded and, for late vehicles,
    // already in the past) and unlike the over-reported at_stop flag (~70% of
    // trams at any instant). We never dead-reckon PAST the next stop: the vehicle
    // eases up to it and HOLDS until the next fix releases it — so it visibly
    // stops AT the stop instead of sailing through to the lead cap mid-block.
    const ns = v.props && v.props.ns;
    const nsSd = (ns && ns.name) ? nextStopChainage(v) : null;
    const stopAhead = nsSd != null && nsSd > v.sdTarget + SD_MOVE_KM && nsSd < v.sdTarget + 3; // ahead, <3 km

    // Speed estimate (km/ms). When a stop bounds the prediction we IGNORE the
    // noisy at_stop dwell flag and let the EMA — which decays to ~0 on its own
    // while a vehicle genuinely dwells — drive the glide; the cap holds it at the
    // stop. Only WITHOUT a stop anchor do we keep the dwell freeze, as a fallback
    // against an open-loop run-through. Age uses the real fix timestamp, so feed
    // latency is compensated and v.sd tracks the actual current position.
    const vEff = (v.dwell && !stopAhead) ? 0 : Math.max(0, v.vSd || 0);
    const lead = leadMs(v.props && v.props.mode);            // per-mode lead ≈ this mode's fix interval
    const ageMs = Math.min(lead, Math.max(0, nowWall - (v.fixTs || nowWall)));
    let sdReal = v.sdTarget + vEff * ageMs;                  // dead-reckoned target (extrapolated to now)
    let cap = v.sdTarget + Math.min(MAX_LEAD_KM, vEff * lead); // stale-feed lead guard

    if (stopAhead) {
      cap = Math.min(cap, nsSd);                            // never overshoot the next stop
      // If the schedule arrival is genuinely still in the future, ALSO pace toward
      // the stop by the timetable (a smooth decel into it); otherwise the EMA glide
      // plus the cap carry it there. Guarded so a stale (past) clock never applies.
      if (ns.at && v.fixTs && ns.at > nowWall && ns.at > v.fixTs) {
        const frac = Math.max(0, Math.min(1, (nowWall - v.fixTs) / (ns.at - v.fixTs)));
        sdReal = Math.max(sdReal, v.sdTarget + (nsSd - v.sdTarget) * frac);
      }
    }
    if (sdReal > cap) sdReal = cap;
    if (total != null && sdReal > total) sdReal = total;

    // One-shot RESNAP — returning from a backgrounded/locked tab. Jump straight to the
    // dead-reckoned truth (already lead- and stop-capped above) instead of animating
    // through the backlog missed while hidden. warp=true so renderPos jumps on-rail.
    if (v.resnap) { v.sd = sdReal; v.vRender = vEff; v.warp = true; v.resnap = false; continue; }

    // BOUNDED VELOCITY CORRECTION. err = how far the dead-reckoned truth is from the
    // rendered chainage. It enters ONLY as a velocity term — there is NO err-derived
    // position move anywhere — so the per-frame spatial step is bounded by the clamped
    // vRender regardless of how large err is. Darting is mathematically impossible.
    const err = sdReal - v.sd;
    const vmax = vmaxKmMs(v.props && v.props.mode);
    const tau = convTau(v.props && v.props.mode);
    // Cruise the corrector relaxes toward (a floor lets a just-departed/cold vehicle pull away):
    const vCruise = (err > 0) ? Math.max(vEff, vmax * CRUISE_FLOOR) : vEff;
    // The correction is a VELOCITY (km/ms), bled in over ~one convergence interval for this mode:
    let vCmd = vCruise + err / tau;
    // HARD anti-dart clamp BEFORE integration: ≤ SPEED_CAP_MULT×cruise forward (a believable mode
    // speed), and only a small negative settle backward (never a fast reverse / backward teleport):
    const capUp = SPEED_CAP_MULT * Math.max(vCruise, vmax * MIN_CAP_FRAC);
    if (vCmd > capUp) vCmd = capUp;
    if (vCmd < -vmax * BACK_MULT) vCmd = -vmax * BACK_MULT;
    // Smooth the velocity onset so a fix never step-changes the rendered speed:
    const aF = 1 - Math.exp(-dt / ACCEL_TAU_MS);
    v.vRender = (v.vRender == null) ? vCmd : v.vRender + (vCmd - v.vRender) * aF;
    // Decelerate INTO the NEXT STOP only (the tram-26 approach-decel). Gated to a real stop —
    // NOT the always-present stale-feed lead cap, which would freeze-lurch the sparse-fix trams.
    if (stopAhead && v.vRender > 0) {
      const toStop = nsSd - v.sd;
      if (toStop > 0 && toStop < APPROACH_KM) {
        const frac = toStop / APPROACH_KM;
        // A DWELLING vehicle (at_stop), or one in the final metres, decays to ZERO so it
        // PARKS at the platform instead of creeping onto it. A still-moving approach keeps
        // the 0.18 floor so it doesn't look frozen 50 m out before it's actually there.
        const park = v.dwell || toStop < SD_PARK_KM;
        v.vRender *= park ? frac : Math.max(0.18, frac);
      }
    }
    // Integrate. Forward-biased; a behind-landing fix never reverses the render.
    v.sd += v.vRender * dt;
    // Never overrun truth (forward OR during a backward settle); never exceed the bounds.
    if (err >= 0 && v.sd > sdReal) v.sd = sdReal;
    else if (err < 0 && v.sd < sdReal) v.sd = sdReal;
    if (v.sd > cap) v.sd = cap;
    if (total != null && v.sd > total) v.sd = total;
    if (v.sd < 0) v.sd = 0;
    // Silent-lag instrument (Phase 0): signed chainage gap render↔target, per mode.
    // Post-clamp so it reflects what's actually drawn vs the capped dead-reckoned truth.
    if (dbgEnabled()) dbgLag(v.props && v.props.mode, v.sd, sdReal);
  }
}

// Per-frame heading easing (item B). Advance each vehicle's eased heading v.hdgE
// toward the raw tangent at its current chainage via a SHORTEST-ARC angular lerp,
// with a frame-rate-independent factor 1 - exp(-dt/TAU). Runs ONCE per frame
// (before any sampler reads a heading) so the factor isn't compounded by the
// several sampler calls/vehicle/frame. Initialises v.hdgE on first sight.
function easeHeadings(ts) {
  for (const v of fleet.values()) {
    const raw = rawHeading(v);
    if (v.hdgE == null) { v.hdgE = raw; v.hdgET = ts; continue; }
    const dt = v.hdgET != null ? Math.max(0, ts - v.hdgET) : DRAW_INTERVAL;
    v.hdgET = ts;
    const f = 1 - Math.exp(-dt / HDG_EASE_TAU_MS);     // ~0.15 at a 33ms frame
    v.hdgE = (v.hdgE + angDiff(v.hdgE, raw) * f + 360) % 360;
  }
}

// Smooth the point→rail switch. Measured as the DOMINANT teleport source: when a
// vehicle's route shape finishes loading, its drawn position jumps from the
// straight-line GPS lerp to the on-rail chainage point (60–150 m). On that
// false→true edge we capture the gap ONCE as a corrective offset, so curState
// slides it away at the constant catch-up speed instead of teleporting. ~free
// otherwise (a flag compare per vehicle).
function reconcileRail(ts) {
  for (const v of fleet.values()) {
    const onRail = shapeReady(v);
    if (onRail && v.railed === false) {
      const pt = pointPos(v, ts);            // where the dot was drawn (straight line)
      const rl = railPos(v);                 // where it now snaps (on the rail)
      if (rl && pt) {
        const gap = distMeters(pt.lon, pt.lat, rl.lon, rl.lat);
        if (gap > SD_DEAD_KM * 1000 && gap <= SNAP_HARD_M) {
          v.eLon = pt.lon - rl.lon;
          v.eLat = pt.lat - rl.lat;
          v.eT0 = ts;
          v.eDur = slideDur(gap);
        }
      }
    }
    v.railed = onRail;
  }
}

let lastDraw = 0;
function animate(ts) {
  requestAnimationFrame(animate);
  if (!mapReady || ts - lastDraw < DRAW_INTERVAL) return;
  lastDraw = ts;
  if (replayActive) return;       // Time Machine owns the view; the live layer is muted
  if (routesDirty) { rebuildRoutes(); routesDirty = false; }

  // Advance the forward-prediction integrator FIRST (samplers read v.sd, and
  // easeHeadings → rawHeading also reads v.sd), then ease headings.
  stepMotion(ts);

  // Advance eased headings ONCE/frame BEFORE any position read (samplers now
  // return v.hdgE and the track offset is keyed off it).
  easeHeadings(ts);

  // Convert the point→rail shape-load jump into a smooth slide (must run BEFORE
  // anything reads positions this frame, incl. the debug tap below).
  reconcileRail(ts);

  // DEBUG (only with ?debug=motion): measure real frame-to-frame teleports over
  // the WHOLE fleet (independent of 2D/3D), attributed to cause. Adds one extra
  // curState eval/vehicle/frame — debug-only, off in normal use.
  if (dbgEnabled()) dbgFrame(fleet, ts, (v) => renderPos(v, ts), shapeReady);

  // Selection ring + follow-camera (independent of 2D/3D).
  updateSelectionAndFollow(ts);

  // Drivable car: advance physics, place the mesh (read by veh3d.syncFrame below),
  // and chase it with the camera. Runs before syncFrame so the pose is current.
  if (car && car.active) {
    const cdt = lastCarTs ? (ts - lastCarTs) / 1000 : 0;
    lastCarTs = ts;
    const st = car.step(cdt);
    if (st) {
      veh3d.setCar({ lon: st.lon, lat: st.lat, hdg: st.hdg });
      if (chaseCam) chaseCam.chase({ lon: st.lon, lat: st.lat, hdg: st.hdg });
    }
  } else {
    lastCarTs = 0;
  }

  const zoom = map.getZoom();

  // 3D mode at usable zoom: drive the InstancedMeshes from the SAME single
  // curState eval (inside syncFrame) and SKIP the GeoJSON dot rebuild — only
  // one representation pays per frame. The 3D layer's render() draws the meshes.
  if (render3D && veh3d && veh3d.supported && zoom >= MESH_MINZOOM) {
    setDots(false); // meshes are the active representation; hide the 2D dots
    veh3d.syncFrame(fleet, ts, sampleAlong, { filter: passesFilter, selectedId: ui.selectedId, selectHex: SELECT_HEX });
    updatePins(ts, zoom); // floating line pins over the meshes
    return;
  }

  // 3D selected but zoomed out below MESH_MINZOOM: meshes are sub-pixel, so we
  // hide them (zero every instance count) and reveal the cheap 2D dots instead.
  if (render3D && veh3d && veh3d.supported) { veh3d.hideMeshes(); setDots(true); }
  if (pins) pins.clear(); // 2D dots carry their own labels — no floating pins

  // 2D path (also the 3D-but-zoomed-out fallback): filtered vehicles only.
  // PERF: rebuilding + uploading a ~2000-feature GeoJSON every rAF frame is the
  // dominant 2D cost. The dots advance by dead-reckoning, so a ~30 Hz refresh is
  // visually identical (MapLibre re-projects the existing dots at 60 Hz on any
  // pan/zoom itself); only the imperceptible position-advance is coarser.
  if (ts - lastDots2D < DOTS_2D_MS) return;
  lastDots2D = ts;
  const features = [];
  for (const v of fleet.values()) {
    if (!passesFilter(v)) continue;
    const s = renderPos(v, ts);
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: v.props });
  }
  const src = map.getSource('vehicles');
  if (src) src.setData({ type: 'FeatureCollection', features });
}

const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// Track the selected vehicle: update its highlight ring, drop the selection if it
// left the fleet, hide the ring (but keep the selection) if a filter hides it, and
// recenter the camera on it while Follow is on.
let chaseActive = false; // true while the chase-cam is driving (so reset() fires once on stop)
// Stop the chase-cam if it's running. Called when follow turns off, the selection
// is cleared/gone, or a user gesture cancels follow. Idempotent.
function stopChase() {
  if (chaseActive && chaseCam) chaseCam.reset();
  chaseActive = false;
}
function updateSelectionAndFollow(ts) {
  const src = map.getSource('sel');
  if (ui.selectedId == null) { if (src) src.setData(EMPTY_FC); stopChase(); return; }
  const sel = fleet.get(ui.selectedId);
  if (!sel) { clearSelection(); return; }                 // vehicle gone from the feed (clearSelection→stopChase)
  if (!passesFilter(sel)) { if (src) src.setData(EMPTY_FC); stopChase(); return; } // hidden by filter
  const s = renderPos(sel, ts);
  if (ui.follow) {
    // The yellow ring is the FOLLOW indicator (camera locked on this vehicle).
    // Plain selection is already shown by the highlighted pin/mesh + the anchored
    // card, so the ring is drawn ONLY while following — and clears the instant you
    // stop, instead of lingering on the map.
    if (src) src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: {} }] });
    // Drive the chase camera (item F). s.hdg is the eased compass heading.
    if (chaseCam) { chaseCam.chase({ lon: s.lon, lat: s.lat, hdg: s.hdg }); chaseActive = true; }
    else map.jumpTo({ center: [s.lon, s.lat] }); // fallback if chase-cam unavailable
  } else {
    if (src) src.setData(EMPTY_FC);   // not following → drop the ring (pin/mesh highlight + card still mark the selection)
    stopChase();
  }
}

// Floating line pins (3D only, zoom ≥ PIN_MINZOOM): filtered + viewport-culled +
// capped, projected to screen by pins.js.
function updatePins(ts, zoom) {
  if (!pins) return;
  if (!ui.pins || zoom < PIN_MINZOOM) { pins.clear(); return; }
  const b = map.getBounds();
  const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
  const list = [];
  for (const v of fleet.values()) {
    if (!passesFilter(v)) continue;
    const st = renderPos(v, ts);
    if (st.lon < w || st.lon > e || st.lat < s || st.lat > n) continue;
    list.push({ id: v.props.id, lon: st.lon, lat: st.lat, line: v.props.line, color: v.props.color, dl: v.props.dl, selected: v.props.id === ui.selectedId });
    if (list.length >= PIN_CAP) break;
  }
  pins.update(list);
}

// --- 2D <-> 3D representation control ---------------------------------------
// Flips the proven 2D circle/label layers (low-zoom/fallback/perf) against the
// 3D meshes (high zoom + pitch). The motion model is identical in both; only
// WHICH layer reads the per-frame curState values changes.
//
// All three GeoJSON-backed layers (veh-halo/veh-dot/veh-label) are governed
// TOGETHER because they share one 'vehicles' source: when meshes are active we
// SKIP that source's per-frame setData (the perf win), which would otherwise
// leave labels stale — so the labels are hidden alongside the dots. Toggling
// only happens on a state change, so the per-frame setDots() calls are free.
function setDots(show) {
  if (show === dotsShown) return;
  dotsShown = show;
  const v = show ? 'visible' : 'none';
  for (const id of ['veh-halo', 'veh-dot', 'veh-label']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v);
  }
  applyVehGlow();
}

// Night vehicle glow shows only when the basemap is dark AND the 2D dots are the
// active representation (zoomed out / 3D off). In 3D mesh zoom the per-mesh head/
// tail lights carry the "lit" read, so the flat glow would just double up — hide it.
function applyVehGlow() {
  if (!map.getLayer('veh-glow')) return;
  map.setLayoutProperty('veh-glow', 'visibility', (nightGlow && dotsShown) ? 'visible' : 'none');
}

function applyRenderMode(initial) {
  const on = render3D && veh3d && veh3d.supported;
  if (on) {
    // In 3D the per-frame zoom logic in animate() owns dot visibility (dots show
    // only below MESH_MINZOOM). Above it, the meshes carry the position read.
    veh3d.setVisible(true);
    if (initial) {
      // Boot into a view where the 3D models are actually visible: tilt + a zoom at
      // or above MESH_MINZOOM. Below it you'd only see flat 2D dots. (Respects a
      // deep-link that's already tilted / zoomed in past these.)
      if (map.getPitch() < 1) map.setPitch(50);
      if (map.getZoom() < MESH_MINZOOM) map.setZoom(15.5);
    } else {
      map.easeTo({ pitch: 50, duration: motionMs(600) });
    }
    setDots(map.getZoom() < MESH_MINZOOM);
  } else {
    if (veh3d) veh3d.setVisible(false);
    setDots(true); // 2D dots are the permanent representation
    if (!initial) map.easeTo({ pitch: 0, duration: motionMs(600) });
  }
  // The popup click handler stays bound to 'veh-dot' (a 2D-dot concern); 3D mesh
  // picking is deferred and explicitly not blocked. Popups thus work in 2D and in
  // the zoomed-out 3D fallback where dots are shown.
  localStorage.setItem('pid3d', on ? '1' : '0');
  // Reflect the active 2D/3D mode into the React bridge (drives the TopBar toggle).
  viewSlice.patch({ render3D: on });
  applyVehGlow(); // re-resolve night glow against the (possibly changed) dot visibility
}

// --- shareable URL state (item E) -------------------------------------------
// App state lives in the QUERY string (location.search); MapLibre owns the hash
// (#z/lat/lng camera) and we never touch it. We write view/modes/line/sel/follow
// via a DEBOUNCED history.replaceState (no new history entries, no thrash). On
// load we hydrate from the query if present, else fall back to localStorage
// (pid3d) as the personal default.
const ALL_MODE_KEYS = FILTER_MODES.map((m) => m[0]);
let pendingFollow = false;     // a hydrated sel should also auto-follow once it appears
let pendingSelId = null;       // sel id from the URL we still need to bind to a live vehicle

function buildSearch() {
  const q = new URLSearchParams();
  q.set('view', render3D ? '3d' : '2d');
  const on = ALL_MODE_KEYS.filter((k) => ui.modes.has(k));
  if (on.length !== ALL_MODE_KEYS.length) q.set('modes', on.join(',')); // omit when all enabled
  if (ui.lines.length) q.set('line', ui.lines.join(','));
  if (ui.selectedId != null) q.set('sel', String(ui.selectedId));
  if (ui.selectedId != null && ui.follow) q.set('follow', '1');         // only meaningful with a sel
  const s = q.toString();
  return s ? `?${s}` : '';
}

let urlTimer = 0;
function scheduleUrlSync() {
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    try {
      const url = location.pathname + buildSearch() + location.hash; // keep MapLibre's hash intact
      history.replaceState(history.state, '', url);
    } catch {}
  }, 400);
}

function hydrateFromUrl() {
  let q;
  try { q = new URLSearchParams(location.search); } catch { q = new URLSearchParams(); }
  const hasQuery = [...q.keys()].length > 0;

  // view: query wins; else the existing pid3d localStorage default (already read
  // into render3D at module load and applied by applyRenderMode(true) above). Only
  // flip when the query asks for a DIFFERENT, supported mode.
  const view = q.get('view');
  if ((view === '2d' || view === '3d') && veh3d && veh3d.supported) {
    const want3d = view === '3d';
    if (want3d !== render3D) { render3D = want3d; applyRenderMode(true); }
  }

  // modes: comma list of enabled groups; absent ⇒ leave default (all on).
  if (q.has('modes')) {
    const want = new Set(q.get('modes').split(',').map((s) => s.trim()).filter(Boolean).filter((k) => ALL_MODE_KEYS.includes(k)));
    ui.modes.clear();
    for (const k of want) ui.modes.add(k);
    syncFiltersSlice();
  }

  // line filter (comma-separated set).
  if (q.has('line')) {
    ui.lines = [...new Set(q.get('line').split(',').map(lineKey).filter(Boolean))];
    syncFiltersSlice();
  }

  // sel + follow: bind once the vehicle actually appears in the fleet (it may not
  // be loaded yet on first paint). applySnapshot calls tryBindPendingSel().
  if (q.has('sel')) {
    pendingSelId = q.get('sel');
    pendingFollow = q.get('follow') === '1';
    tryBindPendingSel();
  }

  // No query at all → localStorage is the personal default. render3D already holds
  // the pid3d value; nothing more to do (applyRenderMode(true) ran at map load).
  if (!hasQuery) { /* localStorage default already applied */ }
}

// Bind a URL-hydrated selection to a live vehicle as soon as it exists; set follow
// if the URL asked for it. Cleared once bound. Called on load and after each snapshot.
function tryBindPendingSel() {
  if (pendingSelId == null) return;
  if (!fleet.has(pendingSelId)) return;            // not in the feed yet — try again next snapshot
  selectVehicle(pendingSelId);
  if (pendingFollow) {
    ui.follow = true;
    pushSelected();
    scheduleUrlSync();                             // reflect follow=1 (selectVehicle synced before this)
  }
  pendingSelId = null;
  pendingFollow = false;
}

// "Share view" button handler (wired into the control panel via initControls).
// Copies the full current URL (query app-state + MapLibre hash camera) and asks
// the panel to flash a brief confirmation.
function shareView(confirmCb) {
  // Flush any pending debounced write so the copied URL is fully current.
  clearTimeout(urlTimer);
  try { history.replaceState(history.state, '', location.pathname + buildSearch() + location.hash); } catch {}
  const href = location.href;
  const done = (ok) => { if (typeof confirmCb === 'function') confirmCb(ok); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(href).then(() => done(true)).catch(() => done(false));
  } else {
    done(false);
  }
}

setInterval(() => {
  statsSlice.patch({ ageMs: lastSnapshotT ? Date.now() - lastSnapshotT : null });
}, 1000);

function setConn(ok) { statsSlice.patch({ conn: !!ok }); }

async function start() {
  if (!API_BASE) { statsSlice.patch({ src: 'noapi', conn: false }); return; }
  await initShapeCache();   // hydrate cached geometry first → routed vehicles move at once
  try { const r = await fetch(`${API_BASE}/api/vehicles`); if (r.ok) applySnapshot(await r.json()); } catch {}
  connectSSE();
}
// SSE with DELTA streaming (Phase 3 bandwidth win: ~150 KB → ~5-10 KB/tick). The
// server sends one full `snapshot` event on connect, then only `delta` events
// (changed + removed vehicle ids) each tick. We keep a reconstructed base map and
// feed applySnapshot the full vehicle list so its diff/motion logic is unchanged.
function connectSSE() {
  const es = new EventSource(`${API_BASE}/api/stream?delta=1`);
  const base = new Map();                  // id -> latest vehicle object (delta-reconstructed)
  let haveBase = false;
  es.addEventListener('snapshot', (ev) => {
    setConn(true);
    try {
      const snap = JSON.parse(ev.data);
      base.clear();
      for (const v of snap.v || []) base.set(v.id, v);
      haveBase = true;
      applySnapshot(snap);
    } catch {}
  });
  es.addEventListener('delta', (ev) => {
    if (!haveBase) return;                  // ignore deltas until the full base lands
    setConn(true);
    try {
      const d = JSON.parse(ev.data);
      for (const v of d.changed || []) base.set(v.id, v);
      for (const id of d.removed || []) base.delete(id);
      applySnapshot({ t: d.t, src: d.src, n: d.n != null ? d.n : base.size, v: [...base.values()] });
    } catch {}
  });
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
}

// Re-sync to LIVE. Fetch the freshest full snapshot, then flag every vehicle to
// RESNAP (stepMotion jumps it to its dead-reckoned truth this frame, no catch-up).
// Used by the visibility handler (return from a backgrounded/locked tab) and the
// "Live" pill. Idempotent + cheap.
async function resyncLive() {
  for (const v of fleet.values()) { v.resnap = true; v.motT = null; }   // snap immediately to current estimate
  try {
    const r = await fetch(`${API_BASE}/api/vehicles`, { cache: 'no-store' });
    if (r.ok) { applySnapshot(await r.json()); for (const v of fleet.values()) v.resnap = true; }  // re-snap to the newest fixes
  } catch { /* keep the immediate resnap */ }
  statsSlice.patch({ stale: false });
}

// Backgrounded tabs (phone lock, app switch) freeze requestAnimationFrame; on return
// the loop would otherwise dead-reckon forward from the STALE state — the "it kept
// playing from where I minimized" report. On regaining visibility after a real
// absence, snap back to live instead. A brief blur (<3s) needs nothing.
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { hiddenAt = Date.now(); statsSlice.patch({ stale: true }); return; }
    const away = Date.now() - (hiddenAt || Date.now());
    if (away > 3000) resyncLive();
    else statsSlice.patch({ stale: false });
  });
}

// PWA install + offline app-shell (guarded; only registers in production over https).
try { registerPWA(); } catch (err) { console.warn('[pwa] register failed:', err && err.message); }
