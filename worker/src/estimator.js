// Worker-authoritative recursive chainage estimator.
//
// Per-vehicle 2-state filter in chainage [sd, v] (km, km/ms), updated ONCE per
// genuinely-new fix. It emits {esd, ev} that the browser consumes as a cleaner
// dead-reckon TARGET + velocity — replacing the client's own per-fix EMA
// recompute — while the client's bounded-velocity corrector still owns every
// rendered pixel (so the anti-dart / forward-bias / on-rail invariants are
// untouched; see web/src/main.js stepMotion).
//
// Why worker-authoritative: a single leader process runs one filter per vehicle,
// so the estimate is consistent across all browsers and there is no dual-filter
// divergence. Costs ~2 floats/vehicle in the snapshot.
//
// Phase 1 = fixed-gain α-β (this file). Phase 2 promotes the constant gains to a
// 1-D Kalman recursion with live covariance and also emits posStd (eps).
//
// FLAG: per-mode via the PRED_MODES env (comma-separated, e.g. "tram,bus").
//   • empty (default)  → updateEstimator() returns null for every vehicle →
//     source.js emits NO esd field → the client takes its byte-identical
//     v1.0.12 path. The whole feature is dark until a mode is named.
//   • metro is HARD-excluded — its dense ~5 s feed already rides a median path
//     and must stay byte-identical (architecture must-fix #3).

const VMAX_KMH = { tram: 65, metro: 90, train: 150, bus: 70, trolleybus: 65, ferry: 35, funicular: 30, cablecar: 30, gondola: 30, other: 95 };
const vmaxKmMs = (m) => (VMAX_KMH[m] || 90) / 3.6e6; // km per millisecond

// α (position gain) / β (velocity gain) seeded from the measured Kalata indices
// (architecture §4a: λ≈2–5 ⇒ trust the fix, track velocity actively), damped for
// safety and refined online via the Phase-0 lag metric. β acts on the position
// residual over the interval (v += (β/dt)·r), so it is dt-normalised here even
// though the steady-state seed assumed nominal T̄.
const AB = {
  tram:       { a: 0.82, b: 0.45 },
  trolleybus: { a: 0.82, b: 0.45 },
  bus:        { a: 0.84, b: 0.50 },
  train:      { a: 0.88, b: 0.62 },
};
const DEFAULT_AB = { a: 0.82, b: 0.45 };

// Discontinuity thresholds — mirror the client snap triggers (main.js SD_SNAP_KM /
// SD_BACK_KM) so a reset HERE and a client warp agree on what is a trip jump.
const SD_SNAP_KM = 0.25;   // |innovation| beyond this ⇒ data/trip discontinuity ⇒ reset
const SD_BACK_KM = 0.12;   // a real reversal / turnaround ⇒ reset
const MAX_DT_MS = 180000;  // gap longer than this ⇒ fresh segment (stale-feed revival), reset

const round = (n, d) => { const f = 10 ** d; return Math.round(n * f) / f; };

const PRED_MODES = (() => {
  const raw = (process.env.PRED_MODES || '').trim();
  const set = new Set(raw ? raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : []);
  set.delete('metro'); // never estimate metro — stays byte-identical
  return set;
})();

export function predModesActive() { return [...PRED_MODES]; }

const state = new Map(); // id -> { sd, v, ts, shp }

// updateEstimator(id, mode, sd, ts, shp): one α-β step for a genuinely-new fix.
// Returns { esd, ev } (km, km/ms) when the mode is estimated, else null.
// Between fixes (ts unchanged) it HOLDS and re-emits the current estimate so every
// snapshot the client might refresh against carries a consistent {esd, ev}.
export function updateEstimator(id, mode, sd, ts, shp) {
  if (!PRED_MODES.has(mode) || sd == null || !ts) return null;
  const vmax = vmaxKmMs(mode);
  const g = AB[mode] || DEFAULT_AB;
  let st = state.get(id);

  // Reset: first sight, shape/trip change, or a too-long gap.
  if (!st || st.shp !== shp || !st.ts || (ts - st.ts) > MAX_DT_MS) {
    st = { sd, v: 0, ts, shp };
    state.set(id, st);
    return { esd: round(sd, 6), ev: 0 };
  }
  if (ts <= st.ts) {                                  // not newer → hold
    return { esd: round(st.sd, 6), ev: round(st.v, 8) };
  }

  const dt = ts - st.ts;                              // ms
  const sdPred = st.sd + st.v * dt;                   // predict (constant velocity)
  const r = sd - sdPred;                              // innovation (km)

  // Discontinuity → reset (mirror the client snap branches).
  if (Math.abs(r) > SD_SNAP_KM || r < -SD_BACK_KM) {
    st.sd = sd; st.v = 0; st.ts = ts; st.shp = shp;
    return { esd: round(sd, 6), ev: 0 };
  }

  // α-β update.
  let sdNew = sdPred + g.a * r;
  let vNew = st.v + (g.b / dt) * r;
  if (vNew < 0) vNew = 0;                             // chainage velocity forward-only
  if (vNew > vmax) vNew = vmax;
  st.sd = sdNew; st.v = vNew; st.ts = ts; st.shp = shp;
  return { esd: round(sdNew, 6), ev: round(vNew, 8) };
}

// Bound memory: drop filter state for vehicles no longer in the live set.
export function pruneEstimator(liveIds) {
  for (const k of state.keys()) if (!liveIds.has(k)) state.delete(k);
}
