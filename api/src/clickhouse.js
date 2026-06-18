// PID live-map API — ClickHouse ANALYTICS reader (READ-only).
//
// Phase-2 analytics over the vehicle_fixes history the worker banks in
// ClickHouse. This module owns ALL ClickHouse I/O for the API and is strictly
// READ-only (client.query, never insert/command DDL). It is bolted onto the
// realtime API additively: the realtime endpoints (/health, /api/vehicles,
// /api/stream, /api/stops, /api/shapes, /api/meta) share NOTHING with it.
//
// THE REALTIME LOOP IS SACRED. Three independent graceful layers keep CH from
// ever breaking the map or a dev-without-analytics boot:
//   1) construct-time: the client is built LAZILY on first /api/analytics/* call
//      inside try/catch — never at module import. CH_HOST unset => chEnabled()
//      false, no client ever created.
//   2) per-request: handleAnalytics() wraps every endpoint so CH disabled OR any
//      thrown query error => HTTP 200 with the endpoint's empty shape +
//      {disabled:true}, sent no-store so recovery is immediate. NEVER 5xx.
//   3) micro-cache: N dashboard clients collapse to ~1 CH query per endpoint per
//      TTL per container; a transient CH blip may serve the last good value
//      briefly (stale-while-error) before falling back to the disabled payload.

import { createClient } from '@clickhouse/client';

const TABLE = 'vehicle_fixes';
const ON_TIME_BAND_SEC = 120;

// Prague bbox (matches META.bounds in index.js / main.js LEGEND world).
const BBOX = [[14.18, 49.94], [14.74, 50.18]];

// mode -> color fallback when the CH `color` column is '' (mirrors main.js
// LEGEND / META.legend in index.js). Kept local so this module is self-contained.
const LEGEND_COLOR = {
  tram: '#D2192C',
  metro: '#00A562',
  train: '#1A66B0',
  bus: '#007DA8',
  trolleybus: '#8E44AD',
  ferry: '#0EA5C4',
};

// Heatmap grid step whitelist — the ONLY way a step value reaches SQL (never raw
// user input). Same stance as the worst/best prepared-string ordering below.
const STEP_WHITELIST = new Set([0.002, 0.005, 0.01]);

// ---- module state ----------------------------------------------------------

let client = null;        // lazily constructed singleton
let constructTried = false; // so a failed construct isn't retried every request within the process
let constructFailed = false;

// Cheap in-memory reader counters for /metrics. NEVER involve a CH round-trip;
// incremented on the hot path of query()/handleAnalytics() only.
const readerStats = { queries: 0, queryErrors: 0, cacheHits: 0 };

// chStats(): in-memory-only snapshot for the Prometheus /metrics endpoint.
// No network I/O — safe to call on every scrape. Mirrors the worker's chStats()
// stance (counters + enabled flag) but for the READ side.
export function chStats() {
  return {
    enabled: chEnabled() && !constructFailed,
    constructed: !!client,
    cacheEntries: microCache.size,
    queries: readerStats.queries,
    queryErrors: readerStats.queryErrors,
    cacheHits: readerStats.cacheHits,
  };
}

// ---- lifecycle / construction ----------------------------------------------

export function chEnabled() {
  return !!process.env.CH_HOST;
}

// getClient(): LAZY singleton. Built on first analytics call, inside try/catch.
// A bad construction can never take down the realtime API on import. Returns
// null when CH_HOST unset or construction failed.
function getClient() {
  if (!chEnabled()) return null;
  if (client) return client;
  if (constructFailed) return null;
  constructTried = true;
  try {
    const host = process.env.CH_HOST;
    const port = process.env.CH_PORT || '8123';
    client = createClient({
      url: `http://${host}:${port}`,
      username: process.env.CH_USER || 'default',
      password: process.env.CH_PASSWORD || '',
      database: process.env.CH_DB || 'default',
      request_timeout: 10000,
      max_open_connections: 4,
      keep_alive: { enabled: true },
    });
    console.log(`[ch-reader] analytics client ready ${host}:${port} db=${process.env.CH_DB || 'default'}`);
    return client;
  } catch (e) {
    constructFailed = true;
    console.error('[ch-reader] client construction failed — analytics disabled:', String((e && e.message) || e));
    return null;
  }
}

// query(sql, params): the ONE read wrapper. JSONEachRow, returns row array.
// Throws on CH error — callers (each endpoint) translate a throw into the
// graceful disabled payload.
async function query(sql, query_params) {
  const c = getClient();
  if (!c) throw new Error('clickhouse disabled');
  readerStats.queries++;
  const rs = await c.query({ query: sql, query_params, format: 'JSONEachRow' });
  return rs.json();
}

// ---- numeric helpers --------------------------------------------------------

