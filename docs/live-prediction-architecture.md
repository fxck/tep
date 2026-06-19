# Tep — Live Motion Prediction & Reconciliation: Architecture & Roadmap

> **Status:** design accepted (go-with-fixes), not yet implemented.
> **Provenance:** synthesized from a 22-agent design workflow (5 independent architectures, each
> adversarially vetted on 3 lenses, then synthesized + completeness-critiqued). 2026-06-19.
> **Scope:** the *live* path only — how Tep turns a sparse/stale/jumpy GPS feed into smooth,
> physical, real-time motion. (Replay/Time-Machine is a separate, secondary concern.)

---

## 1. The problem & the data (research grounding)

Render continuous, physical, 60 fps motion of ~1,800 concurrent vehicles from the PID/Golemio
GTFS-Realtime feed, on a WebGL map, converging to truth without darting / teleporting / reversing,
and braking cleanly into stops.

### Measured feed reality (live, 2026-06-19, lines 9 & 26 + fleet)

| Property | Value | Source |
|---|---|---|
| Spec'd per-vehicle update | **10–20 s** (batches 5–20 s), no per-mode diff | Golemio MPVnet docs |
| **Actual** tram inter-fix interval | **p50 50 s · p90 89 s** (line 9 p50 54 s, line 26 p50 42 s, min 8 s, max 159 s) | 4-min live capture, 37 trams |
| Actual staleness `now − origin_timestamp` (tram) | **p50 47 s · p90 88 s · max 172 s** | raw Golemio sample |
| Other modes | metro ~5 s · bus ~19 s · train ~15 s · trolleybus ~45 s | midday sample |
| Per-fix chainage jump | p50 132 m · p90 345 m · max 1.4 km | — |
| Reported speed (`spd`) | **null for 100 %** of tram/metro/train/trolleybus | — |
| `shape_dist` (chainage along route) | **99.8 % monotonic**, present ~100 % | the clean 1-D substrate |

**Takeaway:** trams update **2.5–5× slower than spec**, ~47 s stale, with no velocity signal — but a
clean 1-D chainage substrate and a known route shape. This is the empirical basis for everything below.

### 24-hour data volume (for sizing offline jobs / replay)

| Mode | Fixes/24h | Distinct tracks/24h |
|---|--:|--:|
| bus | 2,977,051 | 36,648 |
| metro | 601,513 | 1,758 |
| tram | 363,620 | 7,353 |
| train | 356,964 | 2,662 |
| **All** | **4,325,980** | **49,678** (~1,700 concurrent) |

### The current model (shipped v1.0.12 — the baseline to beat)

1-D chainage **dead-reckoning + bounded velocity-correction**, all in chainage `sd`; screen pos =
`pointAtDist(shape, sd)` (always on-rail). Per vehicle: `sdTarget` (last-fix anchor), `vSd` (EMA of
Δsd/Δfix-time, since `spd` is null), `sd` (rendered). Each frame: dead-reckon `sdReal = sdTarget +
vSd·age` (capped by per-mode lead + next-stop chainage), then reconcile via a **velocity** that is
**hard-clamped to ≤1.6× cruise before integration** (anti-dart), forward-biased, eased into stops.
Invariants: **anti-dart, forward-bias, on-rail, brake-into-stops.**

---

## 2. Design space explored (5 candidates, vetted)

| # | Design | Complexity | Vet verdicts (feasibility / UX-gain / safety) |
|---|---|---|---|
| 1 | **Recursive chainage estimator** (α-β / 1-D Kalman, uncertainty-gated convergence) | medium | viable / viable / viable |
| 2 | Learned per-segment speed profiles `v(bin, shape, ToD)` | medium | viable / **weak** / viable |
| 3 | Schedule-fusion (timetable chainage, delay-shifted) | medium | viable / **weak** / viable |
| 4 | Cadence-tuned lead/τ + coarse speed prior (incremental on v1.0.12) | medium | viable / **weak** / viable |
| 5 | Learned spacetime profile reconciliation (LSPR) | high | viable / viable / viable |

