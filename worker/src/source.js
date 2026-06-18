// Data layer for the PID live-map worker.
//
// Primary source: Golemio realtime vehicle positions (GeoJSON).
//   GET https://api.golemio.cz/v2/vehiclepositions  (header: X-Access-Token)
// Fallback: a deterministic synthetic "demo" fleet around Prague, used when no
// GOLEMIO_API_KEY is configured — keeps the whole pipeline verifiable and the
// map alive before a key is wired, and auto-switches to live data once it is.
//
// Everything funnels through fetchVehicles() -> normalized compact records, so
// swapping in the GTFS-Realtime protobuf feed later is a localized change.

import { getShapeId, getRouteColor, getStopName, getStopPos } from './gtfs.js';
import { getModel } from './fleet.js';

const GOLEMIO_URL = process.env.GOLEMIO_URL || 'https://api.golemio.cz/v2/vehiclepositions';
const API_KEY = (process.env.GOLEMIO_API_KEY || '').trim();
export const SOURCE_MODE = API_KEY ? 'golemio' : 'demo';

// GTFS route_type -> our mode label + a sensible default colour (used when the
// feed doesn't carry a route_color).
const ROUTE_TYPE = {
  0: { mode: 'tram', color: '#D2192C' },
  1: { mode: 'metro', color: '#00A562' },
  2: { mode: 'train', color: '#1A66B0' },
  3: { mode: 'bus', color: '#2D7DD2' },
  4: { mode: 'ferry', color: '#0EA5C4' },
  5: { mode: 'cablecar', color: '#9B59B6' },
  6: { mode: 'gondola', color: '#9B59B6' },
  7: { mode: 'funicular', color: '#E67E22' },
  11: { mode: 'trolleybus', color: '#8E44AD' },
};

const firstNum = (arr) => { for (const x of arr) if (typeof x === 'number' && isFinite(x)) return x; return null; };
const firstStr = (arr) => { for (const x of arr) if (x != null && x !== '') return String(x); return null; };
// Pass an explicit true/false through (first non-null candidate); null when all absent.
const passBool = (arr) => { for (const x of arr) if (x === true || x === false) return x; return null; };
const round = (n, d) => { const f = 10 ** d; return Math.round(n * f) / f; };

export async function fetchVehicles() {
  return SOURCE_MODE === 'golemio' ? fetchGolemio() : demoVehicles();
}

// ---- Golemio (live) --------------------------------------------------------

let sampleLogged = false;

async function fetchGolemio() {
  // A single large page returns every tracked vehicle (~2k); the offset loop is
  // a safety net that breaks as soon as a page comes back short.
  const limit = 10000;
  const out = [];
  for (let page = 0, offset = 0; page < 10; page++, offset += limit) {
    const url = `${GOLEMIO_URL}?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { 'X-Access-Token': API_KEY, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Golemio HTTP ${res.status} ${body.slice(0, 160)}`);
    }
    const json = await res.json();
    const features = json.features || json.data?.features || [];
    if (!sampleLogged && features.length) {
      // One-time dump of the real shape so the normalizer can be confirmed/tuned from logs.
      console.log('[source] golemio sample feature:', JSON.stringify(features[0]).slice(0, 900));
      sampleLogged = true;
    }
    for (const f of features) {
      const v = normalize(f);
      if (v) out.push(v);
    }
    if (features.length < limit) break;
  }
  return out;
}

