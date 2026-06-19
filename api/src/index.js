// PID live-map API.
//
// Realtime (Valkey): /health, /api/vehicles (snapshot), /api/stream (SSE), /api/meta
// Static GTFS (PostgreSQL): /api/shapes?ids=... (route polylines), /api/stops
//
// Stateless w.r.t. clients; every container subscribes to the same channel and
// serves the same cached GTFS geometry, so the api scales horizontally.

import http from 'node:http';
import Redis from 'ioredis';
import pg from 'pg';
import { handleAnalytics, chStats } from './clickhouse.js';
import { renderMetrics } from './metrics.js';
import { handleVehicleCard } from './vehicleCard.js';

const { Pool } = pg;
const PORT = Number(process.env.PORT || 3000);
const KEY_SNAPSHOT = 'pid:snapshot';
const CHANNEL = 'pid:feed';

const redisOpts = {
  host: process.env.CACHE_HOST,
  port: Number(process.env.CACHE_PORT || 6379),
  password: process.env.CACHE_PASSWORD || undefined,
  retryStrategy: (times) => Math.min(times * 200, 2000),
  maxRetriesPerRequest: null,
};
const reader = new Redis(redisOpts);
const sub = new Redis(redisOpts);

const pgPool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DB,
  max: 4,
});
pgPool.on('error', (e) => console.error('[api] pg pool error:', e.message));

let latest = '{"t":0,"src":"none","n":0,"v":[]}';
const clients = new Set();        // full-snapshot SSE clients (default path)
const deltaClients = new Set();   // opt-in delta SSE clients (?delta=1); each entry: { res, last:Map }

reader.on('error', (e) => console.error('[api] reader redis error:', e.message));
sub.on('error', (e) => console.error('[api] sub redis error:', e.message));
reader.get(KEY_SNAPSHOT).then((v) => { if (v) latest = v; }).catch(() => {});

// --- SSE delta wire format (opt-in via /api/stream?delta=1) ------------------
//
// DEFAULT clients (no delta=1) are untouched: they get a full
//   `event: snapshot\ndata: <the whole {t,src,n,v:[...]} JSON>\n\n`
// on connect and on every tick (the loop below is byte-for-byte unchanged).
//
// DELTA clients get a full `event: snapshot` ONCE on connect (so they have a
// base), then on each tick a `event: delta` carrying ONLY changes:
//   event: delta
//   data: { "t":<snapshotMs>, "src":"golemio", "n":<totalVehicles>,
//           "changed":[ <full vehicle objects that are new or changed> ],
//           "removed":[ "<id>", ... ] }
// A vehicle is in `changed` if it is new OR any field differs from what this
// client was last sent; `removed` lists ids present last tick but gone now. The
// client applies: upsert each changed by id, delete each removed id. `n` is the
// authoritative current vehicle count for reconciliation. Per-connection state
// (the last-sent map) lives in `deltaClients` and is freed on close, so memory
// is bounded by concurrent delta clients, not history. Heartbeat is unchanged.

// Stable, cheap per-vehicle change key: JSON of the vehicle object. The worker
// emits compact records (rounded coords, small field set), so this is small and
// a byte-difference reliably means a field changed. Keyed by id in the map.
function vehKey(v) {
  try { return JSON.stringify(v); } catch { return String(v && v.id); }
}

// Build the delta payload for one client against its last-sent map, and MUTATE
// that map to the new state. Returns { changed, removed } (arrays).
function diffForClient(last, vehicles) {
  const changed = [];
  const seen = new Set();
  for (const v of vehicles) {
    if (!v || v.id == null) continue;
    const id = String(v.id);
    seen.add(id);
    const k = vehKey(v);
    if (last.get(id) !== k) { changed.push(v); last.set(id, k); }
  }
  const removed = [];
  for (const id of last.keys()) {
    if (!seen.has(id)) { removed.push(id); }
  }
  for (const id of removed) last.delete(id);
  return { changed, removed };
}

