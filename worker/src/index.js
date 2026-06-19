// PID live-map worker — single-writer ingestion loop.
//
// Polls the configured source (Golemio live, or synthetic demo) on an interval,
// writes the normalized snapshot to Valkey under `pid:snapshot`, and PUBLISHes
// it on `pid:feed` so every api container can fan it out over SSE in real time.
// Exposes a tiny /health endpoint for zerops_verify + supervised healthCheck.

import http from 'node:http';
import crypto from 'node:crypto';
import Redis from 'ioredis';
import { fetchVehicles, SOURCE_MODE } from './source.js';
import { loadMaps } from './gtfs.js';
import { initClickhouse, recordFixes, stopClickhouse, chStats } from './clickhouse.js';

const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || (SOURCE_MODE === 'demo' ? 1000 : 2000));
const KEY_SNAPSHOT = 'pid:snapshot';
const CHANNEL = 'pid:feed';
const TTL_SEC = 120;

// ---- pid:vattr (lazy per-vehicle detail) -----------------------------------
// The API serves a lazy per-vehicle "details" panel from this HASH so the 2s
// firehose snapshot stays lean. Refreshed off the critical path on its own timer
// from the latest tick's vehicles; self-expires so it vanishes if the worker dies.
const KEY_VATTR = 'pid:vattr';
const VATTR_TTL_SEC = 300;
const VATTR_INTERVAL_MS = 30000;
let latestVehicles = null; // last tick's vehicles (reference only — set, never awaited)

// ---- advisory writer-lock (Phase-3 double-write defense) -------------------
// The worker is min=max=1 today, so this process is always the leader. The lock
// is insurance: if a FUTURE accidental scale ever spins up a second instance,
// only the lock holder banks ClickHouse — the realtime SET/PUBLISH below ALWAYS
// runs on every instance regardless, so the map can never go dark. Fails OPEN:
// any lock error leaves isLeader=true so banking continues (never fail closed
// and silently stop writing history).
const LOCK_KEY = 'pid:writer';
const LOCK_TOKEN = crypto.randomUUID();
const LOCK_PX_MS = 15000;     // lock lifetime — comfortably > renew interval
const LOCK_RENEW_MS = 5000;   // renew/acquire cadence
let isLeader = true;          // fail-open default; a single instance stays true

const redis = new Redis({
  host: process.env.CACHE_HOST,
  port: Number(process.env.CACHE_PORT || 6379),
  password: process.env.CACHE_PASSWORD || undefined,
  retryStrategy: (times) => Math.min(times * 200, 2000),
  maxRetriesPerRequest: 3,
});

const stats = { source: SOURCE_MODE, intervalMs: POLL_INTERVAL_MS, ticks: 0, count: 0, lastOk: 0, lastError: null };

async function tick() {
  try {
    const vehicles = await fetchVehicles();
    // `tid` (trip_id) is banked to ClickHouse by recordFixes() below but is NOT
    // needed by the browser — drop it from the published snapshot so the firehose
    // stays lean (the replacer skips the one key; recordFixes still reads v.tid).
    const payload = JSON.stringify({ t: Date.now(), src: SOURCE_MODE, n: vehicles.length, v: vehicles },
      (k, val) => (k === 'tid' ? undefined : val));
    await redis.set(KEY_SNAPSHOT, payload, 'EX', TTL_SEC);
    await redis.publish(CHANNEL, payload);
    // --- everything below is OFF the realtime critical path: the map is already
    // SET+PUBLISHed above and finishes first regardless of what follows. ---
    latestVehicles = vehicles; // ref store only (no await) — vattr timer reads this
    // History pipeline: fire-and-forget, synchronous, never-awaited. Gated on
    // isLeader so a future accidental 2nd instance won't double-write ClickHouse;
    // isLeader is always true for the single instance we run today (fail-open).
    if (SOURCE_MODE === 'golemio' && isLeader) recordFixes(vehicles);
    stats.lastOk = Date.now();
    stats.count = vehicles.length;
    stats.ticks++;
    stats.lastError = null;
    if (stats.ticks === 1 || stats.ticks % 20 === 0) {
      console.log(`[worker] tick #${stats.ticks} src=${SOURCE_MODE} vehicles=${vehicles.length}`);
    }
  } catch (err) {
    stats.lastError = String((err && err.message) || err);
    console.error('[worker] tick error:', stats.lastError);
  }
}

