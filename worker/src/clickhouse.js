// ClickHouse history-streaming pipeline for the PID live-map worker.
//
// Banks EVERY genuinely-new vehicle GPS fix into ClickHouse for big-data
// analytics (delay heatmaps, per-line punctuality, headway/bunching, speed
// corridors, historical playback). This module owns ALL ClickHouse I/O so the
// realtime poll/publish loop in index.js shares nothing with it.
//
// THE REALTIME LOOP IS SACRED. recordFixes() is synchronous, never-awaited and
// never-throwing: it only runs in-memory dedup + an array push. All network I/O
// happens on a detached setInterval flush. CH being slow or down has zero effect
// on the map.
//
// Dedup is two-layer:
//   LAYER 1 (app-side, exact, single-writer): a Map<vehicle_id,lastTs>. The
//     worker is min=max=1, so this is a reliable cross-tick dedup key with no
//     split-writer hazard. Collapses the ~1050 rows/s naive firehose down to the
//     ~50 genuinely-new fixes/s.
//   LAYER 2 (engine safety net): ReplacingMergeTree(ingested_at) collapses any
//     (vehicle_id, ts) dup that slips through after a RESTART (Map empty) at the
//     next background merge. Read exactly-once via FINAL or argMax(col,ingested_at).

import { createClient } from '@clickhouse/client';

const TABLE = 'vehicle_fixes';

const DDL = `CREATE TABLE IF NOT EXISTS ${TABLE}
(
    \`vehicle_id\`  String                 CODEC(ZSTD(1)),
    \`ts\`          DateTime64(3, 'Europe/Prague') CODEC(DoubleDelta, ZSTD(1)),
    \`line\`        LowCardinality(String) CODEC(ZSTD(1)),
    \`mode\`        LowCardinality(String) CODEC(ZSTD(1)),
    \`lat\`         Float64                CODEC(Gorilla, ZSTD(1)),
    \`lon\`         Float64                CODEC(Gorilla, ZSTD(1)),
    \`bearing\`     Nullable(Int16)        CODEC(ZSTD(1)),
    \`speed\`       Nullable(Int16)        CODEC(ZSTD(1)),
    \`delay\`       Nullable(Int32)        CODEC(T64, ZSTD(1)),
    \`shape_id\`    LowCardinality(String) CODEC(ZSTD(1)),
    \`trip_id\`     String                 CODEC(ZSTD(1)),
    \`shape_dist\`  Nullable(Float32)      CODEC(Gorilla, ZSTD(1)),
    \`headsign\`    LowCardinality(String) CODEC(ZSTD(1)),
    \`color\`       LowCardinality(String) CODEC(ZSTD(1)),
    \`state\`        LowCardinality(String) CODEC(ZSTD(1)),
    \`reg\`          String                 CODEC(ZSTD(1)),
    \`model\`        LowCardinality(String) CODEC(ZSTD(1)),
    \`operator\`     LowCardinality(String) CODEC(ZSTD(1)),
    \`next_stop_id\` LowCardinality(String) CODEC(ZSTD(1)),
    \`next_stop_eta\` Nullable(Int32)       CODEC(T64, ZSTD(1)),
    \`canceled\`     UInt8 DEFAULT 0        CODEC(ZSTD(1)),
    \`ingested_at\` DateTime64(3, 'Europe/Prague') DEFAULT now64(3) CODEC(DoubleDelta, ZSTD(1)),

    INDEX idx_line line TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX idx_mode mode TYPE set(16) GRANULARITY 4,
    INDEX idx_lat  lat  TYPE minmax GRANULARITY 4,
    INDEX idx_lon  lon  TYPE minmax GRANULARITY 4
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMMDD(ts)
ORDER BY (vehicle_id, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1, min_bytes_for_wide_part = 0`;