sub.subscribe(CHANNEL).then(() => console.log(`[api] subscribed to ${CHANNEL}`)).catch((e) => console.error('[api] subscribe failed:', e.message));
sub.on('message', (_channel, message) => {
  latest = message;
  // --- DEFAULT full-snapshot fan-out (UNCHANGED) ---
  const frame = `event: snapshot\ndata: ${message}\n\n`;
  for (const res of clients) { try { res.write(frame); } catch {} }

  // --- DELTA fan-out (opt-in; isolated from the default path above) ---
  if (deltaClients.size) {
    let snap;
    try { snap = JSON.parse(message); } catch { snap = null; }
    const vehicles = snap && Array.isArray(snap.v) ? snap.v : [];
    for (const c of deltaClients) {
      try {
        const { changed, removed } = diffForClient(c.last, vehicles);
        // Skip writing an empty delta (nothing moved this tick) — heartbeat keeps
        // the connection alive; this saves the bytes the whole feature is about.
        if (!changed.length && !removed.length) continue;
        const payload = JSON.stringify({
          t: snap ? snap.t : Date.now(),
          src: snap ? snap.src : 'none',
          n: snap && typeof snap.n === 'number' ? snap.n : vehicles.length,
          changed,
          removed,
        });
        c.res.write(`event: delta\ndata: ${payload}\n\n`);
      } catch {}
    }
  }
});

const round = (n, d) => { if (n == null) return null; const f = 10 ** d; return Math.round(n * f) / f; };

// --- GTFS geometry cache (shapes are static; cache until restart) -----------
const shapeCache = new Map(); // shape_id -> [[lon,lat,dist],...]
let stopsCache = null;
let stopsAt = 0;

async function getShapes(ids) {
  const want = [...new Set(ids.filter(Boolean))].slice(0, 600);
  const missing = want.filter((id) => !shapeCache.has(id));
  if (missing.length) {
    const res = await pgPool.query(
      'SELECT shape_id, lon, lat, dist FROM shapes WHERE shape_id = ANY($1) ORDER BY shape_id, seq',
      [missing],
    );
    const grouped = new Map();
    for (const r of res.rows) {
      let arr = grouped.get(r.shape_id);
      if (!arr) { arr = []; grouped.set(r.shape_id, arr); }
      arr.push([round(r.lon, 5), round(r.lat, 5), round(r.dist, 3)]);
    }
    for (const id of missing) shapeCache.set(id, grouped.get(id) || []); // cache misses too
  }
  const out = {};
  for (const id of want) out[id] = shapeCache.get(id) || [];
  return out;
}

// GTFS feed epoch — the worker stamps gtfs_meta.last_ingest (ISO) on every static
// ingest. Surfaced via /api/meta so the browser's IndexedDB shape cache can bust
// itself when PID republishes. Cached 60s (it changes ~weekly).
let gtfsVer = null, gtfsVerAt = 0;
async function getGtfsVersion() {
  if (gtfsVer && Date.now() - gtfsVerAt < 60_000) return gtfsVer;
  try {
    const r = await pgPool.query("SELECT v FROM gtfs_meta WHERE k = 'last_ingest'");
    if (r.rows[0] && r.rows[0].v) gtfsVer = r.rows[0].v;
  } catch { /* table missing / db blip — keep last known */ }
  gtfsVerAt = Date.now();
  return gtfsVer;
}

async function getStops() {
  if (stopsCache && Date.now() - stopsAt < 3600_000) return stopsCache;
  // Only BOARDABLE stops. PID GTFS stop_id encodes the node type: `…Z<n>` = a
  // platform/zastávka (tram/bus/metro), `T…` = a train station. Everything else
  // — metro entrances/exits (`…S<n>E<n>`, named "E1".."E9"), pathway nodes
  // (`…N<n>`), depot tracks ("Kolej …"), elevators ("(Výtah)"), and null-named
  // records — is NOT a place you can catch a vehicle and has no departure board,
  // so it would render as a nameless clutter dot whose StopCard reads "Arrivals
  // unavailable". location_type/parent_station weren't imported, so we classify
  // by id shape. ~1.3k non-boardable rows dropped; trains kept.
  const res = await pgPool.query(
    "SELECT lon, lat, name FROM stops WHERE name IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL AND (stop_id LIKE '%Z%' OR stop_id LIKE 'T%')",
  );
  stopsCache = res.rows.map((r) => [round(r.lon, 5), round(r.lat, 5), r.name]);
  stopsAt = Date.now();
  return stopsCache;
}