// Defensive normalizer — Golemio's GeoJSON nests fields differently across
// versions, so each value is pulled from a list of candidate paths.
function normalize(f) {
  if (!f) return null;
  const coords = f.geometry?.coordinates || [];
  const props = f.properties || {};
  const trip = props.trip || {};
  const gtfs = trip.gtfs || {};
  const last = props.last_position || props.lastPosition || {};

  const lon = firstNum([coords[0], last.lng, last.longitude, props.lng]);
  const lat = firstNum([coords[1], last.lat, last.latitude, props.lat]);
  if (lat == null || lon == null) return null;
  if (last.tracking === false) return null; // no live GPS fix — would render as a frozen dot

  const routeType = firstNum([gtfs.route_type, trip.route_type, props.route_type]);
  const meta = ROUTE_TYPE[routeType] ?? { mode: 'other', color: '#7A8290' };

  const line = firstStr([
    gtfs.route_short_name, trip.route_short_name, props.route_short_name,
    trip.origin_route_name, gtfs.route_id, props.route_id,
  ]) || '?';

  const routeId = firstStr([gtfs.route_id, trip.route_id, props.route_id]);
  const rawColor = firstStr([getRouteColor(routeId), gtfs.route_color, props.route_color]);
  const color = rawColor ? '#' + rawColor.replace(/^#/, '') : meta.color;

  const id = firstStr([
    props.vehicle_id, last.vehicle_id, trip.vehicle_id, gtfs.trip_id, trip.trip_id, props.id, f.id,
  ]) || `${line}@${lat.toFixed(4)},${lon.toFixed(4)}`;

  // Golemio's delay.actual is a trip-CUMULATIVE projection that periodically goes
  // wildly stale — we observed a line-B metro reporting actual=+2382 s (+40 m) while
  // its per-stop delta was −5 s (i.e. on time). The per-stop deltas reflect CURRENT
  // punctuality and stay sane, so prefer them and fall back to actual. Then clamp
  // implausible magnitudes (stale/garbage rows) to unknown so they don't paint
  // phantom "late" reds — Prague metro's true median delay is ~0 s.
  const dObj = (last.delay && typeof last.delay === 'object') ? last.delay : null;
  let delay = firstNum([
    dObj?.last_stop_departure, dObj?.last_stop_arrival, dObj?.actual,
    (typeof last.delay === 'number' ? last.delay : null),
    props.delay?.actual, props.delay,
  ]);
  // Metro delay is ESPECIALLY unreliable: line closures / headway operation make the
  // GTFS-schedule reference diverge, producing ±tens-of-minutes artifacts (observed a
  // whole line at once reporting "37 min early" AND "26 min late" — physically
  // impossible). A real metro is within a few minutes, so clamp it tight; other modes
  // get a looser sanity bound. Beyond the bound ⇒ unknown (neutral), never a fake red.
  const clampS = meta.mode === 'metro' ? 600 : 1800;
  if (delay != null && Math.abs(delay) > clampS) delay = null;
  const bearing = firstNum([last.bearing, props.bearing, last.heading]);
  const speed = firstNum([last.speed, props.speed]);
  const headsign = firstStr([gtfs.trip_headsign, trip.trip_headsign, props.trip_headsign]);
  const ts = Date.parse(last.origin_timestamp || '') || null; // real fix time — drives tween duration
  const tripId = firstStr([gtfs.trip_id, trip.trip_id]);
  const shp = tripId ? getShapeId(tripId) : null; // route polyline id for track-snapping
  const sdRaw = last.shape_dist_traveled;
  const sd = sdRaw != null && sdRaw !== '' && isFinite(Number(sdRaw)) ? Number(sdRaw) : null; // chainage along shape

  // Rich per-vehicle fields (defensive — many are null for some vehicles).
  const cis = trip.cis || {};
  const st = firstStr([last.state_position, props.state_position]); // 'on_track' | 'at_stop'
  const reg = firstStr([trip.vehicle_registration_number, props.vehicle_registration_number]); // fleet number
  const model = getModel(reg, meta.mode); // rolling-stock model from fleet-number band (null if unknown)
  const ac = passBool([trip.air_conditioned, props.air_conditioned]);
  const usb = passBool([trip.usb_chargers, props.usb_chargers]);
  const wheel = passBool([trip.wheelchair_accessible, props.wheelchair_accessible]);
  const op = firstStr([trip.agency_name?.scheduled, props.agency_name?.scheduled]); // operator, e.g. "DPP"
  const canc = last.is_canceled === true; // boolean — explicitly true only
  // Prefer the human trip short name (e.g. "Os 8652") else the CIS trip number.
  const tnum = firstStr([gtfs.trip_short_name, trip.trip_short_name]) ?? firstNum([cis.trip_number]);

  // Next stop — resolve its name from GTFS; eta is seconds-from-now (may be negative).
  // nsid keeps the RAW stop id (ns only carries the human name) so ClickHouse can
  // bank per-stop history for Phase-4 dwell/reliability analytics.
  const nextStop = last.next_stop || props.next_stop || null;
  let ns = null;
  let nsid = null;
  if (nextStop) {
    nsid = firstStr([nextStop.id]);
    const atRaw = firstStr([nextStop.arrival_time]);
    const atMs = atRaw ? Date.parse(atRaw) : NaN;
    const npos = nsid ? getStopPos(nsid) : null; // precise platform position → client snaps the stop chainage to it
    ns = {
      name: nsid ? getStopName(nsid) : null,
      eta: isFinite(atMs) ? Math.round((atMs - Date.now()) / 1000) : null,
      at: isFinite(atMs) ? atMs : null,   // absolute predicted arrival (ms) — anchors the client motion model
      seq: firstNum([nextStop.sequence]),
      lon: npos ? round(npos[0], 5) : null, // precise next-stop platform position (client motion model)
      lat: npos ? round(npos[1], 5) : null,
    };
  }

  return {
    id: String(id),
    lat: round(lat, 5),
    lon: round(lon, 5),
    brg: bearing == null ? null : Math.round(bearing),
    spd: speed == null ? null : Math.round(speed),
    line: String(line),
    mode: meta.mode,
    color,
    dl: delay == null ? null : Math.round(delay),
    hdsg: headsign || null,
    ts,
    shp,
    sd,
    st,
    reg,
    model,
    ac,
    usb,
    wheel,
    op,
    canc,
    tnum,
    ns,
    nsid,
  };
}

// ---- Demo (synthetic) ------------------------------------------------------

const PRAGUE = { lon: 14.4213, lat: 50.0875 };
const DEMO_COUNT = Number(process.env.DEMO_COUNT || 60);
const DEMO_LINES = [
  { line: '22', mode: 'tram', color: '#D2192C' },
  { line: '17', mode: 'tram', color: '#D2192C' },
  { line: '9', mode: 'tram', color: '#D2192C' },
  { line: '12', mode: 'tram', color: '#D2192C' },
  { line: 'A', mode: 'metro', color: '#00A562' },
  { line: 'B', mode: 'metro', color: '#F0B100' },
  { line: 'C', mode: 'metro', color: '#D2192C' },
  { line: '139', mode: 'bus', color: '#2D7DD2' },
  { line: '177', mode: 'bus', color: '#2D7DD2' },
  { line: '119', mode: 'bus', color: '#2D7DD2' },
  { line: '58', mode: 'trolleybus', color: '#8E44AD' },
];

const demoFleet = Array.from({ length: DEMO_COUNT }, (_, i) => {
  const def = DEMO_LINES[i % DEMO_LINES.length];
  const seedAng = (i / DEMO_COUNT) * Math.PI * 2;
  return {
    id: `demo-${def.mode}-${def.line}-${i}`,
    cx: PRAGUE.lon + Math.cos(seedAng) * (0.018 + (i % 6) * 0.012),
    cy: PRAGUE.lat + Math.sin(seedAng) * (0.011 + (i % 6) * 0.007),
    r: 0.004 + ((i * 37) % 22) / 2200,
    phase: ((i * 73) % 360) * Math.PI / 180,
    w: (0.05 + ((i * 53) % 30) / 320) * (i % 2 ? 1 : -1),
    def,
  };
});

function demoVehicles() {
  const nowMs = Date.now();
  const tsec = nowMs / 1000;
  return demoFleet.map((f) => {
    const a = f.phase + f.w * tsec;
    const lon = f.cx + Math.cos(a) * f.r;
    const lat = f.cy + Math.sin(a) * f.r * 0.62;
    const brg = (Math.atan2(Math.cos(a), -Math.sin(a)) * 180 / Math.PI + 360) % 360;
    return {
      id: f.id,
      lat: round(lat, 5),
      lon: round(lon, 5),
      brg: Math.round(brg),
      spd: 18 + Math.round(12 * Math.abs(Math.sin(a * 2))),
      line: f.def.line,
      mode: f.def.mode,
      color: f.def.color,
      dl: Math.max(0, Math.round(90 * Math.sin(a))),
      hdsg: 'Demo route',
      ts: nowMs,
    };
  });
}