Three designs independently converged on the same two ideas: **(a) a smoother, confidence-aware
target** and **(b) a learned per-place speed field.** The UX skeptics all concluded that across a 50 s
gap *you cannot invent information* — the only new signal is **"what speed does this place run at."**

---

## 3. Chosen architecture

**One principled estimator (Kalman), its process model upgraded from constant-velocity to a learned
spatial speed field, all bounded by the retained v1.0.12 clamps.**

### Backbone — Recursive Chainage Estimator
A 2-state α-β / 1-D Kalman filter in chainage: `x = [sd, v]`, covariance `P` as 3 scalars (no matrix
lib, no allocations), layered **strictly above** the unchanged v1.0.12 corrector. The estimator only
produces (i) a better **target** `sdReal` and (ii) a **confidence-gated convergence rate** `tau_eff`
(replacing the fixed `CONV_TAU`). The rendered velocity still passes through the **byte-identical**
anti-dart clamp / forward-bias guard / next-stop cap / brake. It subsumes `vSd` (the EMA), `CONV_TAU`,
and the metro `median3` hack into one estimator with a defensible statistical meaning.

**Worker-authoritative:** the worker (single leader-writer) runs the per-fix Kalman *update* and emits
`{sd, v, posStd, t_est}` into the snapshot (replacing the emitted `vsd` seed); the client only runs the
cheap per-frame *predict + render-gate*. (Avoids dual-filter divergence; costs ~2–3 floats/vehicle.)

### Ceiling — Learned Speed Corridor (the in-gap win)
`v̄(shape_id, ~100–150 m chainage-bin, ≤4 time-of-day buckets)` = robust **median** speed mined from
ClickHouse Δsd/Δts history, fed as the Kalman **process model** (relax `v` toward `v̄(sd)` in predict)
instead of holding velocity constant across the stale gap. It's the single piece that adds real
information across the 50 s tram gap. **Degrades gracefully**: thin / high-variance bins → weight 0 →
pure constant-velocity Kalman = the safe backbone. Served via the existing `/api/shapes` + IndexedDB
path, keyed `shape_id + GTFS-feed-version`. Live **off-profile down-weight**: if a vehicle's recent
observed speed disagrees with the corridor, trust it less (diversion/incident/bunching protection).

### Anti-dart proof (structural)
The estimator changes only the *target* and the *convergence rate*. The single channel to rendered
position is `sd_render += vRender·dt`, where `vRender` comes from the **unchanged** clamp chain whose
cap denominator stays anchored to the slow EMA `vEff` (never the fresh Kalman `v`, never `v̄`).
Therefore the per-frame step is bounded by `1.6·vCruise·dt` regardless of how wrong the target is — a
large innovation enters *only* as a velocity term the clamp neutralizes. Forward-bias is restored by a
**forward-monotonic ratchet** (`sdReal = max(sdReal, sdRealPrev)` within caps) + innovation
forward-rectification; on-rail and brake-into-stops are preserved by construction (corridor is
**hard-disabled within `APPROACH_KM`** so the deterministic decel owns the final 50 m).

### Rejected (with verified reasons)
- **GTFS schedule-fusion backbone** — PG has **no `stop_times` table** (only routes/trips/stops/
  shapes/gtfs_meta); live `ns.at` is already in the *past* for 63–74 % of target vehicles and v1
  already paces on it. Would re-implement shipped behavior with a prior that's systematically stale for
  late trams (the most-noticed vehicles).
- **3-state [s, v, a] Kalman** — acceleration is unobservable from sparse fixes (overshoot/ringing).
- **Client-authoritative Kalman** — dual-filter reconcile would be a new visible failure mode.
- **Feeding the `delay` field into the chainage filter** — delay is garbage (metro especially).
- **Fleet-wide from day one** — metro/bus/train have little visible upside; concentrate on trams.

---

## 4. Phased plan

Every phase ships behind a **per-mode flag whose OFF state is byte-identical to v1.0.12** (constant-
velocity Kalman seeded from the EMA + fixed τ = baseline; corridor weight 0 = baseline). A/B on tram
lines 9 / 26 against the `?debug=motion` counters with a hard bar: `backwardGlides == 0`, no new tail
in `fastGlides`/`instantSnaps`/`overspeed`, **and** a new lag metric must not regress.