// CH `round(...)` can come back as a JS number, a numeric string (JSONEachRow
// serializes some aggregate types as strings), or null. Normalize to int|null.
function toInt(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}
// rate 0..1, 4 decimals, or null.
function toRate(v) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e4) / 1e4;
}
// plain count -> int (defaults to 0, never null — counts are over all fixes).
function toCount(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}
function colorFor(mode, chColor) {
  if (chColor && typeof chColor === 'string' && chColor !== '') return chColor;
  return LEGEND_COLOR[mode] || '#9aa7bd';
}
function clamp(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

// ---- in-process micro-cache -------------------------------------------------
// Keyed by normalized path+querystring, TTL == the endpoint's HTTP cache seconds.
// Collapses N dashboard clients to ~1 CH query per endpoint per TTL per container
// (the key scalability lever). Only successful (disabled:false) payloads are
// cached; disabled/error payloads are never cached so recovery is immediate.

const microCache = new Map(); // key -> { at:ms, ttlMs, payload }

function cacheGet(key) {
  const hit = microCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttlMs) { microCache.delete(key); return null; }
  return hit.payload;
}
function cacheSet(key, payload, ttlSeconds) {
  microCache.set(key, { at: Date.now(), ttlMs: ttlSeconds * 1000, payload });
  if (microCache.size > 256) { // bound the map (paths are few; this is paranoia)
    const oldestKey = microCache.keys().next().value;
    microCache.delete(oldestKey);
  }
}

// ---- response sender (mirrors index.js sendJson contract) -------------------
// index.js passes its own sendJson in via handleAnalytics; we keep the same
// (res,status,body,cacheSeconds) shape so cache-control stays consistent.

// ---- endpoint empty shapes (graceful contract) ------------------------------

function emptyOverview() {
  return {
    disabled: true,
    generatedAt: Date.now(),
    windowMin: 15,
    onTimeBandSec: ON_TIME_BAND_SEC,
    vehiclesNow: 0,
    activeLines: 0,
    activeModes: 0,
    avgDelaySec: null,
    medianDelaySec: null,
    onTimeRate: null,
    delaySamples: 0,
    fixesToday: 0,
    fixesTotal: 0,
    byMode: [],
  };
}
function emptyPunctuality(windowMin, order, minSamples) {
  return {
    disabled: true,
    generatedAt: Date.now(),
    windowMin,
    order,
    minSamples,
    onTimeBandSec: ON_TIME_BAND_SEC,
    lines: [],
  };
}
function emptyModes(windowMin) {
  return { disabled: true, generatedAt: Date.now(), windowMin, onTimeBandSec: ON_TIME_BAND_SEC, modes: [] };
}
function emptyTrend(hours, bucketMin) {
  return { disabled: true, generatedAt: Date.now(), hours, bucketMin, onTimeBandSec: ON_TIME_BAND_SEC, buckets: [] };
}
function emptyHeatmap(windowMin, step) {
  return { disabled: true, generatedAt: Date.now(), windowMin, step, bbox: BBOX, cells: [] };
}
function emptyBunching(windowMin, minSamples) {
  return { disabled: true, generatedAt: Date.now(), window: windowMin, minSamples, lines: [] };
}
function emptySpeed(windowMin, mode, step) {
  return { disabled: true, generatedAt: Date.now(), window: windowMin, mode: mode || null, step, bbox: BBOX, cells: [] };
}
function emptyStopReliability(windowMin, limit) {
  return { disabled: true, generatedAt: Date.now(), window: windowMin, limit, onTimeBandSec: ON_TIME_BAND_SEC, stops: [] };
}
function emptyReplay(from, to, line, mode, reason) {
  const out = { disabled: true, generatedAt: Date.now(), from, to, line: line || null, mode: mode || null, vehicles: [] };
  if (reason) out.reason = reason;
  return out;
}

// ============================================================================
// (1) OVERVIEW — 4 small parallel queries, assembled in Node.
// ============================================================================

async function overview() {
  const Q_VEHICLES_NOW = `
    SELECT count() AS vehiclesNow FROM (
      SELECT vehicle_id FROM ${TABLE}
      WHERE ts >= now() - INTERVAL 60 SECOND
      GROUP BY vehicle_id
    )`;

  const Q_DELAY_KPIS = `
    SELECT
      round(avg(delay))                              AS avgDelaySec,
      round(quantileTDigest(0.5)(delay))             AS medianDelaySec,
      round(countIf(abs(delay) <= 120) / count(), 4) AS onTimeRate,
      count()                                        AS delaySamples
    FROM ${TABLE}
    WHERE ts >= now() - INTERVAL 15 MINUTE AND delay IS NOT NULL`;

  const Q_ACTIVITY = `
    SELECT
      uniqExact(line) AS activeLines,
      uniqExact(mode) AS activeModes
    FROM ${TABLE}
    WHERE ts >= now() - INTERVAL 15 MINUTE`;

  const Q_VOLUME = `
    SELECT
      countIf(ts >= toStartOfDay(now(), 'Europe/Prague')) AS fixesToday,
      count()                                             AS fixesTotal
    FROM ${TABLE}`;

  const Q_BY_MODE = `
    SELECT
      mode,
      uniqExact(vehicle_id)                                   AS vehiclesNow,
      countIf(delay IS NOT NULL)                              AS samples,
      round(avgIf(delay, delay IS NOT NULL))                  AS avgDelaySec,
      round(quantileTDigestIf(0.5)(delay, delay IS NOT NULL)) AS medianDelaySec,
      round(countIf(delay IS NOT NULL AND abs(delay) <= 120)
            / nullIf(countIf(delay IS NOT NULL), 0), 4)       AS onTimeRate
    FROM ${TABLE}
    WHERE ts >= now() - INTERVAL 15 MINUTE AND mode != ''
    GROUP BY mode
    ORDER BY vehiclesNow DESC`;

  const [vn, kpi, act, vol, byModeRows] = await Promise.all([
    query(Q_VEHICLES_NOW),
    query(Q_DELAY_KPIS),
    query(Q_ACTIVITY),
    query(Q_VOLUME),
    query(Q_BY_MODE),
  ]);

  const k = kpi[0] || {};
  const a = act[0] || {};
  const v = vol[0] || {};

  return {
    disabled: false,
    generatedAt: Date.now(),
    windowMin: 15,
    onTimeBandSec: ON_TIME_BAND_SEC,
    vehiclesNow: toCount(vn[0] && vn[0].vehiclesNow),
    activeLines: toCount(a.activeLines),
    activeModes: toCount(a.activeModes),
    avgDelaySec: toInt(k.avgDelaySec),
    medianDelaySec: toInt(k.medianDelaySec),
    onTimeRate: toRate(k.onTimeRate),
    delaySamples: toCount(k.delaySamples),
    fixesToday: toCount(v.fixesToday),
    fixesTotal: toCount(v.fixesTotal),
    byMode: (byModeRows || []).map((r) => ({
      mode: r.mode,
      color: colorFor(r.mode, r.color),
      vehiclesNow: toCount(r.vehiclesNow),
      samples: toCount(r.samples),
      avgDelaySec: toInt(r.avgDelaySec),
      medianDelaySec: toInt(r.medianDelaySec),
      onTimeRate: toRate(r.onTimeRate),
    })),
  };
}