// CRITICAL: the table already exists in prod, so CREATE TABLE IF NOT EXISTS will
// NOT add the columns above to it. These idempotent ALTER ... ADD COLUMN IF NOT
// EXISTS statements are what actually migrate an existing table (and are no-ops
// on a freshly-created one). Each is run after ensureTable()'s CREATE; failures
// are tolerated (counted as chErrors) so a partial migration never disables the
// pipeline. Type defs mirror the DDL exactly. `state` is the new column name;
// the existing `st` field on vehicles maps into it.
const COLUMN_MIGRATIONS = [
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS \`state\` LowCardinality(String) CODEC(ZSTD(1))`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS \`reg\` String CODEC(ZSTD(1))`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS \`model\` LowCardinality(String) CODEC(ZSTD(1))`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS \`operator\` LowCardinality(String) CODEC(ZSTD(1))`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS \`next_stop_id\` LowCardinality(String) CODEC(ZSTD(1))`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS \`next_stop_eta\` Nullable(Int32) CODEC(T64, ZSTD(1))`,
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS \`canceled\` UInt8 DEFAULT 0 CODEC(ZSTD(1))`,
  // trip_id: the Golemio per-trip instance id. HIGH cardinality (~50k distinct/day)
  // so plain String, NOT LowCardinality. Banked to cleanly segment a vehicle's
  // chainage history into individual trips — the grouping key for the per-(vehicle,
  // trip) sd-vs-ts curve that splits sensor noise R from process noise Q, and the
  // key the learned speed-corridor rollup aggregates within. Starts the data clock.
  `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS \`trip_id\` String CODEC(ZSTD(1))`,
];

// ---- tunables --------------------------------------------------------------

const BATCH_MAX_ROWS = 20000;   // early-flush threshold
const BATCH_MAX_MS = 5000;      // steady flush cadence
const BUFFER_CAP = 200000;      // hard memory ceiling — drop OLDEST on overflow
const PRUNE_INTERVAL_MS = 10 * 60 * 1000; // prune stale lastTs entries every 10m
const PRUNE_STALE_MS = 2 * 3600 * 1000;   // forget a vehicle unseen for >2h
const TS_SKEW_FUTURE_MS = 5 * 60 * 1000;  // reject ts > now + 5min
const TS_SKEW_PAST_MS = 24 * 3600 * 1000; // reject ts < now - 24h

// ---- module state ----------------------------------------------------------

let client = null;
let enabled = false;
let flushTimer = null;
let pruneTimer = null;
let flushing = false;
let stopped = false;

const lastTs = new Map(); // vehicle_id -> last persisted ts (epoch ms)
const lastSeen = new Map(); // vehicle_id -> wall-clock ms we last saw it (for pruning)
let buffer = []; // rows pending insert, in CH column order

const stats = { chErrors: 0, chDropped: 0, chSkewSkipped: 0, chInserted: 0, chFlushes: 0, lastChError: null };

// ---- lifecycle -------------------------------------------------------------

// initClickhouse(): build the singleton client, run the idempotent DDL once,
// start the flush + prune timers. No-op (graceful) when CH_HOST is unset so
// demo/dev without analytics runs untouched.
export async function initClickhouse() {
  if (client) return enabled; // already armed
  const host = process.env.CH_HOST;
  if (!host) {
    console.log('[clickhouse] CH_HOST unset — history pipeline disabled');
    return false;
  }
  const port = process.env.CH_PORT || '8123';
  client = createClient({
    url: `http://${host}:${port}`,
    username: process.env.CH_USER || 'default',
    password: process.env.CH_PASSWORD || '',
    database: process.env.CH_DB || 'default',
    request_timeout: 10000,
    max_open_connections: 2,
    keep_alive: { enabled: true },
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 0,
      async_insert_busy_timeout_ms: 1000,
      async_insert_max_data_size: '10000000',
    },
  });
  stopped = false;

  // Arm the timers up front. flush()/recordFixes() are gated on `enabled`, which
  // only flips true once the table exists — so nothing buffers or inserts until
  // then, but the pipeline is ready the instant ensureTable() succeeds.
  flushTimer = setInterval(() => { flush(); }, BATCH_MAX_MS);
  flushTimer.unref?.();
  pruneTimer = setInterval(pruneStale, PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();

  ensureTable(); // detached, self-retrying — a CH blip at boot never permanently disables ingestion
  return true;
}

