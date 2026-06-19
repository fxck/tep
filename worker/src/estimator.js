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
// Phase 2 (this file) = a 1-D constant-velocity KALMAN filter: state x=[sd, v],
// covariance P kept as 3 scalars (p00, p01, p11) — no matrix lib, no allocations.
// It supersedes the Phase-1 fixed-gain α-β: the gain now adapts to the ACTUAL dt
// (a 150 s gap is trusted differently from a 10 s one) and to accumulated
// uncertainty, and it emits posStd (eps = √p00) so the client can gate its
// convergence rate on confidence + age. R and q are seeded from the measured
// per-mode noise (architecture §4a); R is scaled by R_TRUST below to undo the
// motion-contamination inflation in the lag-2 σ_R estimate, which lands the
// steady-state position gain at the validated Phase-1 level (K0≈0.81 ≈ α=0.82).
//
// FLAG: per-mode via the PRED_MODES env (comma-separated, e.g. "tram,bus").
//   • empty (default)  → updateEstimator() returns null for every vehicle →
//     source.js emits NO esd field → the client takes its byte-identical
//     v1.0.12 path. The whole feature is dark until a mode is named.
//   • metro is HARD-excluded — its dense ~5 s feed already rides a median path
//     and must stay byte-identical (architecture must-fix #3).

const VMAX_KMH = { tram: 65, metro: 90, train: 150, bus: 70, trolleybus: 65, ferry: 35, funicular: 30, cablecar: 30, gondola: 30, other: 95 };
const vmaxKmMs = (m) => (VMAX_KMH[m] || 90) / 3.6e6; // km per millisecond

// Per-mode Kalman noise, in NATIVE units (km, ms):
//   R  = measurement variance (km²)        ← (R_TRUST · σ_R[m] / 1000)²
//   q  = acceleration PSD (km²/ms³)        ← (dv_std[m/s]·1e-6)² / (T̄[s]·1000)
// σ_R and dv_std are the §4a measured values. R_TRUST<1 undoes the sparse-cadence
// inflation of the lag-2 σ_R (which conflates motion with noise), so the filter
// trusts fixes at the level the validated α-β did. Values precomputed for clarity.
const R_TRUST = 0.7;
const KF = {
  //              R (km²)     q (km²/ms³)   ← σ_R(m) / dv_std(m/s) / T̄(s)
  tram:       { R: 0.01161, q: 9.6e-16 },  // 154 / 6.9 / 49.4
  trolleybus: { R: 0.01844, q: 2.1e-15 },  // 194 / 9.5 / 42.5
  bus:        { R: 0.00314, q: 3.2e-15 },  // 80  / 8.3 / 21.8
  train:      { R: 0.00148, q: 1.3e-14 },  // 55  / 15.5 / 17.9
};
const DEFAULT_KF = { R: 0.01161, q: 9.6e-16 };
void R_TRUST; // documentation of how the R values above were derived

// Discontinuity thresholds — mirror the client snap triggers (main.js SD_SNAP_KM /
// SD_BACK_KM) so a reset HERE and a client warp agree on what is a trip jump.
const SD_SNAP_KM = 0.25;   // |innovation| beyond this ⇒ data/trip discontinuity ⇒ reset
const SD_BACK_KM = 0.12;   // a real reversal / turnaround ⇒ reset
const MAX_DT_MS = 180000;  // gap longer than this ⇒ fresh segment (stale-feed revival), reset

const round = (n, d) => { const f = 10 ** d; return Math.round(n * f) / f; };

// Reported-speed measurement noise (km/ms)². The feed's `speed` field (buses, ~76%;
// ferry) is an integer km/h instantaneous reading — quantization + sensor jitter ≈ ±8 km/h.
// Fusing it as a SECOND measurement (on the velocity state) injects a FRESH velocity the
// chainage-delta filter would otherwise have to ramp into, cutting the cold-start + lag bias.
const R_V = (8 / 3.6e6) ** 2;

// Modes where carrying pre-reset velocity through a forward snap is SAFE + helpful: the
// sparse, low-speed rail modes (tram/trolley), whose cold-start lag is large and whose
// speeds are too low to fatten tails. Buses instead fuse their reported speed (better);
// train is excluded — fast + fat-tailed, any carry over-predicts and inflated its RMSE.
const CARRY_MODES = new Set(['tram', 'trolleybus']);

const PRED_MODES = (() => {
  const raw = (process.env.PRED_MODES || '').trim();
  const set = new Set(raw ? raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : []);
  set.delete('metro'); // never estimate metro — stays byte-identical
  return set;
})();

export function predModesActive() { return [...PRED_MODES]; }

const state = new Map(); // id -> { sd, v, ts, shp, p00, p01, p11 }

// Fresh-trip covariance: position known to ~sensor precision, velocity unknown.
function initP(kf, vmax) {
  return { p00: kf.R, p01: 0, p11: vmax * vmax };     // (km², km²/ms, (km/ms)²)
}

// esd = filtered chainage (km); ev = filtered velocity (km/ms); eps = position std (√p00, km);
// evs = velocity std (√p11, km/ms) — lets the client compute HORIZON-AWARE uncertainty
// √(eps² + (evs·age)²) instead of gating on sensor noise alone (architecture: eps recalibration).
function emit(st) {
  return {
    esd: round(st.sd, 6), ev: round(st.v, 8),
    eps: round(Math.sqrt(Math.max(0, st.p00)), 5),
    evs: round(Math.sqrt(Math.max(0, st.p11)), 9),
  };
}

