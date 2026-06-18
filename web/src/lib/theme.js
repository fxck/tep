// Shared theme controller.
//
// The theme MUST apply on app load regardless of whether the (popover-mounted)
// ThemeToggle is currently rendered — so ownership lives here in a module store,
// not in the component. Previously ThemeToggle owned the state + the apply effect;
// once it moved inside the More popover, the theme wasn't applied until the user
// first opened that popover (chrome flashed the wrong theme / mismatched the map).
//
// mode ∈ 'auto' | 'day' | 'night', persisted to localStorage('pidtheme'). In Auto
// it follows Prague local time (night = 19:00–07:00) and re-evaluates every 60s.
// On every effective-theme change it sets <html data-theme> and notifies the engine
// via bridge.actions.setNight (which drives the 3D night look + the live basemap).

import { bridge } from './bridge.js';

const LS_KEY = 'pidtheme';
const MODES = ['auto', 'day', 'night'];
const PRAGUE_TZ = 'Europe/Prague';

function pragueHour() {
  try {
    const s = new Intl.DateTimeFormat('en-GB', { timeZone: PRAGUE_TZ, hour: '2-digit', hour12: false }).format(new Date());
    const h = parseInt(s, 10);
    if (Number.isFinite(h)) return h % 24;
  } catch { /* ignore */ }
  return new Date().getHours();
}
export function autoIsNight() { const h = pragueHour(); return h >= 19 || h < 7; }

function readMode() {
  try { const s = localStorage.getItem(LS_KEY); if (MODES.includes(s)) return s; } catch { /* ignore */ }
  return 'day';   // fresh-visitor default: LIGHT (not auto/system, not dark). Auto/Dark stay selectable.
}
export function nightFor(mode) {
  if (mode === 'night') return true;
  if (mode === 'day') return false;
  return autoIsNight();
}

let mode = readMode();
let night = nightFor(mode);
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());

// Apply the effective theme to the DOM + engine. Idempotent.
function apply() {
  try { document.documentElement.dataset.theme = night ? 'night' : 'day'; } catch { /* ignore */ }
  try { bridge.actions.setNight?.(night); } catch { /* host must not break us */ }
}

export function getMode() { return mode; }
export function getNight() { return night; }

export function setMode(m) {
  if (!MODES.includes(m) || m === mode) { if (MODES.includes(m)) { mode = m; emit(); } return; }
  mode = m;
  try { localStorage.setItem(LS_KEY, m); } catch { /* ignore */ }
  const n = nightFor(mode);
  if (n !== night) { night = n; apply(); }
  emit();
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

let started = false;
// Call once on app mount: applies the saved/auto theme immediately and starts the
// Auto 60s re-evaluation. Also re-applies when the engine signals it's ready, so the
// 3D night look lands even if the map finished loading after React mounted.
export function startThemeEngine() {
  if (started) return;
  started = true;
  apply();
  try { window.addEventListener('pid-ready', apply); } catch { /* ignore */ }
  try {
    setInterval(() => {
      if (mode !== 'auto') return;
      const n = autoIsNight();
      if (n !== night) { night = n; apply(); emit(); }
    }, 60000);
  } catch { /* ignore */ }
}