// ensureTable(): run the idempotent DDL; on failure (e.g. CH briefly unreachable
// during a coordinated redeploy) retry on a detached, unref'd timer until it
// succeeds, instead of permanently disabling the pipeline for the process life.
async function ensureTable() {
  if (stopped || !client) return;
  try {
    await client.command({ query: DDL });
    // Migrate an existing table: add any missing columns. Each ALTER is isolated
    // so one failure (e.g. a transient CH hiccup mid-migration) doesn't abort the
    // rest or disable the pipeline — we just count it and press on. Banking the
    // new fields simply no-ops for columns that didn't land until a later boot.
    for (const q of COLUMN_MIGRATIONS) {
      try {
        await client.command({ query: q });
      } catch (me) {
        stats.chErrors++;
        stats.lastChError = String((me && me.message) || me);
        console.error('[clickhouse] column migration failed (tolerated):', stats.lastChError);
      }
    }
    enabled = true;
    console.log(`[clickhouse] connected ${process.env.CH_HOST}:${process.env.CH_PORT || '8123'} db=${process.env.CH_DB || 'default'} — table ${TABLE} ready`);
  } catch (e) {
    stats.chErrors++;
    stats.lastChError = String((e && e.message) || e);
    console.error('[clickhouse] table init failed — retrying in 30s:', stats.lastChError);
    const t = setTimeout(ensureTable, 30000);
    t.unref?.();
  }
}

// recordFixes(vehicles): SYNCHRONOUS, never-throwing, never-awaited. Runs the
// Layer-1 dedup (ts-null/skew guard + lastTs Map), pushes only genuinely-new
// rows onto the buffer, returns immediately. Entire body is try/caught so a bug
// here can never propagate into tick().
export function recordFixes(vehicles) {
  if (!enabled || stopped || !Array.isArray(vehicles)) return;
  try {
    const now = Date.now();
    const minTs = now - TS_SKEW_PAST_MS;
    const maxTs = now + TS_SKEW_FUTURE_MS;
    for (const v of vehicles) {
      if (!v) continue;
      const ts = v.ts;
      // skip rows with no real GPS fix time, or absurdly skewed clocks
      if (ts == null || !Number.isFinite(ts) || ts < minTs || ts > maxTs) { stats.chSkewSkipped++; continue; }
      const id = v.id;
      if (id == null) continue;
      lastSeen.set(id, now);
      const prev = lastTs.get(id) ?? -Infinity;
      if (ts <= prev) continue; // not a newer fix — dedup
      lastTs.set(id, ts);
      buffer.push(toRow(v));
    }
    if (buffer.length > BUFFER_CAP) {
      const overflow = buffer.length - BUFFER_CAP;
      buffer.splice(0, overflow); // drop OLDEST
      stats.chDropped += overflow;
      stats.lastChError = `buffer overflow: dropped ${overflow} oldest rows`;
    }
    if (buffer.length >= BATCH_MAX_ROWS) flush(); // early flush
  } catch (e) {
    // Never propagate into the realtime loop.
    stats.chErrors++;
    stats.lastChError = String((e && e.message) || e);
  }
}

