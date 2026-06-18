// vehicles3d.js — ALL 3D rendering lives here. The motion model (fleet /
// curState / animate in main.js) is the SOLE source of truth for position and
// heading; this module only READS the per-frame values main.js hands it via
// syncFrame() and writes them into GPU instance transforms. It owns:
//   - a THREE.WebGLRenderer bound to MapLibre's EXISTING GL context (no second
//     context, no second canvas, no parallel compositor),
//   - a THREE.Scene with one THREE.InstancedMesh per mode (instanceMatrix for
//     transform, instanceColor for the PID line color => one draw call / mode),
//   - the MapLibre CustomLayerInterface (onAdd / render / onRemove),
//   - all preallocated scratch objects (ZERO per-frame allocation),
//   - the compass-deg -> Mercator-yaw conversion + per-frame meter->mercator
//     scale cache, and viewport culling with compacted instance indices.
//
// Public API (consumed by main.js):
//   init3DLayer(map, { meshProvider }) -> {
//     layerId, supported, customLayer,
//     setVisible(bool),
//     hideMeshes(),
//     syncFrame(fleet, ts, sampleAlong, { filter, selectedId, selectHex }),
//     setNight(bool),   // day(false, default) / night(true): dim body + headlights
//     dispose()
//   }
//
// Beyond the single body InstancedMesh/mode, rail modes (tram/metro/train) also
// get a SEPARATE pivoting-bogie InstancedMesh (one draw/mode): 2 bogies/car placed
// at each car's two truck points and yawed to the LOCAL rail tangent there, so the
// bogies swing into curves while the body keeps its gentle chord orientation. Night
// mode adds two shared emissive InstancedMeshes (head + tail lights). All geometry
// — bodies, bogies, lights — goes through the SAME relative-origin precision
// transform (writeInstance), so float precision on the Mercator MVP is preserved.

import * as THREE from 'three';
import { classifyModel } from './meshProvider.js';
import { MODES } from './meshProvider.js';

// Punctuality → hex for the ground halo. Mirrors the 2D veh-halo ramp (on-time
// band ±~120 s): unknown grey · early azure · on-time green · late amber→orange→red.
function delayHex(dl) {
  if (dl == null) return '#7A8290';
  if (dl < -30) return '#3b9eff';
  if (dl <= 90) return '#2ee68a';
  if (dl <= 210) return '#f5d90a';
  if (dl <= 330) return '#f0820a';
  return '#d2192c';
}

