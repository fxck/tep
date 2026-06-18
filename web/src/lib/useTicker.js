// useTicker — ONE shared 1-second clock for the whole chrome. A single
// module-level setInterval drives a useSyncExternalStore; components that show
// relative time (age, ETA countdowns) subscribe to THIS instead of each spinning
// up its own setInterval + setState. Crucially it's a LEAF subscription: only the
// components that call useTicker() re-render each second — never the App shell
// (a 1s setState lifted into App would re-render the whole sheet tree at ~650
// vehicles). The interval only runs while at least one subscriber is mounted.
import { useSyncExternalStore } from 'react';

let now = Date.now();
const subs = new Set();
let timer = null;

function subscribe(fn) {
  subs.add(fn);
  if (!timer) {
    timer = setInterval(() => { now = Date.now(); subs.forEach((f) => f()); }, 1000);
  }
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) { clearInterval(timer); timer = null; }
  };
}

// Returns a value that changes once per second — use it to recompute relative
// time strings. The returned number is Date.now() at the last tick.
export function useTicker() {
  return useSyncExternalStore(subscribe, () => now, () => now);
}
