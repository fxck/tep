// motionDebug.js — TEMPORARY teleport diagnostics (safe to delete later).
//
// Activated ONLY when the URL has ?debug=motion (or localStorage.pidDebug='1').
// Zero cost otherwise: every export early-returns when disabled, and main.js
// guards its tap calls on dbgEnabled().
//
// WHAT IT MEASURES: the real, frame-to-frame DISPLAYED position of every
// vehicle (the same curState main.js draws), flags any frame where a vehicle
// moves more than TELEPORT_M in one ~33 ms frame (≥ ~50× the 120 km/h ceiling —
// physically impossible, i.e. a visual teleport), and ATTRIBUTES each teleport
// to its cause:
//   - snap:<branch>[+frozen]:instant   → applySnapshot chose a hard snap (gap>cap)
//   - snap:<branch>[+frozen]:smoothramp → a "smoothed" correction whose ease-out
//                                         ramp still jumped >TELEPORT_M in 1 frame
//   - shape-loaded                      → route geometry finished loading mid-flight
//                                         (point-mode → on-rail switch, un-smoothed)
//   - math/other                        → discontinuity with no snapshot/shape cause
//                                         (would indicate a real interpolation bug)
// It also tallies how often EACH snapshot branch fires (base rates), so a cause
// can be read against its frequency.
//
// OUTPUT: a rolling summary every SUMMARY_MS to console AND mirrored into a
// <pre id="__mdbg"> DOM node (so a headless browser can read structured JSON via
// get-text without eval). window.__mdbg also holds the live object.

const ENABLED = (() => {
  try {
    if (typeof location !== 'undefined' && /[?&]debug=motion\b/.test(location.search)) return true;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('pidDebug') === '1') return true;
  } catch {}
  return false;
})();

export function dbgEnabled() { return ENABLED; }

const TELEPORT_M = 60;        // >60 m in one frame = teleport (120 km/h ≈ 1.1 m/frame)
const SUMMARY_MS = 3000;      // emit a rolling summary this often
const MAX_EXAMPLES = 8;

