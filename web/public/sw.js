/* sw.js — minimal, SAFE service worker for the PID Live map.
 *
 * Strategy:
 *   - App shell ('/' and '/index.html'): NETWORK-FIRST. The shell is tiny and
 *     points at the immutable hashed bundle, so it must be fresh — a cache-first
 *     shell pins users to a stale index.html (→ stale bundle) across deploys until
 *     the SW version changes. Network-first serves the latest shell when online and
 *     falls back to the cached copy offline.
 *   - Vite's hashed build assets (/assets/*, immutable hashed filenames):
 *     stale-while-revalidate — serve from cache, refresh in the background.
 *   - /api/* and the SSE stream (/api/stream): NEVER cached. Always network,
 *     no-store. Realtime data must never be stale or replayed from cache.
 *   - Cross-origin requests (the API may live on a different host, tiles, fonts):
 *     pass straight through to the network, untouched.
 *
 * Everything is guarded so a SW failure degrades to plain network (the app still
 * works). Versioned cache name + activate-time cleanup of old caches.
 * skipWaiting + clients.claim so updates take effect promptly.
 */

const VERSION = 'pid-v3';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const SHELL_URLS = ['/', '/index.html'];

// --- install: precache the app shell ---------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SHELL_CACHE);
        // addAll is atomic-ish; if any URL 404s it rejects, so add individually
        // and ignore failures (a missing shell entry must not abort install).
        await Promise.all(SHELL_URLS.map((u) =>
          cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
      } catch (e) { /* ignore — fall back to network */ }
      // Activate this version immediately.
      try { await self.skipWaiting(); } catch (e) { /* ignore */ }
    })()
  );
});

// --- activate: drop old caches, take control --------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => {
          // delete anything not from the current version
          if (k !== SHELL_CACHE && k !== ASSET_CACHE) return caches.delete(k);
          return Promise.resolve(false);
        }));
      } catch (e) { /* ignore */ }
      try { await self.clients.claim(); } catch (e) { /* ignore */ }
    })()
  );
});

// --- helpers ----------------------------------------------------------------
function isApiOrStream(url) {
  // never touch the API or the SSE stream (same-origin /api/*)
  return url.pathname.startsWith('/api/') || url.pathname === '/api/stream';
}
function isHashedAsset(url) {
  // Vite emits hashed files under /assets/ ; also treat common hashed static types.
  if (url.pathname.startsWith('/assets/')) return true;
  return /\.[0-9a-f]{8,}\.(?:js|css|woff2?|png|jpg|jpeg|svg|webp|gif|ico)$/i.test(url.pathname);
}

async function staleWhileRevalidate(request) {
  let cache;
  try { cache = await caches.open(ASSET_CACHE); } catch (e) { return fetch(request); }
  const cached = await cache.match(request);
  const network = fetch(request).then((resp) => {
    try {
      if (resp && resp.ok && (resp.type === 'basic' || resp.type === 'default')) {
        cache.put(request, resp.clone());
      }
    } catch (e) { /* ignore */ }
    return resp;
  }).catch(() => null);
  return cached || network || fetch(request);
}

async function networkFirstShell(request) {
  let cache;
  try { cache = await caches.open(SHELL_CACHE); } catch (e) { return fetch(request); }
  // NETWORK-FIRST: always try to fetch the freshest shell so a new deploy (new
  // hashed bundle reference in index.html) is picked up immediately. Cache the
  // fresh copy for offline, and only fall back to cache when the network fails.
  try {
    const resp = await fetch(request, { cache: 'no-store' });
    try { if (resp && resp.ok) cache.put('/', resp.clone()); } catch (e) { /* ignore */ }
    return resp;
  } catch (e) {
    const cached = await cache.match(request) || await cache.match('/');
    if (cached) return cached;
    throw e;
  }
}

// --- fetch routing ----------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // only handle GET; everything else straight to network
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }

  // cross-origin (API on another host, map tiles, fonts, etc.): don't intercept
  if (url.origin !== self.location.origin) return;

  // API + SSE: ALWAYS network, no-store, never cache. Bypass the SW cache entirely.
  if (isApiOrStream(url)) {
    event.respondWith(fetch(req, { cache: 'no-store' }).catch(() => Response.error()));
    return;
  }

  // navigations / app shell → network-first shell (fresh deploys win)
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(networkFirstShell(req));
    return;
  }

  // hashed build assets → stale-while-revalidate
  if (isHashedAsset(url)) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  // anything else same-origin: try cache, fall back to network (no aggressive caching)
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req)).catch(() => fetch(req))
  );
});