// ============================================================================
// (2) PUNCTUALITY — per line. Two PREPARED strings differ only by ORDER BY dir.
// ============================================================================

const PUNCT_SELECT = `
  SELECT
    line,
    argMax(mode,  ingested_at)                     AS modeAgg,
    argMax(color, ingested_at)                     AS color,
    count()                                        AS samples,
    uniqExact(vehicle_id)                          AS vehicles,
    round(avg(delay))                              AS avgDelaySec,
    round(quantileTDigest(0.5)(delay))             AS medianDelaySec,
    round(quantileTDigest(0.9)(delay))             AS p90DelaySec,
    round(countIf(abs(delay) <= 120) / count(), 4) AS onTimeRate
  FROM ${TABLE}
  WHERE ts >= now() - INTERVAL {windowMin:UInt16} MINUTE
    AND delay IS NOT NULL AND line != ''
    AND ({mode:String} = '' OR mode = {mode:String})
  GROUP BY line
  HAVING samples >= {minSamples:UInt32}`;

// order=worst -> most late first; order=best -> most on-time first. Prepared
// strings (no Identifier param) — the only string-built portion, JS-whitelisted.
const PUNCT_ORDER_WORST = ' ORDER BY onTimeRate ASC,  avgDelaySec DESC';
const PUNCT_ORDER_BEST = ' ORDER BY onTimeRate DESC, avgDelaySec ASC';

async function punctuality(sp) {
  const windowMin = clamp(sp.get('window'), 5, 1440, 30); // upper bound widened 180->1440 (24h) for longer history; default unchanged
  const order = sp.get('order') === 'best' ? 'best' : 'worst';
  const limit = clamp(sp.get('limit'), 1, 50, 12);
  const minSamples = clamp(sp.get('minSamples'), 0, 5000, 200);
  const mode = (sp.get('mode') || '').trim();

  const sql = PUNCT_SELECT
    + (order === 'best' ? PUNCT_ORDER_BEST : PUNCT_ORDER_WORST)
    + ' LIMIT {limit:UInt16}';

  const rows = await query(sql, { windowMin, minSamples, mode, limit });

  return {
    disabled: false,
    generatedAt: Date.now(),
    windowMin,
    order,
    minSamples,
    onTimeBandSec: ON_TIME_BAND_SEC,
    lines: (rows || []).map((r) => ({
      line: r.line,
      mode: r.modeAgg,
      color: colorFor(r.modeAgg, r.color),
      samples: toCount(r.samples),
      vehicles: toCount(r.vehicles),
      avgDelaySec: toInt(r.avgDelaySec),
      medianDelaySec: toInt(r.medianDelaySec),
      p90DelaySec: toInt(r.p90DelaySec),
      onTimeRate: toRate(r.onTimeRate),
    })),
  };
}

// ============================================================================
// (2b) PATTERNS — hour × day-of-week on-time%/avg-delay grid over a lookback
// (default 28 days). The temporal view: "WHEN does the network struggle?" plus a
// historical baseline to compare the live rate against. Cheap GROUP BY (≤168 rows).
// ============================================================================

function emptyPatterns(days) {
  return { disabled: true, generatedAt: Date.now(), days, onTimeBandSec: ON_TIME_BAND_SEC, cells: [] };
}