const META = {
  legend: [
    { mode: 'tram', label: 'Tram', color: '#D2192C' },
    { mode: 'metro', label: 'Metro', color: '#00A562' },
    { mode: 'train', label: 'Train', color: '#1A66B0' },
    { mode: 'bus', label: 'Bus', color: '#007DA8' },
    { mode: 'trolleybus', label: 'Trolleybus', color: '#8E44AD' },
    { mode: 'ferry', label: 'Ferry', color: '#0EA5C4' },
  ],
  center: [14.4213, 50.0875],
  bounds: [[14.18, 49.94], [14.74, 50.18]],
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function sendJson(res, status, body, cacheSeconds) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  try {
    if (path === '/health' || path === '/') {
      const ready = reader.status === 'ready';
      let snap = {}; try { snap = JSON.parse(latest); } catch {}
      return sendJson(res, ready ? 200 : 503, {
        status: ready ? 'ok' : 'connecting',
        vehicles: snap.n ?? 0, source: snap.src ?? 'none', lastUpdate: snap.t ?? 0,
        ageMs: snap.t ? Date.now() - snap.t : null, clients: clients.size,
        deltaClients: deltaClients.size,
        shapesCached: shapeCache.size,
      });
    }
    if (path === '/api/meta') return sendJson(res, 200, { ...META, gtfsVersion: await getGtfsVersion() }, 60);
    if (path === '/api/vehicles') return sendJson(res, 200, latest);
    if (path === '/api/stops') return sendJson(res, 200, { stops: await getStops() }, 3600);
    // Live PID departure board for a station (StopCard). Server-side proxy to Golemio
    // /v2/pid/departureboards — the Golemio token stays here (never reaches the
    // browser); read from the worker's cross-service env so it isn't duplicated.
    if (path === '/api/departures') {
      const name = url.searchParams.get('name');
      if (!name) return sendJson(res, 400, { error: 'name required' });
      const KEY = process.env.GOLEMIO_API_KEY || process.env.workerdev_GOLEMIO_API_KEY || process.env.workerstage_GOLEMIO_API_KEY;
      if (!KEY) return sendJson(res, 200, { stop: name, departures: [], disabled: true });
      const limit = Math.min(20, Number(url.searchParams.get('limit')) || 12);
      const q = new URLSearchParams({ names: name, minutesAfter: '120', limit: String(limit), order: 'real' });
      const TYPE = { 0: 'tram', 1: 'metro', 2: 'train', 3: 'bus', 11: 'trolleybus' }; // GTFS route_type
      try {
        const r = await fetch(`https://api.golemio.cz/v2/pid/departureboards?${q}`, { headers: { 'X-Access-Token': KEY } });
        if (!r.ok) return sendJson(res, 200, { stop: name, departures: [], error: `golemio ${r.status}` }, 10);
        const d = await r.json();
        const departures = (Array.isArray(d.departures) ? d.departures : []).map((x) => ({
          line: (x.route && x.route.short_name) || '?',
          mode: (x.route && TYPE[x.route.type]) || 'other',
          headsign: (x.trip && x.trip.headsign) || null,
          predicted: (x.departure_timestamp && x.departure_timestamp.predicted) || null,
          minutes: (x.departure_timestamp && x.departure_timestamp.minutes) != null ? x.departure_timestamp.minutes : null,
          delaySec: x.delay && x.delay.is_available ? ((x.delay.minutes || 0) * 60 + (x.delay.seconds || 0)) : null,
          platform: (x.stop && x.stop.platform_code) || null,
          canceled: !!(x.trip && x.trip.is_canceled),
          wheel: !!(x.trip && x.trip.is_wheelchair_accessible),
          atStop: !!(x.trip && x.trip.is_at_stop),
        }));
        return sendJson(res, 200, { stop: name, departures }, 15);
      } catch (e) {
        return sendJson(res, 200, { stop: name, departures: [], error: 'fetch failed' }, 5);
      }
    }
    if (path === '/api/shapes') {
      const ids = (url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length) return sendJson(res, 400, { error: 'ids required' });
      return sendJson(res, 200, await getShapes(ids), 86400);
    }
    if (path === '/api/stream') {
      const wantsDelta = url.searchParams.get('delta') === '1';
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      // BOTH paths open with a full snapshot so the client has a complete base.
      res.write(`event: snapshot\ndata: ${latest}\n\n`);
      const hb = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch {} }, 15000);
      if (wantsDelta) {
        // Seed this client's last-sent map from the opening snapshot so the first
        // delta is computed against the base it already has (no duplicate full send).
        const last = new Map();
        try {
          const snap = JSON.parse(latest);
          if (snap && Array.isArray(snap.v)) for (const v of snap.v) { if (v && v.id != null) last.set(String(v.id), vehKey(v)); }
        } catch {}
        const entry = { res, last };
        deltaClients.add(entry);
        req.on('close', () => { clearInterval(hb); deltaClients.delete(entry); });
      } else {
        clients.add(res); // default full-snapshot path — UNCHANGED behavior
        req.on('close', () => { clearInterval(hb); clients.delete(res); });
      }
      return;
    }
    // Seznam-autobusu vehicle card: GET /api/vehicle-card/<reg>?op=<operator>.
    // Resolves (operator, evidence#) -> seznam page and scrapes model + photos,
    // cached hard in Valkey. Placed BEFORE /api/vehicle/ (distinct prefix; never
    // shadows it). Graceful: any failure -> { found:false }, never 5xx.
    if (path.startsWith('/api/vehicle-card/')) {
      const reg = decodeURIComponent(path.slice('/api/vehicle-card/'.length)).trim();
      const op = url.searchParams.get('op') || '';
      return handleVehicleCard(reg, op, reader, sendJson, res);
    }
    // Lazy per-vehicle detail: GET /api/vehicle/<id>. Merges the worker's static
    // attrs hash (HGET pid:vattr <id>, a JSON string) with the live fields from
    // the in-memory snapshot. Both sides are optional -> found reflects either.
    // Never 5xx: redis/parse errors degrade to nulls. no-store (live data).
    if (path.startsWith('/api/vehicle/')) {
      const id = decodeURIComponent(path.slice('/api/vehicle/'.length)).trim();
      if (!id) return sendJson(res, 400, { error: 'id required' });

      // (a) static attrs hash — tolerate the key/field not existing yet (the
      // worker may not be writing pid:vattr in this deploy -> HGET returns null).
      let attr = null;
      try {
        const raw = await reader.hget('pid:vattr', id);
        if (raw) { try { attr = JSON.parse(raw); } catch { attr = null; } }
      } catch (e) {
        console.error('[api] vattr hget error:', e.message);
      }

      // (b) live snapshot fields — find the vehicle in the in-memory snapshot.
      let live = null;
      try {
        const snap = JSON.parse(latest);
        const v = snap && Array.isArray(snap.v) ? snap.v.find((x) => x && String(x.id) === id) : null;
        if (v) {
          live = {
            lat: v.lat ?? null,
            lon: v.lon ?? null,
            spd: v.spd ?? null,
            dl: v.dl ?? null,
            hdsg: v.hdsg ?? null,
            st: v.st ?? null,
            ns: v.ns ?? null,
            // a few more cheap live fields the detail panel will want
            line: v.line ?? null,
            mode: v.mode ?? null,
            color: v.color ?? null,
            brg: v.brg ?? null,
            ts: v.ts ?? null,
          };
        }
      } catch {}

      return sendJson(res, 200, { id, found: !!(live || attr), live, attr });
    }
    // Prometheus metrics — in-memory only (snapshot age/count, SSE clients, shape
    // cache, CH reader counters). Placed BEFORE the 404; never touches the network.
    if (path === '/metrics') {
      let body;
      try {
        body = renderMetrics({ latest, clients, shapeCache, chStats: chStats() });
      } catch (e) {
        console.error('[api] metrics render error:', e.message);
        body = '# metrics unavailable\n';
      }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4', 'cache-control': 'no-store' });
      return res.end(body);
    }
    // --- analytics (ClickHouse, READ-only) — added AFTER the exact-match realtime
    // routes and BEFORE the 404 so it can never shadow an existing path. Each
    // endpoint is graceful: CH disabled / query error => HTTP 200 disabled payload
    // (never the realtime 503 path), so the realtime API is unaffected by CH state.
    if (path.startsWith('/api/analytics/')) return handleAnalytics(path, url.searchParams, res, sendJson);
    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[api] handler error:', err.message);
    return sendJson(res, 503, { error: 'unavailable' });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.listen(PORT, '0.0.0.0', () => console.log(`[api] listening on :${PORT}`));