| Phase | What | Ship? |
|---|---|---|
| **0 — instrument + bank trip_id** | Add a **lag/tracking-error metric** to `motionDebug.js` (existing counters are blind to silent lag). **Bank `trip_id`** as a ClickHouse column (resolved at `source.js:157`, currently dropped) — starts the corridor data clock. Run the one-off R/Q seed query. *No motion change.* | ✅ |
| **1 — α-β replaces EMA** | Swap per-vehicle EMA `vSd` for a 2-state α-β filter, seeded ≈ V_EMA. Keep `CONV_TAU`. Subsumes the metro median3 hack. Lowest risk. | ✅ |
| **2 — full KF + gated τ** | Promote to full KF with live covariance; replace fixed `CONV_TAU` with `posStd`/age-gated `tau_eff` (8–30 s); forward-monotonic ratchet + innovation rectification + reuse the 3 snap triggers. *Pre-check: verify plain age-gated τ doesn't already capture the win before building full P.* | ✅ |
| **3 — learned speed corridor** | Nightly CH corridor rollup → KF process model. Per-bin sample-count floor, corridor disabled in `APPROACH_KM`, live off-profile down-weight. Self-activates per-shape on measured coverage. | ✅ |
| **4 — adaptive auto-tune + bunching** | Feed-health quantiles auto-tune per-(mode, ToD) lead / R age-penalty / fusion weights. Worker headway/bunching `bunchFactor ∈ [0.5, 1.2]`. | ✅ |

### Feed-health (parallel substrate)
A worker (leader-gated) periodic job computing per-(mode, ToD) **inter-fix interval** and **staleness**
(`ingested_at − ts`) quantiles → Valkey. Consumed as: adaptive lead = `p90(interval)+p90(staleness)`;
`R` age-penalty (a 172 s-stale fix corrects less than a 5 s-fresh one); corridor-vs-EMA fusion weights.
*Note: today's CH quantile queries are all on the `delay` column — the cadence/staleness job must be
built; Phases 1–3 use one-off seeds, Phase 4 depends on it.*

---

## 4a. Empirical R/Q seed (measured 2026-06-19, 3-day window, 12.9 M fixes)

The Phase-0 seed query (lag-2 autocovariance of the position 2nd-difference, segmented by
`(vehicle_id, shape_id)`, sane/uniform/forward triples only) — the high-frequency-residual split:

| mode | n | T̄ (s) | v p50/p90 (km/h) | σ_R (m) | dv_std (m/s) | q (m²/s³) | λ=σ_v·T/σ_R | Kalata α / β |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| tram | 592 k | 49.4 | 19.4 / 41.7 | 154 | 6.9 | 0.0010 | 2.21 | 0.87 / 0.81 |
| trolleybus | 42 k | 42.5 | 18.2 / 49.0 | 194 | 9.5 | 0.0021 | 2.08 | 0.86 / 0.79 |
| bus | 7.4 M | 21.8 | 33.4 / 67.7 | 80 | 8.3 | 0.0032 | 2.26 | 0.87 / 0.81 |
| train | 939 k | 17.9 | 48.5 / 106 | 55 | 15.5 | 0.0134 | 5.05 | 0.95 / 0.95 |
| metro | 1.66 M | 6.4 | 0 / 109 | 45 | 20.0 | 0.0622 | — (median path) |

**Findings that shape the filter:**
1. **σ_R is motion-contaminated at sparse cadence** — 154 m for trams is *not* GPS noise (~10 m); it's
   the irreducible motion the constant-velocity model can't predict across a 50 s gap. The estimate
   tightens as cadence densifies (metro 45 m @ 6.4 s). Confirms R/Q are convolved at this cadence.
2. **Process-noise-dominated regime (λ ≈ 2–5)** → steady-state **α ≈ 0.87, β ≈ 0.81**: trust each fix's
   position strongly, track velocity actively. Because σ_R is inflated, *true* λ is larger, so these are
   conservative lower bounds on α. Validates the shipped anchor-on-fix + EMA-velocity design; the
   estimator's real value-add is a principled **velocity + covariance**, NOT position re-smoothing
   (which would double-smooth against the client corrector → added lag).