async function patterns(sp) {
  const days = clamp(sp.get('days'), 1, 90, 28);
  const mode = (sp.get('mode') || '').trim();
  const sql = `
    SELECT
      toDayOfWeek(ts)                                AS dow,
      toHour(ts)                                     AS hour,
      count()                                        AS samples,
      round(countIf(abs(delay) <= 120) / count(), 4) AS onTimeRate,
      round(avg(delay))                              AS avgDelaySec
    FROM ${TABLE}
    WHERE ts >= now() - INTERVAL {days:UInt16} DAY
      AND delay IS NOT NULL
      AND ({mode:String} = '' OR mode = {mode:String})
    GROUP BY dow, hour
    ORDER BY dow, hour`;
  const rows = await query(sql, { days, mode });
  return {
    disabled: false,
    generatedAt: Date.now(),
    days,
    onTimeBandSec: ON_TIME_BAND_SEC,
    cells: (rows || []).map((r) => ({
      dow: toInt(r.dow),            // 1=Mon … 7=Sun (ClickHouse toDayOfWeek)
      hour: toInt(r.hour),
      samples: toCount(r.samples),
      onTimeRate: toRate(r.onTimeRate),
      avgDelaySec: toInt(r.avgDelaySec),
    })),
  };
}

// ============================================================================
// (3) MODES — per mode over the window; vehiclesNow over the trailing 60s.
// ============================================================================

async function modes(sp) {
  const windowMin = clamp(sp.get('window'), 5, 1440, 15); // upper bound widened 120->1440 (24h) for longer history; default unchanged

  const sql = `
    SELECT
      mode,
      uniqExactIf(vehicle_id, ts >= now() - INTERVAL 60 SECOND)  AS vehiclesNow,
      countIf(delay IS NOT NULL)                                 AS samples,
      round(avgIf(delay, delay IS NOT NULL))                     AS avgDelaySec,
      round(quantileTDigestIf(0.5)(delay, delay IS NOT NULL))    AS medianDelaySec,
      round(quantileTDigestIf(0.9)(delay, delay IS NOT NULL))    AS p90DelaySec,
      round(countIf(delay IS NOT NULL AND abs(delay) <= 120)
            / nullIf(countIf(delay IS NOT NULL), 0), 4)          AS onTimeRate
    FROM ${TABLE}
    WHERE ts >= now() - INTERVAL {windowMin:UInt16} MINUTE AND mode != ''
    GROUP BY mode
    ORDER BY vehiclesNow DESC`;

  const rows = await query(sql, { windowMin });

  return {
    disabled: false,
    generatedAt: Date.now(),
    windowMin,
    onTimeBandSec: ON_TIME_BAND_SEC,
    modes: (rows || []).map((r) => ({
      mode: r.mode,
      color: colorFor(r.mode, r.color),
      vehiclesNow: toCount(r.vehiclesNow),
      samples: toCount(r.samples),
      avgDelaySec: toInt(r.avgDelaySec),
      medianDelaySec: toInt(r.medianDelaySec),
      p90DelaySec: toInt(r.p90DelaySec),
      onTimeRate: toRate(r.onTimeRate),
    })),
  };
}

// ============================================================================
// (4) TREND — system avg/p50/p90 delay over Prague-TZ-aligned buckets.
// ============================================================================

async function trend(sp) {
  const hours = clamp(sp.get('hours'), 1, 168, 6); // upper bound widened 24->168 (7d) for longer history; default unchanged
  const bucketMin = clamp(sp.get('bucketMin'), 5, 60, 30);

  const sql = `
    SELECT
      toUnixTimestamp(
        toStartOfInterval(ts, INTERVAL {bucketMin:UInt16} MINUTE, 'Europe/Prague')) * 1000 AS t,
      count()                                        AS samples,
      round(avg(delay))                              AS avgDelaySec,
      round(quantileTDigest(0.5)(delay))             AS p50,
      round(quantileTDigest(0.9)(delay))             AS p90,
      round(countIf(abs(delay) <= 120) / count(), 4) AS onTimeRate
    FROM ${TABLE}
    WHERE ts >= now() - INTERVAL {hours:UInt16} HOUR AND delay IS NOT NULL
    GROUP BY t
    ORDER BY t ASC`;

  const rows = await query(sql, { hours, bucketMin });

  return {
    disabled: false,
    generatedAt: Date.now(),
    hours,
    bucketMin,
    onTimeBandSec: ON_TIME_BAND_SEC,
    buckets: (rows || []).map((r) => ({
      t: toCount(r.t),
      samples: toCount(r.samples),
      avgDelaySec: toInt(r.avgDelaySec),
      p50: toInt(r.p50),
      p90: toInt(r.p90),
      onTimeRate: toRate(r.onTimeRate),
    })),
  };
}

// ============================================================================
// (5) HEATMAP [STRETCH] — gridded lat/lon avg delay over the Prague bbox.
// ============================================================================

async function heatmap(sp) {
  const windowMin = clamp(sp.get('window'), 5, 120, 30);
  let step = Number(sp.get('step'));
  if (!STEP_WHITELIST.has(step)) step = 0.005; // whitelist or default — never raw

  const sql = `
    SELECT
      round(lat / {step:Float64}) * {step:Float64}   AS gLat,
      round(lon / {step:Float64}) * {step:Float64}   AS gLon,
      count()                                        AS samples,
      round(avg(delay))                              AS avgDelaySec
    FROM ${TABLE}
    WHERE ts >= now() - INTERVAL {windowMin:UInt16} MINUTE
      AND delay IS NOT NULL
      AND lat BETWEEN 49.94 AND 50.18 AND lon BETWEEN 14.18 AND 14.74
    GROUP BY gLat, gLon
    HAVING samples >= 20
    ORDER BY samples DESC
    LIMIT 4000`;

  const rows = await query(sql, { windowMin, step });

  return {
    disabled: false,
    generatedAt: Date.now(),
    windowMin,
    step,
    bbox: BBOX,
    cells: (rows || []).map((r) => ({
      lat: Number(r.gLat),
      lon: Number(r.gLon),
      samples: toCount(r.samples),
      avgDelaySec: toInt(r.avgDelaySec),
    })),
  };
}

