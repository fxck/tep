// In-memory GTFS lookups for realtime enrichment.
//
// The Golemio feed only gives a trip_id; the route polyline needed for
// track-snapping is keyed by shape_id. We load trip_id -> shape_id (and
// route_id -> official colour) from PostgreSQL once on startup and refresh
// periodically (the GTFS cron reloads PG daily).

import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DB,
  max: 2,
});

let tripShape = new Map(); // trip_id -> shape_id
let routeColor = new Map(); // route_id -> '#rrggbb'
let stopName = new Map(); // stop_id -> name
let stopPos = new Map(); // stop_id -> [lon, lat] (precise platform position for next-stop snapping)
let loadedAt = 0;

export async function loadMaps() {
  try {
    const ts = new Map();
    const t = await pool.query("SELECT trip_id, shape_id FROM trips WHERE shape_id IS NOT NULL AND shape_id <> ''");
    for (const r of t.rows) ts.set(r.trip_id, r.shape_id);

    const rc = new Map();
    const r2 = await pool.query("SELECT route_id, color FROM routes WHERE color IS NOT NULL AND color <> ''");
    for (const r of r2.rows) rc.set(r.route_id, '#' + String(r.color).replace(/^#/, ''));

    const sn = new Map();
    const sp = new Map();
    const s = await pool.query("SELECT stop_id, name, lon, lat FROM stops WHERE name IS NOT NULL AND name <> ''");
    for (const r of s.rows) {
      sn.set(r.stop_id, r.name);
      if (r.lon != null && r.lat != null) sp.set(r.stop_id, [Number(r.lon), Number(r.lat)]);
    }

    tripShape = ts;
    routeColor = rc;
    stopName = sn;
    stopPos = sp;
    loadedAt = Date.now();
    console.log(`[gtfs] maps loaded: ${ts.size} trips->shape, ${rc.size} route colours, ${sn.size} stop names, ${sp.size} stop positions`);
  } catch (e) {
    console.error('[gtfs] map load failed:', e.message);
  }
}

export const getShapeId = (tripId) => tripShape.get(tripId) || null;
export const getRouteColor = (routeId) => routeColor.get(routeId) || null;
export const getStopName = (id) => stopName.get(id) || null;
export const getStopPos = (id) => stopPos.get(id) || null;
export const mapsReady = () => loadedAt > 0;
