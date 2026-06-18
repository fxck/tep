// pwa.js — service-worker registration (guarded, production/https only).
//
// Registers '/sw.js'. We deliberately only register when:
//   - the browser supports service workers, AND
//   - we're on https OR localhost (so dev over http on a LAN IP doesn't try), AND
//   - this is a production build (import.meta.env.PROD) — Vite dev server should
//     not be intercepted by a SW.
// Any failure is logged quietly and swallowed: a broken/absent SW must never block
// the app from running.

export function registerPWA() {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;

    // Only in production builds. import.meta.env may be undefined in odd contexts.
    let isProd = false;
    try { isProd = !!(import.meta && import.meta.env && import.meta.env.PROD); } catch { isProd = false; }
    if (!isProd) return;

    // Require a secure context (https) or localhost.
    const loc = (typeof location !== 'undefined') ? location : null;
    const host = loc ? loc.hostname : '';
    const secure = (typeof window !== 'undefined' && window.isSecureContext)
      || (loc && loc.protocol === 'https:')
      || host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (!secure) return;

    const onLoad = () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        // quiet: don't surface to the user, don't throw
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[pwa] service worker registration failed:', err && err.message ? err.message : err);
        }
      });
    };

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      // wait for load so SW install doesn't compete with first paint
      if (document.readyState === 'complete') onLoad();
      else window.addEventListener('load', onLoad, { once: true });
    } else {
      onLoad();
    }
  } catch (err) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[pwa] registration guard error:', err && err.message ? err.message : err);
    }
  }
}
