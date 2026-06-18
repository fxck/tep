// timeMachine.js — historical replay ("Time Machine") ENGINE.
//
// This module owns ONLY the replay mechanics; the UI is the React <TimeMachine/>
// panel (chrome/TimeMachine.jsx), which reads the `replay` bridge slice this
// engine patches and dispatches replay* actions back through the controller.
//
// It fetches:
//   {apiBase}/api/analytics/replay?from=<unixMs>&to=<unixMs>&line=<line>
//   -> { disabled, vehicles:[{ id, line, mode, color, fixes:[[tMs,lat,lon,bearing,delay],...] }] }
//
// and manages its OWN MapLibre source + layer (NEVER the live 'vehicles' source):
//   source id : 'replay-veh'  (geojson)
//   layer id  : 'replay-veh'  (circle)
// A virtual clock plays across [from,to]; each animation frame we interpolate
// every vehicle's position between its bracketing fixes and setData the source.
//
// onEnter() fires when a replay starts (orchestrator dims/hides the live layer);
// onExit() fires when the user closes replay (orchestrator restores live).
// onOpenChange(bool) tracks the panel's open state (drives panels.timeMachine).
//
// Returns a controller { open, close, toggle, isOpen, load, play, pause,
// togglePlay, scrub, setSpeed, destroy }. Graceful when disabled/empty.

import { replay as replaySlice } from './lib/bridge.js';

const SRC = 'replay-veh';
const LYR = 'replay-veh';
const VT_PUSH_MS = 180;   // throttle the virtual-clock slice push (~5 Hz) so the
                          // React panel re-renders the clock/scrub a few times a
                          // second, while the map vehicles still animate at 60 fps.