// Map a normalized vehicle record to a JSONEachRow object in CH column order.
// ts is epoch MILLISECONDS. For a numeric DateTime64(3) value ClickHouse treats
// the number as the tick count in the column's precision unit (10^-3 s = ms),
// so we send raw epoch ms — sending epoch seconds stored the wrong instant (~1970).
function toRow(v) {
  return {
    vehicle_id: String(v.id),
    ts: v.ts,
    line: v.line == null ? '' : String(v.line),
    mode: v.mode == null ? '' : String(v.mode),
    lat: v.lat,
    lon: v.lon,
    bearing: v.brg == null ? null : v.brg,
    speed: v.spd == null ? null : v.spd,
    delay: v.dl == null ? null : v.dl,
    shape_id: v.shp == null ? '' : String(v.shp),
    trip_id: v.tid == null ? '' : String(v.tid),
    shape_dist: v.sd == null ? null : v.sd,
    headsign: v.hdsg == null ? '' : String(v.hdsg),
    color: v.color == null ? '' : String(v.color),
    // Phase-4 enrichment columns. nsid is the RAW next-stop id (normalize() keeps
    // it alongside ns); next_stop_eta is seconds-from-fix (nullable). canceled is
    // a UInt8 flag. ts stays epoch ms above (DateTime64(3) numeric == ms).
    state: v.st == null ? '' : String(v.st),
    reg: v.reg == null ? '' : String(v.reg),
    model: v.model == null ? '' : String(v.model),
    operator: v.op == null ? '' : String(v.op),
    next_stop_id: v.nsid == null ? '' : String(v.nsid),
    next_stop_eta: v.ns?.eta == null ? null : v.ns.eta,
    canceled: v.canc ? 1 : 0,
  };
}

// flush(): detached, fire-and-forget. Single in-flight guard. Splices the whole
// buffer and inserts. A CH error is caught + counted; the failed batch is
// DROPPED (analytics tolerates gaps — the map is the product), never retried
// into an unbounded backlog.
function flush() {
  if (!enabled || flushing || buffer.length === 0) return;
  flushing = true;
  const rows = buffer;
  buffer = [];
  const n = rows.length;
  client
    .insert({ table: TABLE, values: rows, format: 'JSONEachRow' })
    .then(() => {
      stats.chInserted += n;
      stats.chFlushes++;
    })
    .catch((e) => {
      stats.chErrors++;
      stats.chDropped += n; // batch lost
      stats.lastChError = String((e && e.message) || e);
      console.error('[clickhouse] insert failed (batch dropped):', stats.lastChError);
    })
    .finally(() => {
      flushing = false;
    });
}

function pruneStale() {
  try {
    const cutoff = Date.now() - PRUNE_STALE_MS;
    for (const [id, seen] of lastSeen) {
      if (seen < cutoff) {
        lastSeen.delete(id);
        lastTs.delete(id);
      }
    }
  } catch {
    // best-effort memory hygiene; never throw
  }
}

// stopClickhouse(): on SIGTERM/SIGINT, stop timers and do ONE final durable
// insert (wait_for_async_insert:1, ~8s budget) so the last batch lands on
// redeploy/scale, then close. Guarded against double-flush + hangs.
export async function stopClickhouse() {
  if (!enabled || stopped) return;
  stopped = true;
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  const rows = buffer;
  buffer = [];
  try {
    if (rows.length && client) {
      await Promise.race([
        client.insert({
          table: TABLE,
          values: rows,
          format: 'JSONEachRow',
          clickhouse_settings: { wait_for_async_insert: 1 },
        }),
        new Promise((resolve) => setTimeout(resolve, 8000)),
      ]);
      stats.chInserted += rows.length;
    }
  } catch (e) {
    stats.chErrors++;
    stats.lastChError = String((e && e.message) || e);
    console.error('[clickhouse] final flush failed:', stats.lastChError);
  } finally {
    try { await client?.close(); } catch { /* ignore */ }
    enabled = false;
  }
}

// Snapshot for /health.
export function chStats() {
  return {
    chEnabled: enabled,
    bufferLen: buffer.length,
    trackedVehicles: lastTs.size,
    chInserted: stats.chInserted,
    chFlushes: stats.chFlushes,
    chErrors: stats.chErrors,
    chDropped: stats.chDropped,
    chSkewSkipped: stats.chSkewSkipped,
    lastChError: stats.lastChError,
  };
}