// Compass bearing (deg, 0 = N, clockwise) from point a → point b. Used to orient
// a car body along the CHORD between its two trucks (gentle curve rotation).
function chordBearing(lo1, la1, lo2, la2) {
  const rad = Math.PI / 180;
  const y = Math.sin((lo2 - lo1) * rad) * Math.cos(la2 * rad);
  const x = Math.cos(la1 * rad) * Math.sin(la2 * rad)
          - Math.sin(la1 * rad) * Math.cos(la2 * rad) * Math.cos((lo2 - lo1) * rad);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// LOCAL track tangent (compass deg) AT a chainage `backMeters` behind the vehicle,
// by sampling two points a hair ahead/behind that point and taking their bearing.
// Unlike the body chord (which spans the whole truck base to rotate gently), this
// is the INSTANTANEOUS rail direction at a single truck, so each bogie swings into
// the curve. sampleAlong positions are the true offset track points (its `hdg` is
// body-rigid/eased and deliberately NOT used here). In point-mode (no shape) the
// two samples collapse to the body heading — bogies then simply align with the
// body, which is correct when there is no curve information.
const TANGENT_EPS = 1.5; // meters ahead/behind the truck for the tangent chord
function truckTangent(sampleAlong, v, ts, backMeters) {
  const ahead  = sampleAlong(v, ts, backMeters - TANGENT_EPS); // smaller backM = forward
  const behind = sampleAlong(v, ts, backMeters + TANGENT_EPS);
  return chordBearing(behind.lon, behind.lat, ahead.lon, ahead.lat);
}

const LAYER_ID = 'veh-3d';
const MAX_PER_MODE = 3072;      // backing-buffer size per InstancedMesh (multi-car modes use several instances per vehicle)
const CULL_PAD = 0.1;           // 10% bounds padding for viewport culling

// Vehicles render at TRUE real-world scale (a real 30 m tram is ~40 px at z16).
// Exaggeration made bunched vehicles overlap into one giant block, so it's off.
const VEHICLE_SCALE = 1.0;      // 1.0 = real scale; bump only if they read too small

// MercatorCoordinate.meterInMercatorCoordinateUnits() depends only on latitude
// (zoom-independent). For Prague it is effectively constant; we still refresh it
// once per frame from the map center so a panned-away view stays correct.

export function init3DLayer(map, { meshProvider }) {
  // --- capability gate ------------------------------------------------------
  // Need WebGL2 (for robust instancing + instanceColor). Graceful 2D-forever
  // fallback if absent — main.js hides the toggle and never shows a blank map.
  // Probe a THROWAWAY canvas (asking the map's own canvas for 'webgl2' would
  // conflict with the context MapLibre already created on it).
  let supported = false;
  try {
    supported = !!document.createElement('canvas').getContext('webgl2');
  } catch { supported = false; }

  // Always return a controller. If unsupported, all methods are no-ops.
  if (!supported) {
    return {
      layerId: LAYER_ID,
      supported: false,
      setVisible() {},
      syncFrame() {},
      setNight() {},
      setXray() {},
      setCar() {},
      invalidateColors() {},
      dispose() {},
    };
  }

  // --- three.js scene (built lazily in onAdd, where gl is guaranteed) --------
  let renderer = null;
  let scene = null;
  let camera = null;
  const meshes = new Map();       // mode -> THREE.InstancedMesh (car bodies)
  const bogieMeshes = new Map();  // mode -> THREE.InstancedMesh (separate pivoting bogies; rail modes only)
  const layouts = new Map();      // mode -> { cars, spacing } (articulation)
  const liveried = new Map();     // mode -> bool: baked real livery (render with WHITE instanceColor)
  let visible = false;            // 3D representation currently shown
  let nightMode = false;          // day(false)/night(true) — headlights + dimmed body

  // Night-mode scene state (created in buildScene, toggled by setNight).
  let dirLight = null, ambLight = null;       // scene lights we dim at night
  let headMesh = null, tailMesh = null;       // shared emissive head/tail-light instanced meshes
  let haloMesh = null;                        // shared ground punctuality-halo disc (day + night)
  const DAY_DIR = 1.15, DAY_AMB = 0.92;       // day light: higher ambient fill so shaded flanks of the baked liveries read vivid (reds were too dark)
  const NIGHT_DIR = 0.32, NIGHT_AMB = 0.22;   // night: dim + cool ambient
  const HEAD_HEX = '#fff4d6';                  // warm-white headlight glow
  const TAIL_HEX = '#cc1f1f';                  // dim red tail marker

  // --- preallocated scratch (NO per-frame allocation) -----------------------
  const _m4 = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _qAxis = new THREE.Vector3(0, 0, 1); // yaw about +Z (up)
  const _pos = new THREE.Vector3();
  const _scl = new THREE.Vector3();
  const _color = new THREE.Color();
  const _projection = new THREE.Matrix4();
  const _originMat = new THREE.Matrix4();  // folds the mercator origin into the camera matrix
  const _cursor = new Map();      // per-mode body write cursor, reused every frame (no alloc)
  const _bogieCursor = new Map(); // per-mode bogie write cursor, reused every frame (no alloc)
  let _headCursor = 0, _tailCursor = 0; // night head/tail-light write cursors (reused)
  let _haloCursor = 0;                  // ground-halo write cursor (reused)
  let _lightColorsSet = false;    // head/tail glow tints are constant -> upload once
  let originX = 0, originY = 0;   // per-frame mercator origin; instances are stored RELATIVE to it
  let xray = false;               // when true, clear depth before drawing so the fleet shows THROUGH see-through buildings
  let carMesh = null;             // drivable arcade car (free-agent mesh; built lazily on first setCar)
  let carState = null;            // {lon,lat,hdg} | null — current car pose, placed in syncFrame

  function buildScene(gl) {
    renderer = new THREE.WebGLRenderer({
      canvas: map.getCanvas(),
      context: gl,
      antialias: true,
    });
    // We are a guest on MapLibre's context: never auto-clear (MapLibre owns the
    // framebuffer + clears), and reset state every render() call.
    renderer.autoClear = false;
    // Output in sRGB so baked LINEAR vertex liveries display at their true color
    // (without this the deep reds read muddy/dark). NoToneMapping = no filmic
    // desaturation of the saturated PID red/cream.
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;

    scene = new THREE.Scene();
    // MapLibre supplies the full MVP; our camera is a passthrough whose
    // projectionMatrix we overwrite each frame with that MVP.
    camera = new THREE.Camera();

    // Cheap one-directional + one-ambient lighting (MeshLambertMaterial honors
    // both and respects instanceColor). Light comes from "above + south". We keep
    // references so setNight() can dim them (day intensities preserved as default).
    dirLight = new THREE.DirectionalLight(0xffffff, DAY_DIR);
    dirLight.position.set(0.4, -0.7, 1).normalize();
    scene.add(dirLight);
    ambLight = new THREE.AmbientLight(0xffffff, DAY_AMB);
    scene.add(ambLight);

    // One body InstancedMesh per mode, sized once. count starts at 0.
    for (const mode of MODES) {
      const { geometry, material, layout, liveried: liv } = meshProvider.getModeAsset(mode);
      layouts.set(mode, layout || { cars: 1, spacing: 0, truckHalf: 3 });
      liveried.set(mode, !!liv);
      const inst = makeInstanced(geometry, material);
      meshes.set(mode, inst);
      scene.add(inst);

      // Separate pivoting-bogie mesh for rail modes (provider feature-detected;
      // returns null for road/water/cable modes). Its own draw call per mode.
      // Rendered with WHITE instanceColor (left untouched) so the baked-dark bogie
      // stays near-black on any livery.
      if (typeof meshProvider.getBogieAsset === 'function') {
        const bog = meshProvider.getBogieAsset(mode);
        if (bog && bog.geometry) {
          const binst = makeInstanced(bog.geometry, bog.material);
          bogieMeshes.set(mode, binst);
          scene.add(binst);
        }
      }
    }

    // Shared ground punctuality-halo (one draw, all modes). Added BEFORE the light
    // meshes so it sits at the bottom of the transparent stack (it lies on the
    // ground under everything). Populated every frame (day + night).
    if (typeof meshProvider.getHaloAsset === 'function') {
      const ha = meshProvider.getHaloAsset();
      if (ha && ha.geometry) {
        haloMesh = makeInstanced(ha.geometry, ha.material);
        scene.add(haloMesh);
      }
    }

    // Shared night-mode head/tail emissive light meshes (one draw each, ALL modes
    // share them — geometry is mode-agnostic). Populated only while nightMode.
    if (typeof meshProvider.getLightAsset === 'function') {
      const la = meshProvider.getLightAsset();
      if (la && la.geometry) {
        headMesh = makeInstanced(la.geometry, la.headMaterial);
        tailMesh = makeInstanced(la.geometry, la.tailMaterial);
        scene.add(headMesh);
        scene.add(tailMesh);
      }
    }
  }

  // Build one preconfigured InstancedMesh (CPU-culled, dynamic matrix, white
  // instanceColor backing buffer up front so setColorAt never reallocates).
  function makeInstanced(geometry, material) {
    const inst = new THREE.InstancedMesh(geometry, material, MAX_PER_MODE);
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.frustumCulled = false; // we cull on the CPU against map bounds
    inst.count = 0;
    const colors = new Float32Array(MAX_PER_MODE * 3).fill(1);
    inst.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    inst.instanceColor.setUsage(THREE.DynamicDrawUsage);
    return inst;
  }

  // --- per-instance color cache: upload color ONLY when it changes ----------
  // keyed by "mode\0i" -> last hex string written, so a steady fleet uploads
  // instanceColor at most when a vehicle's line color actually changes.
  const colorCache = new Map();
  const haloColorCache = new Map(); // per-halo-instance last hex (punctuality tint)

  // --- the MapLibre CustomLayerInterface ------------------------------------
  const customLayer = {
    id: LAYER_ID,
    type: 'custom',
    renderingMode: '3d',

    onAdd(_map, gl) {
      buildScene(gl);
    },

    // render(gl, matrix, options): MapLibre passes the camera MVP as the 2nd
    // positional `matrix` (a plain mat4 projecting Mercator [0..1] world coords
    // to clip space; z is conformal in 3d mode). options.modelViewProjectionMatrix
    // mirrors it (maplibre-gl@4.7.1, verified against installed type defs). We do
    // NOT advance any state here — main.js's animate() is the sole clock.
    render(gl, matrix, options) {
      if (!visible || !renderer) return;
      const mvp = matrix || (options && options.modelViewProjectionMatrix);
      if (!mvp) return;
      // Fold the per-frame mercator origin into the camera matrix (Matrix4 does
      // this in float64) so the instance translations stay SMALL (relative to the
      // view centre). Absolute mercator (~0.54) in a float32 instanceMatrix times
      // the high-zoom MVP is what made the meshes swim/wiggle.
      _projection.fromArray(mvp);
      _originMat.makeTranslation(originX, originY, 0);
      _projection.multiply(_originMat);
      camera.projectionMatrix.copy(_projection);

      renderer.resetState();   // mandatory: three + MapLibre share the context
      // X-ray: when the 3D buildings are made see-through, the building extrusion
      // has already WRITTEN DEPTH this frame, so vehicle fragments behind a
      // building would fail the depth test and vanish — transparency doesn't help.
      // Clearing the depth buffer here lets the fleet draw on top of the (now
      // translucent) buildings so you can actually see vehicles through them.
      if (xray) renderer.clearDepth();
      renderer.render(scene, camera);

      // Keep MapLibre's rAF alive while we're the active representation so the
      // scene re-renders at display pace even when the map isn't interacting.
      map.triggerRepaint();
    },

    onRemove() {
      // Scene teardown happens in dispose(); onRemove may fire on style reload.
    },
  };

  // --- transform write: Mercator placement + heading -> yaw -----------------
  // local frame: +X forward, +Y left, +Z up (meters). MapLibre Mercator world:
  // +X east, +Y south, +Z up; 1 mercator unit == meterInMercatorCoordinateUnits
  // meters. Heading `hdg` is COMPASS degrees (0 = north, clockwise), straight
  // from curState (track tangent). We rotate the local +X-forward body so it
  // points along that compass bearing in Mercator space.
  //
  // Mercator +X = east, +Y = SOUTH (+Y increases southward). A right-handed yaw
  // of theta about +Z sends local +X(forward) to world (cos theta, sin theta) =
  // (east, south). Compass bearing hdg -> world (sin hdg, -cos hdg), so the yaw
  // is (hdg - 90) degrees: north(0)->(0,-1); east(90)->(1,0); south(180)->(0,1).
  function writeInstance(inst, i, lon, lat, hdg, scale) {
    // Web Mercator normalized to [0,1] (the units MapLibre's MVP expects);
    // inlined to avoid allocating a MercatorCoordinate per instance.
    const mx = (180 + lon) / 360;
    const sinLat = Math.sin((lat * Math.PI) / 180);
    const my = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
    _pos.set(mx - originX, my - originY, 0); // RELATIVE to the frame origin (precision)
    const yaw = ((hdg - 90) * Math.PI) / 180;
    _q.setFromAxisAngle(_qAxis, yaw);
    _scl.set(scale, scale, scale);
    _m4.compose(_pos, _q, _scl);
    inst.setMatrixAt(i, _m4); // copies into the preallocated Float32Array
  }

  // meterInMercatorCoordinateUnits at a given latitude, normalized [0,1] world.
  // Matches MapLibre's MercatorCoordinate.meterInMercatorCoordinateUnits().
  function meterScale(lat) {
    // 6371008.8 = WGS84 mean radius — matches MapLibre's MercatorCoordinate
    // (using the equatorial radius would oversize meshes ~0.11%).
    const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6371008.8;
    return 1 / (EARTH_CIRCUMFERENCE * Math.abs(Math.cos((lat * Math.PI) / 180)));
  }

  // --- per-frame sync from the motion model ---------------------------------
  // Called by main.js's animate() in 3D mode. fleet/curState are passed in so
  // this module never imports or duplicates the motion model. curState is
  // evaluated EXACTLY ONCE per vehicle here (the same single eval main.js uses).
  function syncFrame(fleet, ts, sampleAlong, opts) {
    if (!visible || !renderer) return;
    const filter = opts && opts.filter;            // skip vehicles hidden by the panel
    const selId = opts && opts.selectedId;          // highlight the picked vehicle
    const selHex = (opts && opts.selectHex) || '#ffd400';

    // Viewport cull bounds (padded). Computed ONCE per frame.
    const b = map.getBounds();
    const w = b.getWest(), e = b.getEast(), s = b.getSouth(), n = b.getNorth();
    const padX = (e - w) * CULL_PAD, padY = (n - s) * CULL_PAD;
    const minLon = w - padX, maxLon = e + padX, minLat = s - padY, maxLat = n + padY;

    // Frame origin = map-centre mercator. Instances are written RELATIVE to it and
    // the origin is folded back in render() — keeps GPU coords small (no swimming).
    const c = map.getCenter();
    originX = (180 + c.lng) / 360;
    const sinC = Math.sin((c.lat * Math.PI) / 180);
    originY = 0.5 - Math.log((1 + sinC) / (1 - sinC)) / (4 * Math.PI);

    // meter->mercator scale (ONCE/frame) at true real-world scale (× tunable VEHICLE_SCALE).
    const scale = meterScale(c.lat) * VEHICLE_SCALE;

    // Drivable car (free agent): same mercator-relative placement as the fleet.
    if (carMesh) {
      if (carState) {
        const cmx = (180 + carState.lon) / 360;
        const csin = Math.sin((carState.lat * Math.PI) / 180);
        const cmy = 0.5 - Math.log((1 + csin) / (1 - csin)) / (4 * Math.PI);
        _pos.set(cmx - originX, cmy - originY, 0);
        _q.setFromAxisAngle(_qAxis, ((carState.hdg - 90) * Math.PI) / 180);
        _scl.set(scale, scale, scale);
        carMesh.matrix.compose(_pos, _q, _scl);
        carMesh.visible = true;
      } else {
        carMesh.visible = false;
      }
    }

    // Reset the reused write cursors per mode (compacts visible instances to the
    // front). Reused across frames — no per-frame Map allocation.
    const cursor = _cursor;
    const bcursor = _bogieCursor;
    for (const mode of MODES) { cursor.set(mode, 0); bcursor.set(mode, 0); }
    _headCursor = 0; _tailCursor = 0; _haloCursor = 0;
    const night = nightMode && headMesh && tailMesh;

    for (const v of fleet.values()) {
      if (filter && !filter(v)) continue;           // mode/line filter from the panel

      // Cull on the vehicle's reference point. sampleAlong(v, ts, 0) is the SAME
      // value main.js uses for the 2D dot (single source of truth).
      const ref = sampleAlong(v, ts, 0);
      if (ref.lon < minLon || ref.lon > maxLon || ref.lat < minLat || ref.lat > maxLat) continue;

      // Ground punctuality HALO under every visible vehicle (day + night), tinted to
      // the same on-time/late color the 2D dots use — gives the 3D fleet the same
      // attention read. It's a circle, so heading is irrelevant (pass 0).
      if (haloMesh && _haloCursor < MAX_PER_MODE) {
        const hIdx = _haloCursor;
        writeInstance(haloMesh, hIdx, ref.lon, ref.lat, 0, scale);
        const hHex = delayHex(v.props ? v.props.dl : null);
        if (haloColorCache.get(hIdx) !== hHex) {
          _color.set(hHex);
          haloMesh.setColorAt(hIdx, _color);
          haloMesh.instanceColor.needsUpdate = true;
          haloColorCache.set(hIdx, hHex);
        }
        _haloCursor++;
      }

      const rawMode = classifyModel(v.props);   // silhouette class (e.g. tram_t3) or mode
      const mode = meshes.has(rawMode) ? rawMode : 'other';
      const inst = meshes.get(mode);
      const lay = layouts.get(mode) || { cars: 1, spacing: 0, truckHalf: 3 };
      const half = lay.truckHalf || 3;
      // LIVERIED modes bake their real paint into vertex colors and must render with
      // a WHITE instanceColor (so the livery shows unmodified). Non-liveried modes
      // keep the line-color body tint. Selection always wins (selHex tint).
      const isSel = v.props && v.props.id === selId;
      const hex = isSel ? selHex
        : (liveried.get(mode) ? '#ffffff' : ((v.props && v.props.color) || '#7A8290'));

      // ARTICULATION + REAL RAIL ROTATION: place each car at its OWN point along
      // the track shape (so the vehicle bends through curves and the cars visibly
      // separate), and orient each car body by the CHORD between its two trucks —
      // front truck sampled `half` m ahead, rear `half` m behind — NOT the
      // instantaneous tangent at its centre. That is why a real tram/bus body
      // rotates gently while the bogies absorb the curve: the body follows the
      // straight line through its trucks. Centre = truck midpoint (sits naturally
      // inside the arc).
      for (let k = 0; k < lay.cars; k++) {
        const i = cursor.get(mode);
        if (i >= MAX_PER_MODE) break;
        const backM = (k - (lay.cars - 1) / 2) * lay.spacing;
        const front = sampleAlong(v, ts, backM - half); // ahead truck
        const rear  = sampleAlong(v, ts, backM + half); // behind truck
        const lon = (front.lon + rear.lon) / 2;
        const lat = (front.lat + rear.lat) / 2;
        const hdg = chordBearing(rear.lon, rear.lat, front.lon, front.lat);
        writeInstance(inst, i, lon, lat, hdg, scale);

        // Per-instance color: upload ONLY when it changed (dirty-flagged here).
        const ck = mode + '\0' + i;
        if (colorCache.get(ck) !== hex) {
          _color.set(hex);
          inst.setColorAt(i, _color);
          inst.instanceColor.needsUpdate = true; // <=1 upload/mode/frame if any changed
          colorCache.set(ck, hex);
        }
        cursor.set(mode, i + 1);

        // INDEPENDENTLY PIVOTING BOGIES (rail modes): drop a separate bogie mesh
        // at BOTH truck points (the same front/rear samples used for the body
        // chord), each yawed to the LOCAL rail tangent at that truck — so each
        // bogie swings into the curve while the body above barely rotates. The
        // bogie's own instanceColor is left WHITE (baked-dark frame stays black on
        // any livery); we never tint it. Same precision transform via writeInstance.
        const binst = bogieMeshes.get(mode);
        if (binst) {
          let bi = bcursor.get(mode);
          if (bi + 1 < MAX_PER_MODE) {
            const fHdg = truckTangent(sampleAlong, v, ts, backM - half);
            writeInstance(binst, bi, front.lon, front.lat, fHdg, scale);
            const rHdg = truckTangent(sampleAlong, v, ts, backM + half);
            writeInstance(binst, bi + 1, rear.lon, rear.lat, rHdg, scale);
            bcursor.set(mode, bi + 2);
          }
        }

        // NIGHT HEADLIGHTS / TAIL MARKERS: a forward-facing warm-white glow on the
        // LEAD car's front, a dim red marker on the REAR car's back, both oriented
        // to the body (travel) heading. Lead car = k===0 (most forward), rear car
        // = k===lay.cars-1; for a single-unit vehicle one car is both. Emissive
        // (unlit) quad => no real lights. Only while night mode is active.
        if (night) {
          if (k === 0 && _headCursor < MAX_PER_MODE) {
            writeInstance(headMesh, _headCursor, front.lon, front.lat, hdg, scale);
            _headCursor++;
          }
          if (k === lay.cars - 1 && _tailCursor < MAX_PER_MODE) {
            writeInstance(tailMesh, _tailCursor, rear.lon, rear.lat, hdg, scale);
            _tailCursor++;
          }
        }
      }
    }

    // Finalize BODY counts + flag ONE instanceMatrix upload per mode.
    for (const mode of MODES) {
      const inst = meshes.get(mode);
      const count = cursor.get(mode);
      inst.count = count;
      if (count > 0) inst.instanceMatrix.needsUpdate = true;

      // Finalize BOGIE counts (rail modes only).
      const binst = bogieMeshes.get(mode);
      if (binst) {
        const bc = bcursor.get(mode);
        binst.count = bc;
        if (bc > 0) binst.instanceMatrix.needsUpdate = true;
      }
    }

    // Finalize NIGHT light counts + set their constant glow tints ONCE.
    if (headMesh && tailMesh) {
      if (night && !_lightColorsSet) {
        _color.set(HEAD_HEX);
        for (let j = 0; j < MAX_PER_MODE; j++) headMesh.setColorAt(j, _color);
        _color.set(TAIL_HEX);
        for (let j = 0; j < MAX_PER_MODE; j++) tailMesh.setColorAt(j, _color);
        headMesh.instanceColor.needsUpdate = true;
        tailMesh.instanceColor.needsUpdate = true;
        _lightColorsSet = true;
      }
      headMesh.count = night ? _headCursor : 0;
      tailMesh.count = night ? _tailCursor : 0;
      if (night && _headCursor > 0) headMesh.instanceMatrix.needsUpdate = true;
      if (night && _tailCursor > 0) tailMesh.instanceMatrix.needsUpdate = true;
    }

    // Finalize HALO count (day + night).
    if (haloMesh) {
      haloMesh.count = _haloCursor;
      if (_haloCursor > 0) haloMesh.instanceMatrix.needsUpdate = true;
    }
  }

  // --- visibility -----------------------------------------------------------
  // Toggling visible flips whether render()/syncFrame() do work. When hidden we
  // zero every count so the layer draws nothing (the 2D layers take over).
  function setVisible(v) {
    visible = !!v;
    if (!visible) hideMeshes();
    map.triggerRepaint();
  }

  // Zero every instance count so render() draws nothing this frame — used while
  // zoomed out below the mesh LOD threshold (2D dots take over) without leaving
  // the 3D representation entirely (setVisible(true) still holds). Covers bodies,
  // bogies, and the night head/tail lights.
  function hideMeshes() {
    for (const inst of meshes.values()) inst.count = 0;
    for (const inst of bogieMeshes.values()) inst.count = 0;
    if (headMesh) headMesh.count = 0;
    if (tailMesh) tailMesh.count = 0;
    if (haloMesh) haloMesh.count = 0;
  }

  // --- day / night ----------------------------------------------------------
  // setNight(true): dim the directional + ambient light and add a subtle dark
  // emissive to the body materials (so vehicles don't go pitch-black), then
  // headlights/tail markers light up on the next syncFrame. setNight(false)
  // restores the exact day look. Cheap: a couple of light-intensity writes + an
  // emissive toggle, NO per-instance work here (lights are placed in syncFrame).
  // Default is day (nightMode=false). main.js calls this on theme change.
  function setNight(on) {
    nightMode = !!on;
    if (dirLight) dirLight.intensity = nightMode ? NIGHT_DIR : DAY_DIR;
    if (ambLight) ambLight.intensity = nightMode ? NIGHT_AMB : DAY_AMB;
    // Subtle self-illumination so dimmed bodies keep their livery readable at
    // night without real lights. Applied to body materials only (bogies stay dark;
    // light quads are unlit MeshBasicMaterial and unaffected). Guarded for the
    // emissive property so a non-Lambert material from a glTF provider is safe.
    for (const inst of meshes.values()) {
      const m = inst.material;
      if (m && m.emissive) {
        m.emissive.setHex(nightMode ? 0x141821 : 0x000000);
        m.needsUpdate = true;
      }
    }
    if (!nightMode) { if (headMesh) headMesh.count = 0; if (tailMesh) tailMesh.count = 0; }
    map.triggerRepaint();
  }

  // Build the drivable car once (low-poly group in METRES; the syncFrame matrix
  // scales metres->mercator exactly like the fleet). Local frame +X fwd / +Y left
  // / +Z up. A bright body so it reads against the map + fleet.
  function buildCar() {
    if (carMesh || !scene) return;
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;   // we drive its matrix directly each frame
    const paint = new THREE.MeshLambertMaterial({ color: 0xff2d3a });
    const glass = new THREE.MeshLambertMaterial({ color: 0x1b2735 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x0c0e12 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.9, 0.8), paint);
    body.position.set(0, 0, 0.75);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.7, 0.7), glass);
    cabin.position.set(-0.25, 0, 1.35);
    g.add(body, cabin);
    const wheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.36, 14); // axis = local +Y (axle)
    for (const [x, y] of [[1.4, 0.98], [1.4, -0.98], [-1.4, 0.98], [-1.4, -0.98]]) {
      const w = new THREE.Mesh(wheelGeo, dark);
      w.position.set(x, y, 0.45);
      g.add(w);
    }
    carMesh = g;
    carMesh.visible = false;
    scene.add(carMesh);
  }

  // setCar(state|null): show/hide + pose the drivable car. state = {lon,lat,hdg}.
  function setCar(state) {
    carState = state || null;
    if (carState) buildCar();
    if (carMesh) carMesh.visible = !!carState;
    map.triggerRepaint();
  }

  // setXray(true): draw the fleet ON TOP of the see-through buildings (depth
  // cleared before the scene render) so vehicles inside/behind glassy buildings
  // stay visible. main.js turns this on when building opacity drops below ~0.7.
  function setXray(on) {
    xray = !!on;
    map.triggerRepaint();
  }

  function dispose() {
    for (const inst of meshes.values()) {
      scene && scene.remove(inst);
      inst.dispose();
    }
    for (const inst of bogieMeshes.values()) {
      scene && scene.remove(inst);
      inst.dispose();
    }
    if (headMesh) { scene && scene.remove(headMesh); headMesh.dispose(); headMesh = null; }
    if (tailMesh) { scene && scene.remove(tailMesh); tailMesh.dispose(); tailMesh = null; }
    if (haloMesh) { scene && scene.remove(haloMesh); haloMesh.dispose(); haloMesh = null; }
    meshes.clear();
    bogieMeshes.clear();
    colorCache.clear();
    haloColorCache.clear();
    meshProvider.dispose && meshProvider.dispose();
    // Do NOT call renderer.dispose() with forceContextLoss — the context belongs
    // to MapLibre. Just drop our reference.
    renderer = null;
    scene = null;
  }

  // After a setStyle() reload, onAdd→buildScene rebuilds the scene with FRESH
  // (white) instanceColor buffers, but colorCache still holds the old per-instance
  // hexes → setColorAt would skip the re-upload and the fleet would render white.
  // Clearing the cache (+ the head/tail light-color latch) forces a full re-upload
  // on the next syncFrame.
  function invalidateColors() {
    colorCache.clear();
    haloColorCache.clear();
    _lightColorsSet = false;
  }

  return {
    layerId: LAYER_ID,
    customLayer,                 // main.js passes this to map.addLayer(...)
    supported: true,
    setVisible,
    hideMeshes,
    syncFrame,
    setNight,                    // setNight(boolean) — day(false)/night(true); default day
    setXray,                     // setXray(boolean) — draw fleet through see-through buildings
    setCar,                      // setCar({lon,lat,hdg}|null) — pose/hide the drivable car
    invalidateColors,            // clear the color cache after a style-reload re-add
    dispose,
  };
}