3. **Velocity increments are large and real** (tram ~6.9 m/s ≈ 25 km/h per fix) → keep velocity
   smoothing light; α-β with high α + active β tracks genuine accel/decel without lag.

Seed gains are clamped (α∈[0.6,0.95], β∈[0.3,0.95]) and refined online by the Phase-0 lag metric.
Variable cadence (8–159 s) means fixed α-β is optimal only at nominal T̄ → Phase 2's KF adapts the
gain to actual `dt` + accumulated covariance.

## 5. Grounding facts & risks (the part that keeps this honest)

- **History is only ~3 days old, not 90** (TTL configured, data not yet accrued). Corridor payoff is
  **deferred ~4–8 weeks**. → Bank `trip_id` now; gate corridor activation per-shape on *measured* cell
  coverage (not a date); ship Phases 1–2 (no corridor dependency) for value immediately.
- **R/Q identifiability:** sensor noise R and process noise Q **cannot** be read off the raw
  132 m/345 m jump distribution (it's motion+noise convolved). Split via the high-frequency residual
  against a smoothed per-(vehicle, trip) sd-vs-ts curve (extends the existing `lagInFrame(shape_dist)`
  query, `api/clickhouse.js:644`). **Done — see §4a.** The lag-2 autocovariance split was run; it
  confirmed the convolution (σ_R inflates from 45 m @ metro cadence to 154–194 m @ tram/trolley
  cadence) and produced the per-mode α/β seeds. Float32 CH `shape_dist` quantization is ~1–4 mm at
  these chainages (≪ GPS), so it does not measurably inflate R for the seed; the live filter still
  computes from full-precision Δsd in the worker.
- **Silent-lag blind spot:** the existing teleport/backward/fast counters can't detect an estimator
  that smoothly lags real motion. The new lag metric (Phase 0) gates every subsequent phase.
- **Corridor confidently wrong** on diversions/incidents → live off-profile down-weight + sample floor +
  always-present constant-velocity fallback + the unchanged clamps bound the worst case to ~baseline.

---

## 6. Critique — **go-with-fixes**. Top must-fixes

1. **Pin the forward-bias enforcement to `main.js:1536-1537`.** That overrun guard
   (`err<0 && v.sd<sdReal ⇒ v.sd=sdReal`) yanks the render back in *one frame* when the target lands
   behind — safe today only because `sdReal` is monotonic. The `sdReal = max(sdReal, sdRealPrev)`
   ratchet **must** be applied *before* that line. Add a Phase-2 acceptance gate: `backwardGlides==0`
   under synthetic recede-target injection, not just live A/B. **Single highest invariant risk.**
2. **Anti-dart cap denominator `vCruise` must stay EMA-derived (`vEff`)** — never the fresh Kalman `v`
   or `v̄` (else a spike raises the ceiling it's bounded by). Code-review against `main.js:1509`.
3. **Resolve metro:** keep it byte-identical (current median-vsd path); α-β applies to
   tram/trolley/bus/train only. Drop the "subsumes the metro median3 hack" framing.
4. **Bunching grouping key = (line + direction + shape_id)** ordered by chainage, *not* line alone (PID
   trunk-sharing/short-turns mis-pair followers). Keep `bunchFactor = 1.0` until the pairing is verified.
5. **Micro-bench the client per-frame corridor lookup** (array-indexed `v̄` for ~1,800 vehicles @ 60 fps)
   against the 16 ms budget *before* Phase 3. If it doesn't clear, keep the per-frame integrate on the
   worker-emitted scalar `v` and apply the corridor only in the worker predict.

---

*See also: the team's `pid-prediction-architecture` / `pid-data-pipeline-facts` notes. The shipped
v1.0.11 bounded-velocity model and v1.0.12 polish (metro smoothing, lead=interval+staleness, dwell-park)
are the baseline this builds on — all changes here are strictly additive and flag-gated.*
