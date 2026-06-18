// chaseCam.js — cinematic "chase camera" for the PID Live MapLibre GL map.
//
// A chase cam smoothly TRACKS a followed vehicle: it sits a few metres behind
// the vehicle, looks the way the vehicle is heading, tilts to a cinematic pitch,
// and frames a look-ahead point so you can see where it's going. main.js drives
// it at ~60fps via chase(state) while a vehicle is followed, and reset()s when
// following stops.
//
// Pure MapLibre camera API — no three.js, no external deps. Every frame applies
// ONE map.jumpTo({center,bearing,pitch,zoom}). jumpTo (not easeTo) is correct
// here: the TARGET moves continuously each frame, so per-frame easing of the
// INTERNAL state already produces smooth motion; easeTo would queue overlapping
// transitions and jank. All smoothing lives in closure state we ease ourselves.

// ---- Tunables -------------------------------------------------------------
const BEHIND_M = 8;        // metres to pull the camera centre BEHIND the vehicle
                           // (along reverse-heading) so the vehicle sits a bit
                           // below screen-centre rather than dead-centre.
const PITCH = 55;          // target camera pitch (deg) — cinematic tilt.
const ZOOM_TARGET = 16.5;  // baseline framing zoom; the look-ahead fit only
                           // pulls BACK from here (never tighter), then we clamp.
const ZOOM_MIN = 15;       // never zoom out past this while chasing.
const ZOOM_MAX = 18;       // never zoom in past this while chasing.
const K_BEARING = 0.1;     // per-frame ease factor toward target bearing.
const K_PITCH = 0.1;       // per-frame ease factor toward target pitch.
const K_ZOOM = 0.06;       // per-frame ease factor toward framing zoom (gentle —
                           // zoom yanks read worse than pans, so ease it slower).
const LOOKAHEAD_M = 150;   // metres AHEAD (along hdg) we want kept comfortably
                           // in view; drives the framing-zoom computation.

// ---- Geo helpers ----------------------------------------------------------
const DEG = Math.PI / 180;
const M_PER_DEG = 111320; // metres per degree of latitude (and of longitude at
                          // the equator); scale lon by cos(lat).

// Shortest signed angular distance from `from` to `to`, in (-180, 180].
// Handles the 0/360 wrap so eased bearing never spins "the long way round".
function shortestAngleDelta(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

// Offset a {lon,lat} point by `d` metres along compass bearing `b`
// (0=N, 90=E, clockwise). Returns a new {lon,lat}.
function movePoint(lon, lat, b, d) {
  const dNorth = Math.cos(b * DEG) * d; // metres north
  const dEast = Math.sin(b * DEG) * d;  // metres east
  const cosLat = Math.cos(lat * DEG) || 1e-6; // guard the poles / lat=±90
  return {
    lon: lon + dEast / (M_PER_DEG * cosLat),
    lat: lat + dNorth / M_PER_DEG,
  };
}

const isFiniteNum = (n) => typeof n === 'number' && Number.isFinite(n);

// ---- Chase camera ---------------------------------------------------------
export function initChaseCam(map) {
  // Internal smoothed camera state, kept in closures. While !engaged these are
  // stale; the first chase() after init/reset seeds them from the LIVE camera
  // so we ease in from wherever the user already is (no snap), then engage.
  let engaged = false;
  let bearing = 0;
  let pitch = 0;
  let zoom = 0;
  // User zoom override: once the user wheel/pinch-zooms WHILE following, we stop
  // forcing the framing zoom and HOLD their chosen level instead — follow keeps
  // tracking position/bearing/pitch, but the zoom is theirs until follow is reset.
  let userZoom = null;

  function reset() {
    engaged = false;
    bearing = 0;
    pitch = 0;
    zoom = 0;
    userZoom = null;
  }

  // Adopt a user-chosen zoom mid-follow. We snap the internal `zoom` to it (so the
  // next per-frame jumpTo doesn't fight the wheel) and remember it as the target.
  function setZoom(z) {
    if (!isFiniteNum(z)) return;
    userZoom = z;
    zoom = z;
  }

  function chase(state) {
    if (!state) return;
    const { lon, lat, hdg } = state;
    // Ignore any frame with bad inputs rather than flinging the camera to NaN.
    if (!isFiniteNum(lon) || !isFiniteNum(lat) || !isFiniteNum(hdg)) return;

    // Seed smoothed state from the live camera on the first engaged frame, so
    // the chase eases in from the current view instead of snapping.
    if (!engaged) {
      bearing = map.getBearing();
      pitch = map.getPitch();
      zoom = map.getZoom();
      if (!isFiniteNum(bearing)) bearing = hdg;
      if (!isFiniteNum(pitch)) pitch = PITCH;
      if (!isFiniteNum(zoom)) zoom = ZOOM_TARGET;
      engaged = true;
    }

    // Bearing: ease toward hdg along the shortest arc (wrap-safe). Keep it
    // normalised to [0,360) so it doesn't drift unbounded over a long follow.
    bearing += shortestAngleDelta(bearing, hdg) * K_BEARING;
    bearing = ((bearing % 360) + 360) % 360;

    // Pitch: ease toward the cinematic tilt.
    pitch += (PITCH - pitch) * K_PITCH;

    // Framing zoom: we want both the vehicle AND a point LOOKAHEAD_M ahead
    // (along hdg) comfortably visible. The on-screen separation of two points
    // a fixed ground-distance apart HALVES for every +1 zoom level, so to fit a
    // longer look-ahead we must back OFF zoom by log2(lookahead / reference).
    // ZOOM_TARGET is calibrated to frame a ~150 m look-ahead nicely; a longer
    // one lowers the target, a shorter one would raise it. We only ever reduce
    // from ZOOM_TARGET (Math.min), then clamp to [ZOOM_MIN, ZOOM_MAX], so the
    // look-ahead is guaranteed in view without ever zooming in too far.
    let targetZoom;
    if (userZoom != null) {
      // User took over the zoom — hold their level (don't re-impose framing zoom).
      targetZoom = userZoom;
    } else {
      const lookaheadFit = ZOOM_TARGET - Math.log2(Math.max(LOOKAHEAD_M, 1) / 150);
      targetZoom = Math.min(ZOOM_TARGET, lookaheadFit);
      targetZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, targetZoom));
    }
    zoom += (targetZoom - zoom) * K_ZOOM;

    // Centre: pull BEHIND the vehicle along reverse-heading so it rides a touch
    // below screen-centre — reverse-heading = hdg + 180.
    const center = movePoint(lon, lat, hdg + 180, BEHIND_M);

    // One render per frame: continuously-moving target makes jumpTo read smooth.
    map.jumpTo({
      center: [center.lon, center.lat],
      bearing,
      pitch,
      zoom,
    });
  }

  return { chase, reset, setZoom };
}