export function initTimeMachine({ map, apiBase, onEnter, onExit, onOpenChange } = {}) {
  apiBase = (apiBase || '').replace(/\/+$/, '');

  // --- replay state ----------------------------------------------------------
  let data = null;            // { from, to, vehicles:[{id,line,mode,color,fixes:[[t,lat,lon,brg,dl]]}] }
  let from = 0, to = 0;
  let vt = 0;                 // virtual clock (unix ms)
  let playing = false;
  let speed = 60;             // playback multiplier (×)
  let raf = 0;
  let lastFrame = 0;
  let lastVtPush = 0;
  let entered = false;        // whether onEnter() has been signalled
  let drawerOpen = false;

  const patch = (p) => { try { replaySlice.patch(p); } catch { /* slice not ready */ } };
  function setMsg(text, isErr) { patch({ msg: text || '', err: !!isErr }); }

  // --- map source/layer (guarded) -------------------------------------------
  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }

  function ensureLayer() {
    if (!map || typeof map.getSource !== 'function') return false;
    if (!map.getSource(SRC)) map.addSource(SRC, { type: 'geojson', data: emptyFC() });
    if (!map.getLayer(LYR)) {
      map.addLayer({
        id: LYR,
        type: 'circle',
        source: SRC,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 13, 5, 16, 7],
          'circle-color': ['coalesce', ['get', 'color'], '#f0b100'],
          'circle-stroke-color': '#0b1220',
          'circle-stroke-width': 1.5,
          'circle-opacity': 0.95,
        },
      });
    }
    return true;
  }

  function removeLayer() {
    if (!map || typeof map.getLayer !== 'function') return;
    try { if (map.getLayer(LYR)) map.removeLayer(LYR); } catch { /* ignore */ }
    try { if (map.getSource(SRC)) map.removeSource(SRC); } catch { /* ignore */ }
  }

  function setData(fc) {
    if (!map || typeof map.getSource !== 'function') return;
    const src = map.getSource(SRC);
    if (src && typeof src.setData === 'function') src.setData(fc);
  }

  // --- interpolation ---------------------------------------------------------
  // fixes: ascending [[tMs, lat, lon, bearing, delay], ...]; find the position at
  // virtual time `t` by interpolating between the bracketing fixes.
  function sampleVehicle(v, t) {
    const f = v.fixes;
    if (!f || !f.length) return null;
    if (t <= f[0][0]) return feat(v, f[0][2], f[0][1], f[0][3], f[0][4]);
    const lastFix = f[f.length - 1];
    if (t >= lastFix[0]) return feat(v, lastFix[2], lastFix[1], lastFix[3], lastFix[4]);
    let lo = 0, hi = f.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (f[mid][0] <= t) lo = mid; else hi = mid;
    }
    const a = f[lo], b = f[hi];
    const span = b[0] - a[0] || 1;
    const k = (t - a[0]) / span;
    const lat = a[1] + (b[1] - a[1]) * k;
    const lon = a[2] + (b[2] - a[2]) * k;
    const brg = lerpAngle(a[3], b[3], k);
    const dl = a[4] == null ? b[4] : a[4];
    return feat(v, lon, lat, brg, dl);
  }

  function lerpAngle(a, b, k) {
    if (a == null && b == null) return 0;
    if (a == null) return b;
    if (b == null) return a;
    const d = ((b - a + 540) % 360) - 180;
    return (a + d * k + 360) % 360;
  }

  function feat(v, lon, lat, brg, dl) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { id: v.id, line: v.line, color: v.color || '#f0b100', bearing: brg || 0, delay: dl == null ? null : dl },
    };
  }

  function renderAt(t, forcePush) {
    if (!data) return;
    const feats = [];
    let live = 0;
    for (const v of data.vehicles) {
      const f = v.fixes;
      if (!f || !f.length) continue;
      if (t < f[0][0] - 1000 || t > f[f.length - 1][0] + 1000) continue;  // ignore ghosts at the edges
      const ft = sampleVehicle(v, t);
      if (ft) { feats.push(ft); live++; }
    }
    setData({ type: 'FeatureCollection', features: feats });
    // Throttle the slice push (clock/scrub UI) so React doesn't re-render 60×/s.
    const now = performance.now();
    if (forcePush || now - lastVtPush >= VT_PUSH_MS) {
      lastVtPush = now;
      patch({ vt: t, count: live });
    }
  }

  function setVt(t, forcePush) {
    vt = Math.max(from, Math.min(to, t));
    renderAt(vt, forcePush);
  }

  // --- playback loop ---------------------------------------------------------
  function step(ts) {
    if (!playing) return;
    if (!lastFrame) lastFrame = ts;
    const dtReal = ts - lastFrame;
    lastFrame = ts;
    setVt(vt + dtReal * speed, false);
    if (vt >= to) { pause(); return; }      // reached the end
    raf = requestAnimationFrame(step);
  }

  function play() {
    if (!data || to <= from) return;
    if (vt >= to) setVt(from, true);        // restart from the beginning
    playing = true;
    patch({ playing: true });
    lastFrame = 0;
    raf = requestAnimationFrame(step);
  }
  function pause() {
    playing = false;
    patch({ playing: false });
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }
  function togglePlay() { if (playing) pause(); else play(); }

  function scrub(frac) {
    if (!data) return;
    pause();
    const f = Math.max(0, Math.min(1, Number(frac) || 0));
    setVt(from + f * (to - from), true);
  }

  function setSpeed(x) {
    const s = Number(x);
    if (Number.isFinite(s) && s > 0) { speed = s; patch({ speed: s }); }
  }

  // --- fetch + enter/exit ----------------------------------------------------
  // load({ line, mode, from, to }) — replay is bounded by EITHER a single line key
  // OR a whole mode ('tram'|'metro'|'bus'|'train'|'trolleybus'); from/to are unix ms.
  async function load(opts = {}) {
    const line = String(opts.line || '').trim();
    const mode = String(opts.mode || '').trim();
    const fMs = Number(opts.from);
    const tMs = Number(opts.to);

    if (!line && !mode) { setMsg('Pick a line or a whole mode (e.g. all trams) to replay.', true); return; }
    if (!Number.isFinite(fMs) || !Number.isFinite(tMs) || tMs <= fMs) {
      setMsg('Pick a valid window (To must be after From).', true); return;
    }
    if (!apiBase) { setMsg('No API configured for replay.', true); return; }

    pause();
    patch({ loading: true, err: false, loaded: false, msg: 'Loading replay…' });

    const qs = new URLSearchParams({ from: String(fMs), to: String(tMs) });
    if (line) qs.set('line', line);
    if (mode) qs.set('mode', mode);
    let json = null;
    try {
      const r = await fetch(`${apiBase}/api/analytics/replay?${qs.toString()}`, { cache: 'no-store' });
      if (!r.ok) { patch({ loading: false }); setMsg(`Replay request failed (${r.status}).`, true); return; }
      json = await r.json();
    } catch {
      patch({ loading: false }); setMsg('Replay request failed (network).', true); return;
    }
    patch({ loading: false });

    if (!json || json.disabled) {
      const reason = json && json.reason;
      setMsg(
        reason === 'line or mode required'
          ? 'Pick a line to replay (e.g. 22, A, S7).'
          : 'Replay history isn’t available yet — no banked fixes for that window.',
        reason === 'line or mode required',
      );
      teardownReplay();
      return;
    }
    const vehicles = Array.isArray(json.vehicles)
      ? json.vehicles.filter((v) => v && Array.isArray(v.fixes) && v.fixes.length) : [];
    if (!vehicles.length) { setMsg('No history found for that window / line.', false); teardownReplay(); return; }

    // Normalize + bound the timeline to the actual data extent (within [fMs,tMs]).
    let lo = Infinity, hi = -Infinity;
    for (const v of vehicles) {
      v.fixes.sort((a, b) => a[0] - b[0]);
      lo = Math.min(lo, v.fixes[0][0]);
      hi = Math.max(hi, v.fixes[v.fixes.length - 1][0]);
    }
    from = Math.max(fMs, Math.min(lo, tMs));
    to = Math.min(tMs, Math.max(hi, fMs));
    if (!(to > from)) { from = fMs; to = tMs; }      // degenerate guard

    data = { from, to, vehicles };

    if (!ensureLayer()) { setMsg('Map not ready for replay.', true); return; }
    if (!entered) { entered = true; if (typeof onEnter === 'function') { try { onEnter(); } catch { /* ignore */ } } }

    patch({ loaded: true, from, to, total: vehicles.length });
    setMsg(`Loaded ${vehicles.length} vehicle${vehicles.length === 1 ? '' : 's'}.`, false);
    setVt(from, true);
    play();   // auto-play on load
  }

  // Stop playback, drop data + our layer, restore live layer (onExit) — but DON'T
  // close the panel (caller decides).
  function teardownReplay() {
    pause();
    data = null;
    patch({ loaded: false, vt: 0, count: 0, total: 0 });
    setData(emptyFC());
    removeLayer();
    if (entered) { entered = false; if (typeof onExit === 'function') { try { onExit(); } catch { /* ignore */ } } }
  }

  // --- panel open/close ------------------------------------------------------
  function openDrawer() {
    if (drawerOpen) return;
    drawerOpen = true;
    if (typeof onOpenChange === 'function') onOpenChange(true);
  }
  function closeDrawer() {
    if (!drawerOpen) return;
    drawerOpen = false;
    teardownReplay();          // leaving the panel fully restores the live map
    if (typeof onOpenChange === 'function') onOpenChange(false);
  }
  function toggleDrawer() { if (drawerOpen) closeDrawer(); else openDrawer(); }

  return {
    open: openDrawer,
    close: closeDrawer,
    toggle: toggleDrawer,
    isOpen: () => drawerOpen,
    load,
    play,
    pause,
    togglePlay,
    scrub,
    setSpeed,
    destroy() {
      pause();
      teardownReplay();
    },
  };
}