// ============================================================================
// (6) BUNCHING — same-line vehicle clustering detector.
// ============================================================================
//
// METHOD (defensible proxy, commented per brief): true headway needs scheduled
// spacing we don't bank, so we use DELAY DISPERSION as the bunching proxy. For
// the most-recent fix per (line, vehicle_id) inside the window (argMax on ts),
// we aggregate per line: vehicles active in the trailing 60s, and the stdDev of
// their delays. When several vehicles on a line run with near-identical delay
// AND there are >=2 of them, they are spatially clustered (bunched) rather than
// evenly spaced; we surface that as bunchingScore in [0..1]:
//   bunchingScore = vehicles>=2 ? clamp(1 - stddevPop(delay)/600, 0, 1) : 0
// i.e. low delay-spread on a multi-vehicle line => high bunching. 600s (10min)
// normalizes the spread; tune later against ground truth. delaySpread is also
// returned raw so the client can re-derive. NULL-delay fixes are excluded; lines
// with <minSamples delay points or <2 vehicles are dropped. Bounded by LIMIT.
async function bunching(sp) {
  const windowMin = clamp(sp.get('window'), 1, 120, 15);
  const minSamples = clamp(sp.get('minSamples'), 0, 5000, 3);

  // Inner: latest delay per (line, vehicle) in the window via argMax(_, ts) so a
  // vehicle counts once at its freshest delay (ReplacingMergeTree-safe read).
  // Outer: per-line dispersion + trailing-60s active vehicle count.
  const sql = `
    SELECT
      line,
      argMax(mode,  lastTs)                         AS modeAgg,
      argMax(color, lastTs)                         AS color,
      count()                                       AS vehicles,
      countIf(lastTs >= now() - INTERVAL 60 SECOND) AS vehiclesNow,
      count()                                       AS samples,
      round(avg(lastDelay))                         AS avgDelaySec,
      round(stddevPop(lastDelay), 2)                AS delaySpread
    FROM (
      SELECT
        line,
        vehicle_id,
        argMax(mode,  ts)   AS mode,
        argMax(color, ts)   AS color,
        argMax(delay, ts)   AS lastDelay,
        max(ts)             AS lastTs
      FROM ${TABLE}
      WHERE ts >= now() - INTERVAL {windowMin:UInt16} MINUTE
        AND delay IS NOT NULL AND line != ''
      GROUP BY line, vehicle_id
    )
    GROUP BY line
    HAVING vehicles >= 2 AND samples >= {minSamples:UInt32}
    ORDER BY vehicles DESC, delaySpread ASC
    LIMIT 100`;

  const rows = await query(sql, { windowMin, minSamples });

  return {
    disabled: false,
    generatedAt: Date.now(),
    window: windowMin,
    minSamples,
    method: 'delay-dispersion-proxy',
    lines: (rows || []).map((r) => {
      const spread = Number(r.delaySpread);
      const vehicles = toCount(r.vehicles);
      const score = vehicles >= 2 && Number.isFinite(spread)
        ? Math.round(Math.min(1, Math.max(0, 1 - spread / 600)) * 1e4) / 1e4
        : 0;
      return {
        line: r.line,
        mode: r.modeAgg,
        color: colorFor(r.modeAgg, r.color),
        vehicles,
        vehiclesNow: toCount(r.vehiclesNow),
        bunchingScore: score,
        delaySpread: Number.isFinite(spread) ? spread : null,
        avgDelaySec: toInt(r.avgDelaySec),
      };
    }),
  };
}