let running = false;
function loop() {
  if (running) return;
  running = true;
  tick().finally(() => {
    running = false;
    setTimeout(loop, POLL_INTERVAL_MS);
  });
}

// renewLock(): acquire-or-renew the advisory writer lock on its own timer, fully
// off the realtime path. Try SET NX (acquire); if taken, GET + compare token and
// renew with SET XX when it's ours. Sets isLeader as a side effect. Fails OPEN —
// any error leaves isLeader=true so banking never silently stops. For the single
// instance we run today this always resolves to true (we own LOCK_KEY).
async function renewLock() {
  try {
    // SET key token NX PX ttl -> 'OK' if we just acquired it (it was free).
    const acquired = await redis.set(LOCK_KEY, LOCK_TOKEN, 'PX', LOCK_PX_MS, 'NX');
    if (acquired === 'OK') {
      isLeader = true;
      return;
    }
    // Someone holds it — is it us? If so, renew (refresh TTL) with XX.
    const holder = await redis.get(LOCK_KEY);
    if (holder === LOCK_TOKEN) {
      await redis.set(LOCK_KEY, LOCK_TOKEN, 'PX', LOCK_PX_MS, 'XX');
      isLeader = true;
    } else {
      // A different live instance holds the lock — stand down from banking only.
      isLeader = false;
    }
  } catch (e) {
    // Fail OPEN: keep banking rather than silently dropping history on a lock blip.
    isLeader = true;
    console.error('[worker] writer-lock error (failing open, isLeader=true):', String((e && e.message) || e));
  }
}

// writeVattr(): build a compact per-vehicle attr map from the latest tick and
// write it in ONE pipeline (HSET each + EXPIRE), so the API can lazily fetch
// vehicle details without bloating the firehose. Off the critical path, fully
// guarded; the 300s EXPIRE self-cleans if the worker dies.
async function writeVattr() {
  try {
    const vehicles = latestVehicles;
    if (!Array.isArray(vehicles) || vehicles.length === 0) return;
    const pipe = redis.pipeline();
    let n = 0;
    for (const v of vehicles) {
      if (!v || v.id == null) continue;
      pipe.hset(KEY_VATTR, String(v.id), JSON.stringify({
        model: v.model ?? null,
        reg: v.reg ?? null,
        op: v.op ?? null,
        ac: v.ac ?? null,
        usb: v.usb ?? null,
        wheel: v.wheel ?? null,
        tnum: v.tnum ?? null,
        mode: v.mode ?? null,
        line: v.line ?? null,
      }));
      n++;
    }
    if (n === 0) return;
    pipe.expire(KEY_VATTR, VATTR_TTL_SEC); // self-cleans if the worker dies
    await pipe.exec();
  } catch (e) {
    // Never affects the realtime loop — best-effort detail cache.
    console.error('[worker] vattr write error:', String((e && e.message) || e));
  }
}

redis.on('ready', async () => {
  console.log(`[worker] cache connected — source=${SOURCE_MODE} interval=${POLL_INTERVAL_MS}ms`);
  if (SOURCE_MODE === 'golemio') {
    await loadMaps();
    setInterval(loadMaps, 3 * 3600 * 1000);
    // Start banking history into ClickHouse. No-ops gracefully if CH_HOST unset.
    await initClickhouse().catch((e) => console.error('[clickhouse] init failed:', e.message));
    // Advisory writer-lock: claim leadership now, then renew on a detached timer.
    // Both are off the realtime path; a single instance always wins.
    await renewLock();
    const lockTimer = setInterval(() => { renewLock(); }, LOCK_RENEW_MS);
    lockTimer.unref?.();
    // Lazy per-vehicle detail HASH, refreshed off the critical path.
    const vattrTimer = setInterval(() => { writeVattr(); }, VATTR_INTERVAL_MS);
    vattrTimer.unref?.();
  }
  loop();
});
redis.on('error', (e) => console.error('[worker] redis error:', e.message));

http
  .createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const ready = redis.status === 'ready';
      const age = stats.lastOk ? Date.now() - stats.lastOk : null;
      res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: ready ? 'ok' : 'connecting', ...stats, ageMs: age, isLeader, ...chStats() }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  })
  .listen(PORT, '0.0.0.0', () => console.log(`[worker] health server on :${PORT}`));

// Zerops sends SIGTERM on redeploy/scale — durably flush the last CH batch.
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopClickhouse().catch(() => {}).finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
