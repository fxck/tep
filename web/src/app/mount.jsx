import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

// Mount the React chrome island into #ui-root. Called by main.js after the engine
// has registered its bridge actions/helpers. Guarded so a chrome fault never
// blanks the map (the engine keeps running regardless).
export function mountUI() {
  const el = document.getElementById('ui-root');
  if (!el) return;
  try {
    createRoot(el).render(<App />);
  } catch (err) {
    console.warn('[ui] mount failed:', err && err.message);
  }
}