// ============================================================================
// (7) SPEED — gridded implied-speed corridor.
// ============================================================================
//
// METHOD (commented per brief): buses carry `speed` (km/h) but rail is NULL, so
// we prefer a DERIVED speed from successive fixes per vehicle and only fall back
// to the `speed` column. Using a window over (vehicle_id ORDER BY ts):
//   dt = ts - lag(ts)               (seconds, from DateTime64(3) diff)
//   dd = shape_dist - lag(shape_dist)  (KILOMETRES — the worker banks v.sd, which is
//                                       km, NOT metres; an earlier ×3.6 here assumed
//                                       m/s and made every derived speed 1000× too low)
// implied km/h = dd(km) / dt(s) * 3600, kept only when 0 < dt <= 120s and dd >= 0 (a new
// trip resets shape_dist to ~0 -> negative dd -> dropped) and the result is a
// sane 0..120 km/h. Where shape_dist is absent we coalesce to the reported
// `speed` column. Each usable sample is bucketed to a whitelisted lat/lon grid
// (same stance as heatmap) and averaged. Bounded by LIMIT. `mode` filter
// optional (prepared param, '' = all). Tolerates the speed column being NULL.
async function speed(sp) {
  const windowMin = clamp(sp.get('window'), 5, 120, 30);
  const mode = (sp.get('mode') || '').trim();
  let step = Number(sp.get('step'));
  if (!STEP_WHITELIST.has(step)) step = 0.005; // whitelist or default — never raw

  // CTE `fixes`: per-vehicle ordered fixes with previous ts/shape_dist via
  // lagInFrame. `samp`: derive implied km/h (or fall back to reported speed),
  // keep only sane samples, attach grid cell. Outer: average per cell.
  const sql = `
    WITH fixes AS (
      SELECT
        vehicle_id, ts, lat, lon, shape_dist, speed,
        lagInFrame(ts)
          OVER (PARTITION BY vehicle_id ORDER BY ts
                ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS prevTs,
        lagInFrame(shape_dist)
          OVER (PARTITION BY vehicle_id ORDER BY ts
                ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS prevDist
      FROM ${TABLE}
      WHERE ts >= now() - INTERVAL {windowMin:UInt16} MINUTE
        AND lat BETWEEN 49.94 AND 50.18 AND lon BETWEEN 14.18 AND 14.74
        AND ({mode:String} = '' OR mode = {mode:String})
    ),
    samp AS (
      SELECT
        lat, lon,
        multiIf(
          prevTs IS NOT NULL
            AND shape_dist IS NOT NULL AND prevDist IS NOT NULL
            AND (toUnixTimestamp64Milli(ts) - toUnixTimestamp64Milli(prevTs)) BETWEEN 1000 AND 120000
            AND (shape_dist - prevDist) >= 0,
          (shape_dist - prevDist)
            / ((toUnixTimestamp64Milli(ts) - toUnixTimestamp64Milli(prevTs)) / 1000) * 3600,
          speed IS NOT NULL, toFloat64(speed),
          NULL
        ) AS kmh
      FROM fixes
    )
    SELECT
      round(lat / {step:Float64}) * {step:Float64} AS gLat,
      round(lon / {step:Float64}) * {step:Float64} AS gLon,
      count()                                       AS samples,
      round(avg(kmh), 1)                            AS speedKmh
    FROM samp
    WHERE kmh IS NOT NULL AND kmh >= 0 AND kmh <= 120
    GROUP BY gLat, gLon
    HAVING samples >= 5
    ORDER BY samples DESC
    LIMIT 4000`;

  const rows = await query(sql, { windowMin, mode, step });

  return {
    disabled: false,
    generatedAt: Date.now(),
    window: windowMin,
    mode: mode || null,
    step,
    bbox: BBOX,
    cells: (rows || []).map((r) => ({
      lat: Number(r.gLat),
      lon: Number(r.gLon),
      speedKmh: r.speedKmh == null ? null : Math.round(Number(r.speedKmh) * 10) / 10,
      samples: toCount(r.samples),
    })),
  };
}

// ============================================================================
// (8) STOP-RELIABILITY — per next_stop punctuality (uses NEW columns).
// ============================================================================
//
// METHOD (commented per brief): groups delay fixes by the NEW `next_stop_id`
// column the sibling adds. Historical rows predate the column (NULL/'') and are
// excluded by the next_stop_id != '' guard, so this is GRACEFULLY NEAR-EMPTY
// until fresh history accrues — expected, not an error. If the column does not
// yet exist in the table at all, the query throws and the router returns the
// disabled empty shape (the standard graceful contract). Stop NAME resolution is
// intentionally NOT done here (no PG map in this module) — we return stopId and
// the web maps names via /api/stops. Bounded by LIMIT.
async function stopReliability(sp) {
  const windowMin = clamp(sp.get('window'), 5, 1440, 60);
  const limit = clamp(sp.get('limit'), 1, 200, 50);

  const sql = `
    SELECT
      next_stop_id                                   AS stopId,
      count()                                        AS samples,
      round(avg(delay))                              AS avgDelaySec,
      round(quantileTDigest(0.5)(delay))             AS medianDelaySec,
      round(countIf(abs(delay) <= ${ON_TIME_BAND_SEC}) / count(), 4) AS onTimeRate
    FROM ${TABLE}
    WHERE ts >= now() - INTERVAL {windowMin:UInt16} MINUTE
      AND delay IS NOT NULL
      AND next_stop_id IS NOT NULL AND next_stop_id != ''
    GROUP BY stopId
    HAVING samples >= 5
    ORDER BY samples DESC
    LIMIT {limit:UInt16}`;

  const rows = await query(sql, { windowMin, limit });

  return {
    disabled: false,
    generatedAt: Date.now(),
    window: windowMin,
    limit,
    onTimeBandSec: ON_TIME_BAND_SEC,
    stops: (rows || []).map((r) => ({
      stopId: r.stopId,
      samples: toCount(r.samples),
      avgDelaySec: toInt(r.avgDelaySec),
      medianDelaySec: toInt(r.medianDelaySec),
      onTimeRate: toRate(r.onTimeRate),
    })),
  };
}

