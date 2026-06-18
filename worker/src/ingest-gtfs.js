// GTFS static ingestion.
//
// Downloads PID_GTFS.zip and bulk-loads the files we need into PostgreSQL via
// COPY (streaming, so the 146 MB shapes file never lives fully in memory):
//   routes  — route_id -> short_name / type / official colours
//   trips   — trip_id  -> shape_id / route_id   (the realtime feed only gives trip_id)
//   stops   — stop_id  -> name / lat / lon       (drawn on the map)
//   shapes  — shape_id -> ordered (lat, lon, dist) polyline  (route-snapping geometry)
//
// Run once after deploy and daily via cron (see zerops.yaml).

import unzipper from 'unzipper';
import { parse } from 'csv-parse';
import pg from 'pg';
import pgCopy from 'pg-copy-streams';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const { Pool } = pg;
const copyFrom = pgCopy.from;
const ZIP_URL = process.env.GTFS_URL || 'https://data.pid.cz/PID_GTFS.zip';

const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DB,
  max: 3,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS routes (route_id TEXT, short_name TEXT, route_type INT, color TEXT, text_color TEXT);
CREATE TABLE IF NOT EXISTS trips  (trip_id TEXT, route_id TEXT, shape_id TEXT, headsign TEXT);
CREATE TABLE IF NOT EXISTS stops  (stop_id TEXT, name TEXT, lat DOUBLE PRECISION, lon DOUBLE PRECISION);
CREATE TABLE IF NOT EXISTS shapes (shape_id TEXT, seq INT, lat DOUBLE PRECISION, lon DOUBLE PRECISION, dist DOUBLE PRECISION);
CREATE TABLE IF NOT EXISTS gtfs_meta (k TEXT PRIMARY KEY, v TEXT);
`;
const INDEXES = `
CREATE INDEX IF NOT EXISTS trips_trip_idx  ON trips (trip_id);
CREATE INDEX IF NOT EXISTS trips_shape_idx ON trips (shape_id);
CREATE INDEX IF NOT EXISTS routes_id_idx   ON routes (route_id);
CREATE INDEX IF NOT EXISTS stops_id_idx    ON stops (stop_id);
CREATE INDEX IF NOT EXISTS shapes_id_seq   ON shapes (shape_id, seq);
`;

const csvField = (v) => {
  if (v == null || v === '') return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvLine = (arr) => arr.map(csvField).join(',') + '\n';

async function loadTable(dir, entryName, table, cols, mapRow) {
  const entry = dir.files.find((f) => f.path === entryName);
  if (!entry) throw new Error(`GTFS entry not found: ${entryName}`);
  const client = await pool.connect();
  let n = 0;
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${table}`);
    const copyStream = client.query(copyFrom(`COPY ${table} (${cols.join(',')}) FROM STDIN WITH (FORMAT csv)`));
    const toCsv = new Transform({
      objectMode: true,
      transform(rec, _enc, cb) {
        const vals = mapRow(rec);
        if (!vals) return cb();
        n++;
        cb(null, csvLine(vals));
      },
    });
    await pipeline(
      entry.stream(),
      parse({ columns: true, skip_empty_lines: true, relax_quotes: true, relax_column_count: true }),
      toCsv,
      copyStream,
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return n;
}

async function main() {
  const t0 = Date.now();
  console.log('[gtfs] init schema');
  await pool.query(SCHEMA);
  await pool.query(INDEXES);

  console.log(`[gtfs] downloading ${ZIP_URL}`);
  const res = await fetch(ZIP_URL);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`[gtfs] zip ${(buf.length / 1e6).toFixed(1)} MB; opening`);
  const dir = await unzipper.Open.buffer(buf);

  const counts = {};
  counts.routes = await loadTable(dir, 'routes.txt', 'routes',
    ['route_id', 'short_name', 'route_type', 'color', 'text_color'],
    (r) => [r.route_id, r.route_short_name, r.route_type, r.route_color, r.route_text_color]);
  console.log(`[gtfs] routes: ${counts.routes}`);

  counts.stops = await loadTable(dir, 'stops.txt', 'stops',
    ['stop_id', 'name', 'lat', 'lon'],
    (r) => (r.stop_lat && r.stop_lon ? [r.stop_id, r.stop_name, r.stop_lat, r.stop_lon] : null));
  console.log(`[gtfs] stops: ${counts.stops}`);

  counts.trips = await loadTable(dir, 'trips.txt', 'trips',
    ['trip_id', 'route_id', 'shape_id', 'headsign'],
    (r) => [r.trip_id, r.route_id, r.shape_id, r.trip_headsign]);
  console.log(`[gtfs] trips: ${counts.trips}`);

  counts.shapes = await loadTable(dir, 'shapes.txt', 'shapes',
    ['shape_id', 'seq', 'lat', 'lon', 'dist'],
    (r) => [r.shape_id, r.shape_pt_sequence, r.shape_pt_lat, r.shape_pt_lon, r.shape_dist_traveled]);
  console.log(`[gtfs] shapes: ${counts.shapes}`);

  await pool.query(
    `INSERT INTO gtfs_meta (k, v) VALUES ('last_ingest', $1), ('counts', $2)
     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`,
    [new Date().toISOString(), JSON.stringify(counts)],
  );

  console.log(`[gtfs] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`, counts);
  await pool.end();
}

main().catch((e) => {
  console.error('[gtfs] FAILED:', e);
  process.exit(1);
});