// updateEstimator(id, mode, sd, ts, shp, spdKmh): one Kalman step for a genuinely-new fix.
// Returns { esd, ev, eps, evs } when the mode is estimated, else null. Between fixes (ts
// unchanged) it HOLDS and re-emits. spdKmh = the feed's reported instantaneous speed (km/h,
// buses/ferry; null for rail) — used to SEED velocity on reset and FUSE it as a measurement.
export function updateEstimator(id, mode, sd, ts, shp, spdKmh) {
  if (!PRED_MODES.has(mode) || sd == null || !ts) return null;
  const vmax = vmaxKmMs(mode);
  const kf = KF[mode] || DEFAULT_KF;
  // Reported speed as a velocity observation (km/ms), when present + sane.
  const zv = (spdKmh != null && isFinite(spdKmh) && spdKmh >= 0) ? Math.min(spdKmh / 3.6e6, vmax) : null;
  let st = state.get(id);

  // VELOCITY SEED on reset: prefer a direct speed observation; else carry the pre-reset
  // velocity when the vehicle was clearly mid-motion (gap revival / forward data-jump); else 0.
  // Killing the unconditional v=0 reset removes the cold-start lag that a memoryless filter
  // otherwise pays at the start of every segment.
  const canCarry = CARRY_MODES.has(mode);
  const seedV = (carry) => (zv != null ? zv : (carry && canCarry && st ? Math.min(Math.max(0, st.v), vmax) : 0));

  // Reset: first sight, shape/trip change, or a too-long gap (stale-feed revival). Do NOT
  // carry velocity across a long TIME gap — a >180 s-old speed is too stale and blew up
  // fast-mode (train) tails. A fresh speed obs (zv) still seeds; else start at 0.
  if (!st || st.shp !== shp || !st.ts || (ts - st.ts) > MAX_DT_MS) {
    const P = initP(kf, vmax);
    st = { sd, v: seedV(false), ts, shp, ...P };
    state.set(id, st);
    return emit(st);
  }
  if (ts <= st.ts) return emit(st);                   // not newer → hold

  const dt = ts - st.ts;                              // ms
  // --- PREDICT (constant-velocity; process noise = white-acceleration PSD q) ---
  const sdPred = st.sd + st.v * dt;
  const innov = sd - sdPred;                          // innovation (km)

  // Discontinuity → reset (mirror the client snap branches). A FORWARD jump means the vehicle
  // was moving fast (keep momentum / seed from speed); a BACKWARD jump is a reversal (v=0 unless
  // a fresh speed obs says otherwise).
  if (Math.abs(innov) > SD_SNAP_KM || innov < -SD_BACK_KM) {
    // A FORWARD position-jump (innov>0) within the cadence window means the vehicle was
    // moving fast — keep that momentum (helps the sparse modes) rather than cold-starting at 0.
    // A BACKWARD jump is a reversal → v=0 (unless a fresh speed obs seeds it).
    const P = initP(kf, vmax);
    st.sd = sd; st.v = seedV(innov > 0); st.ts = ts; st.shp = shp; st.p00 = P.p00; st.p01 = P.p01; st.p11 = P.p11;
    return emit(st);
  }

  const dt2 = dt * dt, dt3 = dt2 * dt;
  // P⁻ = F·P·Fᵀ + Q,  F = [[1,dt],[0,1]],  Q = q·[[dt³/3, dt²/2],[dt²/2, dt]]
  let p00 = st.p00 + 2 * dt * st.p01 + dt2 * st.p11 + kf.q * dt3 / 3;
  let p01 = st.p01 + dt * st.p11 + kf.q * dt2 / 2;
  let p11 = st.p11 + kf.q * dt;

  // --- UPDATE 1: position (scalar z = sd, H = [1,0]) ---
  const S = p00 + kf.R;
  const k0 = p00 / S, k1 = p01 / S;
  let sdNew = sdPred + k0 * innov;
  let vNew = st.v + k1 * innov;
  let n00 = (1 - k0) * p00, n01 = (1 - k0) * p01, n11 = p11 - k1 * p01;

  // --- UPDATE 2: velocity fusion (scalar z = reported speed, H = [0,1]) — buses/ferry ---
  // Injects the FRESH instantaneous speed so the rendered velocity doesn't trail an
  // accelerating vehicle as far. Skipped (no-op) for rail, which has no speed field.
  if (zv != null) {
    const Sv = n11 + R_V;
    const kv0 = n01 / Sv, kv1 = n11 / Sv;
    const dvv = zv - vNew;
    sdNew += kv0 * dvv;
    vNew += kv1 * dvv;
    const m00 = n00 - kv0 * n01, m01 = n01 - kv0 * n11, m11 = n11 - kv1 * n11;
    n00 = m00; n01 = m01; n11 = m11;
  }
  if (vNew < 0) vNew = 0;                              // chainage velocity forward-only (rectification)
  if (vNew > vmax) vNew = vmax;

  st.sd = sdNew; st.v = vNew; st.ts = ts; st.shp = shp;
  st.p00 = Math.max(0, n00); st.p01 = n01; st.p11 = Math.max(0, n11);
  return emit(st);
}

// Bound memory: drop filter state for vehicles no longer in the live set.
export function pruneEstimator(liveIds) {
  for (const k of state.keys()) if (!liveIds.has(k)) state.delete(k);
}