// ============================================================================
// (9) REPLAY — Time-Machine fix source for client-side playback.
// ============================================================================
//
// Returns ordered per-vehicle fix tracks in a [from,to] window. REQUIRES a
// `line` OR `mode` to bound result size (else graceful {disabled,reason}). The
// window is CLAMPED to <= 2h (REPLAY_MAX_MS); from/to are validated unix-ms.
// CAPS (commented per brief): a per-vehicle ROW_NUMBER cap (REPLAY_FIXES_PER_VEH)
// keeps any single track bounded, an outer LIMIT (REPLAY_MAX_FIXES) caps total
// fixes, and we keep <= REPLAY_MAX_VEHICLES vehicles (selected by fix volume).
// The client interpolates between fixes on its own clock. from/to/line/mode are
// all parameterized (never interpolated). Fix tuple: [tMs,lat,lon,bearing,delay].
const REPLAY_MAX_MS = 2 * 3600 * 1000;   // 2h window cap
const REPLAY_MAX_VEHICLES = 400;          // <= 400 vehicles
const REPLAY_MAX_FIXES = 6000;            // <= 6000 total fixes
const REPLAY_FIXES_PER_VEH = 240;         // per-vehicle track cap (240 ~= 8min @2s, or thinned over 2h)

async function replay(sp) {
  const line = (sp.get('line') || '').trim();
  const mode = (sp.get('mode') || '').trim();

  // Require a bound. Without line OR mode the result is unbounded -> refuse.
  if (!line && !mode) {
    return emptyReplay(null, null, line, mode, 'line or mode required');
  }

  // Parse + sanity-check the window. Defaults: last 30min ending now.
  const now = Date.now();
  let to = Number(sp.get('to'));
  let from = Number(sp.get('from'));
  if (!Number.isFinite(to) || to <= 0) to = now;
  if (!Number.isFinite(from) || from <= 0) from = to - 30 * 60 * 1000;
  if (from > to) { const t = from; from = to; to = t; }
  // Clamp the window length to <= 2h (keep the END, slide the START forward).
  if (to - from > REPLAY_MAX_MS) from = to - REPLAY_MAX_MS;
  from = Math.round(from);
  to = Math.round(to);

  // Pick the most active vehicles first (by fix count) so a capped result still
  // shows the busy lines. Then pull their fixes, per-vehicle row-capped, and cap
  // the overall total. ts as epoch-ms via toUnixTimestamp64Milli (DateTime64(3)).
  const sql = `
    WITH picked AS (
      SELECT vehicle_id
      FROM ${TABLE}
      WHERE ts >= fromUnixTimestamp64Milli({from:Int64})
        AND ts <= fromUnixTimestamp64Milli({to:Int64})
        AND ({line:String} = '' OR line = {line:String})
        AND ({mode:String} = '' OR mode = {mode:String})
      GROUP BY vehicle_id
      ORDER BY count() DESC
      LIMIT {maxVehicles:UInt16}
    ),
    ranked AS (
      SELECT
        vehicle_id, ts, lat, lon, bearing, delay, line, mode, color,
        row_number() OVER (PARTITION BY vehicle_id ORDER BY ts ASC) AS rn
      FROM ${TABLE}
      WHERE ts >= fromUnixTimestamp64Milli({from:Int64})
        AND ts <= fromUnixTimestamp64Milli({to:Int64})
        AND ({line:String} = '' OR line = {line:String})
        AND ({mode:String} = '' OR mode = {mode:String})
        AND vehicle_id IN (SELECT vehicle_id FROM picked)
    )
    SELECT
      vehicle_id,
      argMax(line, ts)                       AS line,
      argMax(mode, ts)                       AS mode,
      argMax(color, ts)                      AS color,
      groupArray(toUnixTimestamp64Milli(ts)) AS tMs,
      groupArray(lat)                        AS lats,
      groupArray(lon)                        AS lons,
      groupArray(bearing)                    AS bearings,
      groupArray(delay)                      AS delays
    FROM (
      SELECT * FROM ranked WHERE rn <= {perVeh:UInt16} ORDER BY vehicle_id, ts ASC LIMIT {maxFixes:UInt32}
    )
    GROUP BY vehicle_id`;

  const rows = await query(sql, {
    from, to, line, mode,
    maxVehicles: REPLAY_MAX_VEHICLES,
    perVeh: REPLAY_FIXES_PER_VEH,
    maxFixes: REPLAY_MAX_FIXES,
  });

  // Zip the parallel groupArray columns into compact per-vehicle fix tuples
  // [tMs, lat, lon, bearing, delay]. Rows already share one vehicle each.
  const vehicles = (rows || []).map((r) => {
    const t = r.tMs || [];
    const la = r.lats || [];
    const lo = r.lons || [];
    const br = r.bearings || [];
    const dl = r.delays || [];
    const fixes = [];
    for (let i = 0; i < t.length; i++) {
      fixes.push([
        toCount(t[i]),
        la[i] == null ? null : Number(la[i]),
        lo[i] == null ? null : Number(lo[i]),
        br[i] == null ? null : toInt(br[i]),
        dl[i] == null ? null : toInt(dl[i]),
      ]);
    }
    return {
      id: r.vehicle_id,
      line: r.line,
      mode: r.mode,
      color: colorFor(r.mode, r.color),
      fixes,
    };
  });

  return {
    disabled: false,
    generatedAt: Date.now(),
    from,
    to,
    line: line || null,
    mode: mode || null,
    vehicles,
  };
}

