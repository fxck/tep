// useShortcuts.js — global keyboard shortcuts for the live map.
//
// Binds a single window keydown listener (in useEffect, cleaned up on unmount) and
// dispatches through the SHARED canonical binding list (lib/shortcuts.js) — the same
// list the help overlay renders, so the two can never drift. Panel toggles go via the
// `panels` slice, map/camera commands via `bridge.actions.*` (called defensively — the
// engine may register them slightly after first paint).
//
// Typing context (INPUT / TEXTAREA / SELECT / contentEditable) and modifier combos
// are ignored EXCEPT for bindings flagged `global` (Esc, ⌘/Ctrl-K).

import { useEffect } from 'react';

import { panels, bridge } from '../lib/bridge.js';
import { SHORTCUTS } from '../lib/shortcuts.js';

function isTyping(t) {
  if (!t) return false;
  const tag = t.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (t.isContentEditable) return true;
  return false;
}

// Defensive action invoker — the engine registers callbacks lazily and may only
// implement a subset; a missing/throwing action must never break the listener.
function run(name) {
  const fn = bridge.actions && bridge.actions[name];
  if (typeof fn === 'function') {
    try { fn(); } catch { /* host action must not break shortcuts */ }
  }
}

export function useShortcuts() {
  useEffect(() => {
    const ctx = {
      run,
      togglePanel: (name) => panels.set((s) => ({ ...s, [name]: !s[name] })),
      openPalette: () => panels.set((s) => ({ ...s, palette: true })),
      escape: () => {
        const p = panels.get();
        if (p.help) { panels.set((s) => ({ ...s, help: false })); return; }
        if (p.palette) { panels.set((s) => ({ ...s, palette: false })); return; }
        run('clearSelection');
      },
    };

    function onKey(e) {
      for (const sc of SHORTCUTS) {
        if (!sc.match(e)) continue;
        if (!sc.global) {
          if (e.metaKey || e.ctrlKey || e.altKey) return; // don't own modifier combos
          if (isTyping(e.target)) return;                 // ignore while typing
        }
        if (sc.prevent !== false) e.preventDefault();
        sc.action(ctx);
        return;
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