function distM(lo1, la1, lo2, la2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (la2 - la1) * rad, dLon = (lo2 - lo1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---- state (module-local; only touched when ENABLED) -----------------------
const last = new Map();          // id -> {lon, lat}
const shapeWasReady = new Map();  // id -> bool (to detect point->rail switch)
const reasons = new Map();       // reason -> count (this window)
const branchTotals = new Map();  // snapshot branch -> count (this window)
let dists = [];                  // teleport distances this window
let examples = [];
let teleports = 0, frames = 0, retargets = 0, fleetSize = 0;
let windowStart = null;
let node = null;

// --- EVENT-based metrics (framerate-INDEPENDENT — valid despite headless rAF
// throttling, because they're computed from motion params at each retarget, not
// sampled from rendered pixels). This is the real teleport instrument now. ------
let backwardGlides = 0;  // glide branch with a NEGATIVE displayed speed (tram rendered reversing) — must be 0
let fastGlides = 0;      // glide branch displayed >50 m/s (>180 km/h) — would read as a forward streak
let instantSnaps = 0;    // gap > SNAP_HARD → instant jump (the only true teleport left; should be ~0)
let backwardHeld = 0;    // backward GPS reading correctly HELD (not rendered as reverse) — good
let snapBacks = 0;       // real reversals/trip turnarounds eased back
let maxGlideMps = 0, maxSlideMps = 0;
let glideSpeeds = [];
// RENDERED ground speed (m/s) — the actual on-screen speed of each dot, sampled as
// frame-to-frame distance / frame dt. THIS is the "is it moving stupidly fast?"
// metric: it captures EVERYTHING the eye sees (prediction, catch-up slide, error
// offset), and dividing by dt makes it frame-rate independent (so it's valid
// despite headless rAF throttling). renderMax should sit near the fastest mode's
// realistic top speed; a flood of `overspeed` (>108 km/h) means a catch-up dash.
let renderSpeeds = [], maxRenderMps = 0, overspeed = 0, lastFrameTs = null;

// --- ON-RAIL INVARIANT metrics (chainage-space — the gate the spatial/predicted
// counters above are STRUCTURALLY BLIND to). backwardGlides reads ex.vSd which is
// clamped ≥0, so it can NEVER fire; the real reverse happens in stepMotion when v.sd
// DECREASES frame-to-frame. And overtaking is invisible to any per-vehicle metric.
//   • backwardRender = frames where a routed vehicle's chainage stepped BACKWARD
//     (excluding intended warps: new trip / shape change / >SD_BACK reversal). MUST be 0.
//   • overtakes = per-frame chainage-ORDER inversions between two rail vehicles sharing
//     one shape (= one physical track) — a visible same-track pass. MUST be 0.
let backwardRender = 0, maxBackM = 0, overtakes = 0;
const lastSdById = new Map();    // id -> last-frame chainage (km), for the backward-render test
const ovPrevSd = new Map();      // id -> last-frame chainage (km), for the order-inversion test

// --- TRACKING-ERROR / SILENT-LAG metric (Phase 0 of the prediction roadmap) ----
// The teleport/backward/fast counters above are BLIND to a smoothly-lagging
// estimator: a corrector whose convergence is too slow (or a Kalman with too-low
// Q) renders persistently BEHIND its own dead-reckoned target without ever
// teleporting or reversing — invisible to every metric here. This is the gate
// metric the roadmap requires before/under each estimator phase: it samples, per
// frame per vehicle, the signed chainage gap (sdReal − sdRender) in METRES.
//   • |lag| quantiles  → how far the render trails the target (the silent lag).
//   • signed mean (bias) → which way it trails (≈0 is healthy; persistently
//     positive = render chronically behind truth; negative = overrunning).
// Bucketed per mode because cadence (and therefore expected lag) differs sharply
// (tram p50 ~50 s fix gap vs metro ~5 s). A phase that REGRESSES lag for any mode
// fails the acceptance bar even if backwardGlides stays 0.
const lagByMode = new Map();      // mode -> array of signed lag (m) this window

export function dbgLag(mode, sdRenderKm, sdRealKm) {
  if (!ENABLED) return;
  if (sdRenderKm == null || sdRealKm == null || !isFinite(sdRenderKm) || !isFinite(sdRealKm)) return;
  const m = mode || 'other';
  let arr = lagByMode.get(m);
  if (!arr) { arr = []; lagByMode.set(m, arr); }
  arr.push((sdRealKm - sdRenderKm) * 1000);   // km → m, signed (target − render)
}

function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }

// Tag a vehicle the instant applySnapshot retargets it, so the NEXT frame can
// attribute any jump it sees to this exact branch/decision. `info` carries:
//   { branch, smoothed, gapM, glideMps, slideMps, fwdKm, impliedKmh }
export function dbgTagSnapshot(v, info) {
  if (!ENABLED) return;
  v._dbg = info;
  v._dbgPending = true;          // consumed by the next dbgFrame for this vehicle
  retargets++;
  bump(branchTotals, info.branch);

  const g = info.glideMps || 0;
  if (info.branch === 'glide') {
    glideSpeeds.push(Math.abs(g));
    if (g < -0.5) backwardGlides++;          // rendered moving BACKWARD — the bug
    if (Math.abs(g) > 50) fastGlides++;      // >180 km/h displayed glide
  }
  if (info.branch === 'hold-back') backwardHeld++;
  if (info.branch === 'snap-back') snapBacks++;
  if (Math.abs(g) > maxGlideMps) maxGlideMps = Math.abs(g);
  if ((info.slideMps || 0) > maxSlideMps) maxSlideMps = info.slideMps;
  if (!info.smoothed) instantSnaps++;        // gap > SNAP_HARD → instant jump
}

// Called once per frame from animate(). refOf(v) -> {lon,lat,hdg} = the SAME
// position main.js draws this frame. shapeReadyOf(v) -> bool.
export function dbgFrame(fleet, ts, refOf, shapeReadyOf) {
  if (!ENABLED) return;
  if (windowStart == null) windowStart = ts;
  frames++;
  fleetSize = fleet.size;
  const fdt = lastFrameTs != null ? (ts - lastFrameTs) : 0; // real frame dt (ms) for the rate metric
  lastFrameTs = ts;

  for (const v of fleet.values()) {
    const id = (v.props && v.props.id) != null ? v.props.id : v;
    const warped = !!v.warp;          // read BEFORE refOf — renderPos consumes the warp flag
    const s = refOf(v);
    if (!s || !isFinite(s.lon) || !isFinite(s.lat)) { v._dbgPending = false; continue; }

    // BACKWARD-RENDER (the real reverse test): a routed vehicle whose rendered
    // chainage stepped backward this frame, excluding intended warps (new trip /
    // shape change / >SD_BACK reversal, all of which set v.warp). > 0.5 m guards float noise.
    if (v.sd != null) {
      const psd = lastSdById.get(id);
      if (psd != null && !warped) {
        const backM = (psd - v.sd) * 1000;
        if (backM > 0.5) { backwardRender++; if (backM > maxBackM) maxBackM = backM; }
      }
      lastSdById.set(id, v.sd);
    }

    const ready = shapeReadyOf ? !!shapeReadyOf(v) : false;
    const wasReady = shapeWasReady.get(id);
    const shapeJustLoaded = ready && wasReady === false; // false->true this frame

    const prev = last.get(id);
    if (prev) {
      const m = distM(prev.lon, prev.lat, s.lon, s.lat);
      if (fdt > 0) {
        const rate = (m / fdt) * 1000;     // rendered ground speed (m/s), frame-rate independent
        renderSpeeds.push(rate);
        if (rate > maxRenderMps) maxRenderMps = rate;
        if (rate > 30) overspeed++;        // >108 km/h on screen = visibly too fast (a dash)
      }
      if (m > TELEPORT_M) {
        let reason;
        if (v._dbgPending && v._dbg) {
          const d = v._dbg;
          reason = 'snap:' + d.branch + (d.smoothed ? ':smoothramp' : ':instant');
        } else if (shapeJustLoaded) {
          reason = 'shape-loaded';
        } else {
          reason = 'math/other';
        }
        teleports++;
        bump(reasons, reason);
        dists.push(m);
        if (examples.length < MAX_EXAMPLES) {
          examples.push({ id: String(id).slice(0, 18), m: Math.round(m), reason,
            gapM: v._dbg ? Math.round(v._dbg.gapM) : null });
        }
      }
    }
    last.set(id, { lon: s.lon, lat: s.lat });
    shapeWasReady.set(id, ready);
    v._dbgPending = false;        // consume: a snapshot's effect shows within 1 frame
  }

  // OVERTAKE detector: among rail vehicles sharing one shape (= one track), count
  // pairs whose chainage ORDER flipped since last frame (a visible same-track pass).
  // O(group²), debug-only; rail groups are small.
  const ovGroups = new Map();
  for (const v of fleet.values()) {
    if (v.sd == null || !v.shp) continue;
    const mode = v.props && v.props.mode;
    if (mode !== 'tram' && mode !== 'metro' && mode !== 'train') continue;
    let g = ovGroups.get(v.shp);
    if (!g) { g = []; ovGroups.set(v.shp, g); }
    g.push(v);
  }
  for (const g of ovGroups.values()) {
    if (g.length < 2) continue;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i], b = g[j];
        const ia = (a.props && a.props.id) != null ? a.props.id : a;
        const ib = (b.props && b.props.id) != null ? b.props.id : b;
        const pa = ovPrevSd.get(ia), pb = ovPrevSd.get(ib);
        if (pa == null || pb == null) continue;
        // order flipped iff sign(prev a−b) != sign(now a−b); >2 m apart both frames to ignore jitter
        if ((pa - pb) * (a.sd - b.sd) < 0 && Math.abs(pa - pb) > 0.002 && Math.abs(a.sd - b.sd) > 0.002) overtakes++;
      }
    }
  }
  for (const v of fleet.values()) {
    if (v.sd == null) continue;
    const id = (v.props && v.props.id) != null ? v.props.id : v;
    ovPrevSd.set(id, v.sd);
  }

  if (ts - windowStart >= SUMMARY_MS) emit(ts);
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return Math.round(a[Math.min(a.length - 1, Math.floor(p * a.length))]);
}

