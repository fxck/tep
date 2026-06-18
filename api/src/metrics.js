// PID live-map API — Prometheus metrics exposition (READ-only, in-memory).
//
// renderMetrics() turns the api container's already-in-memory realtime state
// (the `latest` snapshot string, the SSE `clients` set, the GTFS `shapeCache`
// Map) into Prometheus text-exposition format. It touches NOTHING on the network
// and NEVER throws — index.js wires it in before the 404 and the realtime path
// is untouched. ClickHouse reader stats are optional and only included when a
// chStats() snapshot is cheaply available (no CH query is ever issued here).
//
// Wire contract (index.js): respond 200, Content-Type 'text/plain; version=0.0.4'
// (the Prometheus text format version), no-store.

// Escape a label value per the Prometheus exposition spec (\\, \", \n).
function esc(v) {
  return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// Emit one metric block: HELP + TYPE + one or more sample lines. `samples` is an
// array of { value, labels? }. Non-finite values are skipped (Prometheus rejects
// them) so a malformed snapshot can never produce a broken scrape.
function metric(out, name, type, help, samples) {
  out.push(`# HELP ${name} ${help}`);
  out.push(`# TYPE ${name} ${type}`);
  for (const s of samples) {
    const n = Number(s.value);
    if (!Number.isFinite(n)) continue;
    let labelStr = '';
    if (s.labels) {
      const parts = [];
      for (const [k, v] of Object.entries(s.labels)) parts.push(`${k}="${esc(v)}"`);
      if (parts.length) labelStr = `{${parts.join(',')}}`;
    }
    out.push(`${name}${labelStr} ${n}`);
  }
}

// renderMetrics({ latest, clients, shapeCache, chStats? }) -> string.
//   latest      : the api's in-memory snapshot JSON string ({t,src,n,v:[...]}).
//   clients     : the Set of active SSE response objects (clients.size).
//   shapeCache  : the Map of cached GTFS shapes (shapeCache.size).
//   chStats     : OPTIONAL plain object of ClickHouse reader counters (cheap,
//                 in-memory only). Omitted by index.js today; supported so it can
//                 be passed later without a signature change.
// Wholly defensive: any parse/shape problem degrades to zeros, never throws.
export function renderMetrics({ latest, clients, shapeCache, chStats } = {}) {
  let snap = {};
  try { snap = JSON.parse(latest || '{}') || {}; } catch { snap = {}; }

  const now = Date.now();
  const snapT = Number(snap.t) || 0;
  // Age of the freshest snapshot this container holds, in seconds. 0 before the
  // first snapshot arrives (snapT 0) so it never reads as a huge bogus age.
  const ageSeconds = snapT > 0 ? Math.max(0, (now - snapT) / 1000) : 0;

  const vehicleCount = Number(snap.n);
  const vehicles = Number.isFinite(vehicleCount)
    ? vehicleCount
    : (Array.isArray(snap.v) ? snap.v.length : 0);

  const sseClients = clients && typeof clients.size === 'number' ? clients.size : 0;
  const shapesCached = shapeCache && typeof shapeCache.size === 'number' ? shapeCache.size : 0;
  const src = typeof snap.src === 'string' && snap.src ? snap.src : 'none';

  const out = [];

  metric(out, 'pid_snapshot_age_seconds', 'gauge',
    'Age of the most recent realtime snapshot held by this api container, in seconds.',
    [{ value: ageSeconds }]);

  metric(out, 'pid_snapshot_timestamp_ms', 'gauge',
    'Epoch-ms timestamp of the most recent realtime snapshot (0 if none yet).',
    [{ value: snapT }]);

  metric(out, 'pid_vehicles', 'gauge',
    'Number of vehicles in the most recent realtime snapshot.',
    [{ value: vehicles, labels: { src } }]);

  metric(out, 'pid_sse_clients', 'gauge',
    'Number of currently connected SSE stream clients on this container.',
    [{ value: sseClients }]);

  metric(out, 'pid_shapes_cached', 'gauge',
    'Number of GTFS route shapes cached in memory on this container.',
    [{ value: shapesCached }]);

  // ClickHouse reader stats — optional, in-memory counters only (no CH query).
  // Emitted only when index.js passes a chStats snapshot; tolerant of partial
  // objects (missing keys are simply skipped by the non-finite guard).
  if (chStats && typeof chStats === 'object') {
    metric(out, 'pid_clickhouse_enabled', 'gauge',
      'Whether the ClickHouse analytics reader is enabled on this container (1/0).',
      [{ value: chStats.enabled ? 1 : 0 }]);
    metric(out, 'pid_clickhouse_cache_entries', 'gauge',
      'Number of analytics micro-cache entries currently held.',
      [{ value: chStats.cacheEntries }]);
    metric(out, 'pid_clickhouse_queries_total', 'counter',
      'Total ClickHouse analytics queries issued by this container.',
      [{ value: chStats.queries }]);
    metric(out, 'pid_clickhouse_query_errors_total', 'counter',
      'Total ClickHouse analytics queries that threw (served graceful disabled).',
      [{ value: chStats.queryErrors }]);
  }

  // Trailing newline — Prometheus text format expects the body to end in \n.
  return out.join('\n') + '\n';
}
