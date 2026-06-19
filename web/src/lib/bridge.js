// bridge.js — the reactive bus between the vanilla engine (main.js) and the React
// chrome. The engine OWNS the map, motion loop and SSE; it PUSHES live state into
// these slices and REGISTERS command callbacks. React SUBSCRIBES (useSlice) and
// invokes commands (bridge.actions.*). No React code touches MapLibre directly.
//
// A slice is a minimal external store compatible with React's useSyncExternalStore.

import { useSyncExternalStore } from 'react';

function slice(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(next) {
      const v = typeof next === 'function' ? next(state) : next;
      if (Object.is(v, state)) return;
      state = v;
      subs.forEach((f) => f());
    },
    // shallow-merge helper for object slices
    patch(part) {
      this.set((s) => ({ ...s, ...part }));
    },
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
  };
}

// --- live state (engine -> React) -------------------------------------------
export const stats = slice({ count: 0, src: 'connecting', conn: false, ageMs: null, byMode: null, stale: false });
export const selected = slice(null);   // { props, follow } | null  (props = propsOf(vehicle))
export const stop = slice(null);        // { name, lon, lat } | null — the clicked station (StopCard)
export const filters = slice({
  modes: { tram: true, metro: true, bus: true, train: true, trolleybus: true, other: true },
  lines: [],   // active line filter — a set of line keys (uppercased); [] = all
});
export const layers = slice({ routes: true, stops: true, buildings: true, buildingOpacity: 0.30, heatmap: false, pins: true, aerial: false });
export const camera = slice({ pitch: 0, bearing: 0 });
export const view = slice({ render3D: false, supports3D: true, reducedMotion: false });

// --- chrome-only UI state (React <-> React; also toggled by shortcuts) -------
export const panels = slice({ insights: false, palette: false, help: false, driving: false, cardHidden: false, timeMachine: false });

// --- Time Machine replay engine state (vanilla engine -> React panel) --------
// The replay ENGINE (timeMachine.js) owns its MapLibre source/layer + virtual
// clock and PATCHES this slice; the React <TimeMachine/> panel reads it and
// dispatches replay* actions back. vt/count are throttled (~5 Hz) by the engine.
export const replay = slice({
  loading: false, msg: '', err: false,
  loaded: false, playing: false, speed: 60,
  from: 0, to: 0, vt: 0, count: 0, total: 0,
});

// --- command + data registry (filled by the engine at map load) --------------
export const bridge = { stats, selected, stop, filters, layers, camera, view, panels, replay, actions: {}, helpers: {} };

export function setActions(a) { Object.assign(bridge.actions, a); }
export function setHelpers(h) { Object.assign(bridge.helpers, h); }

// React hook: subscribe a component to a slice.
export function useSlice(sl) {
  return useSyncExternalStore(sl.subscribe, sl.get, sl.get);
}