// Per-mode tracking-error summary (metres): |lag| central tendency/tail + signed
// bias. n = samples (frames×vehicles), so it's also a coverage indicator.
function lagSummary() {
  const out = {};
  for (const [mode, arr] of lagByMode) {
    if (!arr.length) continue;
    const abs = arr.map(Math.abs);
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;          // signed bias
    const absMean = abs.reduce((s, x) => s + x, 0) / abs.length;
    out[mode] = {
      n: arr.length,
      absMean: Math.round(absMean),     // mean |sdReal − sdRender| (m) — the silent-lag magnitude
      absP95: pct(abs, 0.95),           // tail lag (m)
      absMax: Math.round(Math.max(...abs)),
      bias: Math.round(mean),           // signed mean (m): +behind / −overrun, ≈0 healthy
    };
  }
  return out;
}

function emit(ts) {
  const secs = (ts - windowStart) / 1000;
  const reasonObj = Object.fromEntries([...reasons.entries()].sort((a, b) => b[1] - a[1]));
  const branchObj = Object.fromEntries([...branchTotals.entries()].sort((a, b) => b[1] - a[1]));
  const summary = {
    window_s: +secs.toFixed(1),
    fleet: fleetSize,
    frames,
    // EVENT metrics (framerate-independent — the real teleport test):
    ev: {
      retargets,
      backwardRender,             // MUST be 0 — chainage stepped BACKWARD on screen (real reverse, warps excluded)
      maxBackM: Math.round(maxBackM),  // worst single-frame backward step (m)
      overtakes,                  // MUST be 0 — same-track chainage-order inversions (a visible pass)
      backwardGlides,             // (legacy, structurally 0 — kept for continuity)
      fastGlides,                 // glides >180 km/h (forward streak)
      instantSnaps,               // gap>SNAP_HARD instant jumps (true teleports left)
      backwardHeld,               // backward GPS noise correctly held (good, expected >0)
      snapBacks,                  // real reversals/trip turnarounds eased
      maxGlideMps: Math.round(maxGlideMps),
      p95GlideMps: pct(glideSpeeds, 0.95),
      maxSlideMps: Math.round(maxSlideMps),
      // RENDERED on-screen ground speed — the "stupidly fast" test (m/s):
      renderMaxMps: Math.round(maxRenderMps),   // fastest dot this window; ≤ ~1.2×mode vmax expected
      renderP95Mps: pct(renderSpeeds, 0.95),    // typical fast dot ≈ cruise speed
      overspeed,                                // # frame-samples > 108 km/h (a catch-up dash)
    },
    // TRACKING ERROR per mode (m) — the silent-lag gate. absMean/absP95 must NOT
    // regress phase-over-phase; bias ≈ 0 means the render sits ON its target.
    lag: lagSummary(),
    // FRAME metrics (UNRELIABLE in headless — rAF throttled to ~2 fps; read with care):
    frame_teleports: teleports,
    p95_m: pct(dists, 0.95),
    max_m: dists.length ? Math.round(Math.max(...dists)) : 0,
    by_reason: reasonObj,
    snapshot_branches: branchObj,
    examples,
  };
  // console (captured by headless browser's [console] step)
  console.log('[MDBG] ' + JSON.stringify(summary));
  // DOM mirror (read via get-text "#__mdbg" — no eval needed)
  try {
    if (!node && typeof document !== 'undefined') {
      node = document.createElement('pre');
      node.id = '__mdbg';
      node.style.cssText = 'position:fixed;left:-99999px;top:0;white-space:pre;';
      document.body.appendChild(node);
    }
    if (node) node.textContent = JSON.stringify(summary, null, 0);
  } catch {}
  try { if (typeof window !== 'undefined') window.__mdbg = summary; } catch {}

  // reset the rolling window
  reasons.clear();
  branchTotals.clear();
  dists = [];
  examples = [];
  glideSpeeds = [];
  lagByMode.clear();
  renderSpeeds = []; maxRenderMps = 0; overspeed = 0;
  teleports = 0; frames = 0; retargets = 0;
  backwardRender = 0; maxBackM = 0; overtakes = 0;
  backwardGlides = 0; fastGlides = 0; instantSnaps = 0; backwardHeld = 0; snapBacks = 0;
  maxGlideMps = 0; maxSlideMps = 0;
  windowStart = ts;
}