// ============================================================================
// Router — index.js delegates every /api/analytics/* request here.
// ============================================================================
//
// sendJson is passed in from index.js (its (res,status,body,cacheSeconds) helper)
// so cache-control / CORS stay identical to the realtime endpoints.
//
// Each endpoint:
//   - micro-cache lookup (collapses concurrent clients per TTL per container)
//   - on success: HTTP 200, cacheSeconds = endpoint TTL, cached
//   - on disabled/throw: HTTP 200, no-store (cacheSeconds 0), NOT cached
//     (recovery immediate when CH returns)
// Unknown subpath -> 404 {error:'not found'}.

export async function handleAnalytics(path, searchParams, res, sendJson) {
  // Map subpath -> { runner, ttl, empty-shape factory } (empty used for graceful fallback).
  let spec;
  switch (path) {
    case '/api/analytics/overview':
      spec = { run: () => overview(), ttl: 30, empty: () => emptyOverview() };
      break;
    case '/api/analytics/punctuality': {
      const windowMin = clamp(searchParams.get('window'), 5, 1440, 30); // bound widened to 24h (matches punctuality())
      const order = searchParams.get('order') === 'best' ? 'best' : 'worst';
      const minSamples = clamp(searchParams.get('minSamples'), 0, 5000, 200);
      spec = { run: () => punctuality(searchParams), ttl: 60, empty: () => emptyPunctuality(windowMin, order, minSamples) };
      break;
    }
    case '/api/analytics/patterns': {
      const days = clamp(searchParams.get('days'), 1, 90, 28);
      spec = { run: () => patterns(searchParams), ttl: 300, empty: () => emptyPatterns(days) };
      break;
    }
    case '/api/analytics/modes': {
      const windowMin = clamp(searchParams.get('window'), 5, 1440, 15); // bound widened to 24h (matches modes())
      spec = { run: () => modes(searchParams), ttl: 60, empty: () => emptyModes(windowMin) };
      break;
    }
    case '/api/analytics/trend': {
      const hours = clamp(searchParams.get('hours'), 1, 168, 6); // bound widened to 7d (matches trend())
      const bucketMin = clamp(searchParams.get('bucketMin'), 5, 60, 30);
      spec = { run: () => trend(searchParams), ttl: 60, empty: () => emptyTrend(hours, bucketMin) };
      break;
    }
    case '/api/analytics/heatmap': {
      const windowMin = clamp(searchParams.get('window'), 5, 120, 30);
      let step = Number(searchParams.get('step'));
      if (!STEP_WHITELIST.has(step)) step = 0.005;
      spec = { run: () => heatmap(searchParams), ttl: 60, empty: () => emptyHeatmap(windowMin, step) };
      break;
    }
    case '/api/analytics/bunching': {
      const windowMin = clamp(searchParams.get('window'), 1, 120, 15);
      const minSamples = clamp(searchParams.get('minSamples'), 0, 5000, 3);
      spec = { run: () => bunching(searchParams), ttl: 20, empty: () => emptyBunching(windowMin, minSamples) };
      break;
    }
    case '/api/analytics/speed': {
      const windowMin = clamp(searchParams.get('window'), 5, 120, 30);
      const mode = (searchParams.get('mode') || '').trim();
      let step = Number(searchParams.get('step'));
      if (!STEP_WHITELIST.has(step)) step = 0.005;
      spec = { run: () => speed(searchParams), ttl: 60, empty: () => emptySpeed(windowMin, mode, step) };
      break;
    }
    case '/api/analytics/stop-reliability': {
      const windowMin = clamp(searchParams.get('window'), 5, 1440, 60);
      const limit = clamp(searchParams.get('limit'), 1, 200, 50);
      spec = { run: () => stopReliability(searchParams), ttl: 60, empty: () => emptyStopReliability(windowMin, limit) };
      break;
    }
    case '/api/analytics/replay': {
      // Bounds are computed inside replay() (window clamp + line/mode gate); the
      // empty shape just echoes the raw line/mode for the disabled fallback.
      const line = (searchParams.get('line') || '').trim();
      const mode = (searchParams.get('mode') || '').trim();
      spec = { run: () => replay(searchParams), ttl: 15, empty: () => emptyReplay(null, null, line, mode) };
      break;
    }
    default:
      return sendJson(res, 404, { error: 'not found' });
  }

  // Graceful: CH disabled -> empty shape, 200, no-store. Never the realtime 503 path.
  if (!chEnabled()) {
    return sendJson(res, 200, spec.empty(), 0);
  }

  // Micro-cache: normalized path + querystring. Only successful payloads cached.
  const qs = searchParams.toString();
  const cacheKey = qs ? `${path}?${qs}` : path;
  const cached = cacheGet(cacheKey);
  if (cached) { readerStats.cacheHits++; return sendJson(res, 200, cached, spec.ttl); }

  try {
    const payload = await spec.run();
    // Only cache successful payloads. A runner may itself return a graceful
    // {disabled:true} (e.g. replay without a line/mode bound) — never cache that,
    // and serve it no-store so a corrected request retries immediately.
    if (payload && payload.disabled) return sendJson(res, 200, payload, 0);
    cacheSet(cacheKey, payload, spec.ttl);
    return sendJson(res, 200, payload, spec.ttl);
  } catch (err) {
    readerStats.queryErrors++;
    console.error(`[ch-reader] ${path} query failed (graceful disabled):`, String((err && err.message) || err));
    // 200 + disabled empty shape, no-store so the next request retries CH.
    return sendJson(res, 200, spec.empty(), 0);
  }
}
