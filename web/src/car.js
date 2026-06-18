// car.js — a drivable arcade car layered over the live transit map.
//
// Pure controller: owns keyboard input + simple arcade physics and integrates a
// lon/lat/heading pose. It draws NOTHING — main.js feeds each frame's pose to
// vehicles3d.setCar() (rendered in the same 3D scene as the fleet) and to the
// chase camera. Heading is COMPASS degrees (0 = north, clockwise) to match the
// rest of the engine. Active only while "driving"; otherwise fully inert.

const KEY_ACTION = {
  w: 'fwd', arrowup: 'fwd',
  s: 'back', arrowdown: 'back',
  a: 'left', arrowleft: 'left',
  d: 'right', arrowright: 'right',
  ' ': 'brake',
};

// Arcade tuning (SI-ish): metres / m·s⁻¹ / deg·s⁻¹.
const MAX_FWD = 25;      // ~90 km/h top speed
const MAX_REV = 9;       // slower in reverse
const ACCEL = 16;        // throttle
const BRAKE = 34;        // space / opposite key
const ROLL = 7;          // coast-down friction when no input
const STEER = 105;       // deg/s at full lock, scaled by speed

export function initCar(opts = {}) {
  // canMove(lon, lat) -> bool: optional collision predicate (main.js queries the
  // 3D building footprints). When it rejects a candidate position the car stops at
  // the wall and bounces back slightly, so you can't drive THROUGH buildings.
  const canMove = typeof opts.canMove === 'function' ? opts.canMove : null;
  const keys = new Set();
  let active = false;
  let lon = 0, lat = 0, hdg = 0, speed = 0;

  function onKey(e, down) {
    if (!active) return;
    const a = KEY_ACTION[e.key.toLowerCase()];
    if (!a) return;
    e.preventDefault();   // stop arrows/space from scrolling or panning the map
    if (down) keys.add(a); else keys.delete(a);
  }
  const kd = (e) => onKey(e, true);
  const ku = (e) => onKey(e, false);
  window.addEventListener('keydown', kd);
  window.addEventListener('keyup', ku);

  function start(lon0, lat0, hdg0) {
    lon = lon0; lat = lat0; hdg = ((hdg0 || 0) % 360 + 360) % 360; speed = 0;
    keys.clear();
    active = true;
  }
  function stop() { active = false; speed = 0; keys.clear(); }

  // Advance physics by dt seconds; returns the new pose (or null if inactive).
  function step(dt) {
    if (!active) return null;
    dt = Math.min(Math.max(dt, 0), 0.05);   // clamp to avoid tunnelling on a hitch

    if (keys.has('fwd')) speed += ACCEL * dt;
    else if (keys.has('back')) speed -= ACCEL * dt;
    else {                                   // coast down toward 0
      const f = ROLL * dt;
      speed = speed > f ? speed - f : (speed < -f ? speed + f : 0);
    }
    if (keys.has('brake')) {
      const b = BRAKE * dt;
      speed = speed > b ? speed - b : (speed < -b ? speed + b : 0);
    }
    speed = Math.max(-MAX_REV, Math.min(MAX_FWD, speed));

    // Steer only while rolling; tighter at low speed, and reversed when reversing.
    const steer = (keys.has('left') ? 1 : 0) - (keys.has('right') ? 1 : 0);
    if (steer && Math.abs(speed) > 0.3) {
      const dir = speed >= 0 ? 1 : -1;
      hdg -= steer * STEER * dt * dir * Math.min(1, Math.abs(speed) / 7);
      hdg = (hdg % 360 + 360) % 360;
    }

    const dist = speed * dt;                 // metres this frame
    if (dist !== 0) {
      const rad = (hdg * Math.PI) / 180;
      const M_PER_DEG = 111320;
      const nLat = lat + (Math.cos(rad) * dist) / M_PER_DEG;
      const nLon = lon + (Math.sin(rad) * dist) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
      if (!canMove || canMove(nLon, nLat)) {
        lon = nLon; lat = nLat;              // clear road -> advance
      } else {
        speed = -speed * 0.3;                // hit a building wall -> stop + small recoil
      }
    }
    return { lon, lat, hdg, speed };
  }

  function getState() { return active ? { lon, lat, hdg, speed } : null; }
  function dispose() { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); }

  return { start, stop, step, getState, dispose, get active() { return active; } };
}
