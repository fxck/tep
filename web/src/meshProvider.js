// meshProvider.js — the SWAP SEAM for 3D vehicle geometry.
//
// A mesh provider implements ONE method:
//   getModeAsset(mode) -> { geometry: THREE.BufferGeometry,
//                           material: THREE.Material,
//                           footprintMeters: { len, wid, hgt } }
//
// vehicles3d.js consumes ONLY this interface — it never knows whether the
// geometry is procedural (v1) or fetched from a real glTF model (later phase).
// To go real-asset: implement gltfMeshProvider({ base }) below with the SAME
// shape; init3DLayer's call site is a one-line provider swap. NOTHING in the
// motion model (fleet / curState / animate) or in vehicles3d.js changes.
//
// Geometry is authored ONCE in vehicle-LOCAL space, METERS:
//   +X = forward (direction of travel),  +Y = left,  +Z = up,
//   origin at GROUND center. The WHEELS rest on z=0 (the rail/road plane) and
//   the body floats above them on its undercarriage — "grounded physics".
// vehicles3d.js maps this local frame onto Mercator per instance.
//
// COLOR MODEL (one material per mode, vertexColors:true). On-screen color of a
// vertex = instanceColor(line) * vertexColor(baked shade) * light. So baking is
// the ONLY per-part control we have:
//   - BODY panels  -> WHITE (1.0)  : reads as the full PID line color.
//   - WINDOWS      -> ~0.06        : near-black, glassy, dark on any line color.
//   - WHEELS/tyres -> 0.0          : true black (0 * line = 0) — the contact band.
//   - ROOF/trim/   -> ~0.45-0.6    : a darkened tint of the line color (natural).
//     pantograph/poles
//   - NOSE/cab     -> ~0.32        : a darker body shade so heading reads.
// There is no way to give a part a hue independent of the line color, so the
// palette is white / near-zero / mid-grey by design.
//
// READABILITY-FIRST: every model is tuned for a TILTED-OVERHEAD read — a domed
// roof ridge, a continuous dark window band on both flanks, black wheels poking
// out at the sides, a distinct darker raked cab nose, and (tram/metro/train) a
// roof pantograph. The poly budget is spent on what reads from above, not on
// round cross-sections.
//
// POLY BUDGET (drawn triangles per mode, single instanced draw call each —
// BoxGeometry = 12 tris, capped N-seg CylinderGeometry = 4N tris; verified
// against the merged geometry's index.count/3):
//   tram 432 · metro 600 · train 768 · bus 168 · trolleybus 208 ·
//   ferry 72 · funicular 192 · cablecar/gondola 72 · other 168.
// Worst single mode (train) at 2000 instances ≈ 1.54M tris in ONE draw call —
// a modern GPU rasterizes tens of millions/frame, so this holds 60fps easily.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// --- shade palette ----------------------------------------------------------
// Greyscale shades (single number) are baked into all three channels and read as
// `line color × shade` on a line-tinted mode. LIVERIED modes (trams/buses/…) bake
// REAL RGB colors instead (see LIVERY below) and are rendered with a WHITE
// instanceColor, so the baked livery shows EXACTLY — Prague trams come out red,
// not "whatever color the line happens to be".
const BODY   = 1.0;    // white -> full line color
const NOSE   = 0.32;   // darker body shade for the cab/nose end (heading cue)
const TRIM   = 0.55;   // tinted grey for roof ridge / cabin tops
const RIG    = 0.42;   // darker grey for pantograph / poles / mechanical rig
const GLASS  = 0.06;   // near-black window band
const SKIRT  = 0.10;   // very dark undercarriage skirt (just off black)
const BLACK  = 0.0;    // true-black wheels / tyres — the contact band

// colorArr(hex) -> [r,g,b] in the renderer's WORKING (linear) space. THREE.Color
// interprets the hex as sRGB and stores linear components (ColorManagement is on
// in r169), which is exactly what a baked vertex-color attribute is consumed as —
// so a livery baked via colorArr('#D81E2C') matches what setColorAt('#D81E2C')
// would produce on the instanceColor path. Keeps baked + instance colors aligned.
function colorArr(hex) { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; }

// Real Prague / Czech rolling-stock liveries (sRGB hex -> linear rgb). Used to
// bake distinct, recognisable paint schemes per vehicle CLASS instead of a flat
// line-colored box.
const LIVERY = {
  red:      colorArr('#D81E2C'), // DPP tram/metro red (the dominant Prague livery)
  cream:    colorArr('#ECE6D4'), // classic T3 ivory upper / cream band
  roof:     colorArr('#C5CAD2'), // light grey roof
  skirt:    colorArr('#2E323A'), // dark grey lower skirt
  glass:    colorArr('#0E1218'), // near-black window band
  busIvory: colorArr('#E9E4D6'), // city-bus warm white
  busSkirt: colorArr('#3A3F47'), // bus lower band
  metro:    colorArr('#C3C8CF'), // metro car body (silver-grey, M1-ish)
  metroRed: colorArr('#D81E2C'), // metro door/roof red accent
  trainW:   colorArr('#E9ECF1'), // Esko EMU white
  trainBlue:colorArr('#1C4E92'), // ČD / Esko blue band
};

// --- low-level builders -----------------------------------------------------
// Every builder bakes a 'color' attribute via paint() so mergeGeometries can
// concatenate them (all share position + normal + color). Box primitives give
// position+normal; cylinder primitives give position+normal; paint() adds color.

// A box, positioned by its CENTER-X / CENTER-Y, with its BOTTOM at z=botZ.
// (botZ lets a body float on its undercarriage at the wheel height.)
function box(len, wid, hgt, cx, cy, botZ, shade) {
  const g = new THREE.BoxGeometry(len, wid, hgt);
  g.translate(cx, cy, botZ + hgt / 2);
  paint(g, shade);
  return g;
}

// Body section: full-width box centered on the spine, floating on its
// undercarriage so its bottom sits at `floor` (the top of the wheels region).
function boxSection(len, wid, hgt, cx, floor, shade = BODY) {
  return box(len, wid, hgt, cx, 0, floor, shade);
}

// A continuous dark WINDOW BAND on BOTH flanks: two thin near-black panels
// proud of the body sides, spanning [cx-len/2 .. cx+len/2] at glass height.
// This is the single strongest "it's a transit vehicle" cue from above.
function windowBand(len, cx, wid, bandBot, bandHgt, shade = GLASS) {
  const t = 0.06;                      // panel thickness (proud of the flank)
  const y = wid / 2;                   // flank position
  return [
    box(len, t, bandHgt, cx,  y + t / 2, bandBot, shade), // left flank (+Y)
    box(len, t, bandHgt, cx, -y - t / 2, bandBot, shade), // right flank (-Y)
  ];
}

// A colored SIDE BAND on both flanks — same proud-panel geometry as windowBand,
// reused for livery stripes (a dark skirt, a cream window surround, …). Alias so
// the builders read intentionally ("a cream band here", "a dark skirt there").
const sideBand = windowBand;

// A ROOF RIDGE: a narrow raised box running along the spine on top of the body,
// giving the tilted-overhead silhouette a clear domed crown.
function roofRidge(len, cx, wid, roofTop, hgt = 0.26, shade = TRIM) {
  return box(len, wid * 0.62, hgt, cx, 0, roofTop, shade);
}

// A WHEEL: a short 6-segment "cylinder" whose axle is along Y (it rolls about Y
// for +X travel). The circular CAP faces the flank — that is exactly the disc a
// viewer sees from the side, so we keep the caps (capped 6-seg = 24 tris) and
// hide the inner side behind the bogie skirt. Built resting on z=0 (tyre bottom
// at the rail plane). Baked true black so it stays black on any line color.
function wheel(radius, tread, cx, cy, shade = BLACK) {
  const g = new THREE.CylinderGeometry(radius, radius, tread, 6);
  // CylinderGeometry axis is +Y already (perfect: axle across the vehicle).
  g.translate(cx, cy, radius);         // lift so the tyre bottom touches z=0
  paint(g, shade);
  return g;
}

// A BOGIE / AXLE: a pair of wheels at ±Y, plus a dark skirt box tying them so
// the undercarriage reads as one shadowed mass from the side and the gap under
// the floating body is closed. Returns an array of geometries.
function bogie(radius, tread, cx, halfTrack, skirtLen) {
  const out = [
    wheel(radius, tread, cx,  halfTrack),
    wheel(radius, tread, cx, -halfTrack),
  ];
  if (skirtLen > 0) {
    // low dark skirt spanning the wheel pair, slightly inset of the tyres
    out.push(box(skirtLen, halfTrack * 2 - tread, radius * 1.1, cx, 0, 0, SKIRT));
  }
  return out;
}

// --- PIVOTING-BOGIE asset (rail modes) --------------------------------------
// A standalone dark bogie/wheelset mesh, authored in the SAME vehicle-LOCAL frame
// (+X forward, +Y left, +Z up, wheels resting on z=0) but CENTRED at the origin —
// vehicles3d.js places ONE of these per truck at that truck's own track point and
// yaws it to the LOCAL rail tangent, so each bogie swings into a curve while the
// car body keeps its gentle chord orientation (real rail physics). It is its own
// instanced draw call (one per rail mode). Geometry is baked DARK (SKIRT/BLACK)
// and rendered with white instanceColor, so it stays near-black on ANY line color
// (a real bogie is not painted the livery color). `track` = half-gauge to each
// wheel, `len` = bogie frame length. Built once, cached.
function bogieUnit(track, len, R, tread) {
  return merge([
    // dark bogie frame/skirt tying the wheel pairs into one shadowed mass
    box(len, track * 2 - tread, R * 1.15, 0, 0, 0, SKIRT),
    // two axles (4 wheels), inset from the bogie ends
    wheel(R, tread,  len * 0.32,  track),
    wheel(R, tread,  len * 0.32, -track),
    wheel(R, tread, -len * 0.32,  track),
    wheel(R, tread, -len * 0.32, -track),
  ]);
}

// Per-rail-mode bogie dimensions (mirror each car builder's R/tread/track so the
// pivoting bogie reads identically to the old molded-in one, just free to rotate).
const BOGIES = {
  tram:    { track: 0.92, len: 1.9, R: 0.36, tread: 0.22 },
  tram_t3: { track: 0.92, len: 1.9, R: 0.36, tread: 0.22 },
  tram_kt8:{ track: 0.92, len: 1.9, R: 0.36, tread: 0.22 },
  tram_14t:{ track: 0.92, len: 1.7, R: 0.34, tread: 0.22 },
  metro: { track: 0.95, len: 2.6, R: 0.42, tread: 0.26 },
  train: { track: 1.05, len: 2.8, R: 0.46, tread: 0.28 },
};

// --- HEADLIGHT / TAIL-MARKER asset (night mode) -----------------------------
// A single tiny forward-facing emissive quad authored at the vehicle-LOCAL origin
// in the +Y/+Z plane (faces +X = travel direction). vehicles3d.js instances it at
// the front of the LEAD car (warm-white head beam) and the back of the REAR car
// (dim red tail), only in night mode. Emissive so it glows without real lights —
// a MeshBasicMaterial ignores scene lighting entirely (cheap, always bright). The
// instanceColor carries the glow tint (white-ish head / red tail), set by the
// layer; geometry is a plain unit-ish quad scaled per instance.
function lightQuad() {
  // 2.0 m (Y) x 1.1 m (Z) plane standing vertical, facing +X (forward). Sized to
  // read clearly as a glowing headlight cluster from the tilted top-down view (the
  // old 0.9×0.5 m quad was nearly invisible at real scale). A PlaneGeometry is
  // authored in XY facing +Z, so rotate it to face +X.
  const g = new THREE.PlaneGeometry(2.0, 1.1);
  g.rotateY(Math.PI / 2);              // normal +Z -> +X (faces travel direction)
  g.translate(0, 0, 1.05);             // lift to roughly headlight height
  // give it a 'color' attribute (white) so it can share the vertexColors pipeline
  // shape if ever merged; MeshBasicMaterial below uses instanceColor for the tint.
  paint(g, BODY);
  return g;
}

// A raked CAB NOSE at the +X end: a dark full-height box plus a sloped roof cap
// box (lowered, pushed forward) that reads as a windscreen rake from above and
// the side — a strong, cheap heading cue. Returns an array of geometries.
function cabNose(wid, bodyH, floor, frontX, shade = NOSE) {
  const noseLen = 0.9;
  const cx = frontX + noseLen / 2;
  return [
    // full-height dark cab block flush with the body front
    boxSection(noseLen, wid, bodyH, cx, floor, shade),
    // raked windscreen cap: a lower, slightly forward dark wedge-ish box on top
    box(noseLen * 1.25, wid * 0.96, bodyH * 0.34, cx + 0.12,
        0, floor + bodyH * 0.55, shade),
  ];
}

// A trolley POLE (trolleybus): thin 5-segment cylinder, angled back, sitting on
// the roof and reaching up to the overhead wire line. Baked grey rig.
function pole(radius, length, baseX, baseZ, tiltBackRad, shade = RIG) {
  const g = new THREE.CylinderGeometry(radius, radius, length, 5);
  g.rotateX(Math.PI / 2);            // long axis now along +Z
  g.translate(0, 0, length / 2);     // base at origin, extends up
  g.rotateY(tiltBackRad);            // lean back toward -X
  g.translate(baseX, 0, baseZ);      // place base on the roof
  paint(g, shade);
  return g;
}

// A PANTOGRAPH (tram/metro/train): a folded-arm rig on the roof — a base plate,
// two LOWER arms splaying up-and-in, two UPPER arms meeting at a contact bar.
// All thin boxes baked grey. ~5 boxes = 60 tris. Reads as a real diamond pan
// from a tilted-overhead view without any round geometry.
function pantograph(cx, roofTop, baseLen = 1.9, hgt = 0.9, shade = RIG) {
  const t = 0.06;
  const out = [];
  // base plate across the roof
  out.push(box(baseLen, 0.55, 0.07, cx, 0, roofTop, shade));
  const lowA = (32 * Math.PI) / 180;   // lower-arm lean (splays outward at base)
  const upA  = (50 * Math.PI) / 180;   // upper-arm lean (converges at top bar)
  const lowLen = (hgt * 0.55) / Math.cos(lowA);
  const upLen  = (hgt * 0.55) / Math.cos(upA);
  const knee   = hgt * 0.55;           // height where lower meets upper
  for (const dir of [-1, 1]) {
    // lower arm: base at the plate edge, rising toward the centre
    const lo = new THREE.BoxGeometry(t, t, lowLen);
    lo.rotateY(-dir * lowA);
    lo.translate(cx + dir * (baseLen * 0.32), 0, roofTop + knee / 2);
    paint(lo, shade);
    out.push(lo);
    // upper arm: from the knee up to the contact bar at the centre
    const up = new THREE.BoxGeometry(t, t, upLen);
    up.rotateY(dir * upA);
    up.translate(cx + dir * (baseLen * 0.12), 0, roofTop + knee + (hgt - knee) / 2);
    paint(up, shade);
    out.push(up);
  }
  // horizontal contact bar at the top (rides the overhead wire)
  out.push(box(0.12, 1.5, t, cx, 0, roofTop + hgt - t, shade));
  return out;
}

// Bake a vertex color onto every vertex. `shade` is either a grey-scale scalar in
// [0,1] (baked into all three channels — line-tinted modes) or an [r,g,b] array
// (a real livery color — liveried modes). mergeGeometries concatenates either.
function paint(geom, shade) {
  const n = geom.attributes.position.count;
  const colors = new Float32Array(n * 3);
  if (Array.isArray(shade)) {
    for (let i = 0; i < n; i++) { colors[i * 3] = shade[0]; colors[i * 3 + 1] = shade[1]; colors[i * 3 + 2] = shade[2]; }
  } else {
    for (let i = 0; i < n * 3; i++) colors[i] = shade;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Merge sections into ONE BufferGeometry (instancing needs a single geometry per
// mode, one draw call for the whole fleet). NOTE: in three r169 the second arg
// to mergeGeometries toggles GROUPS, not de-indexing — mergeGeometries(false)
// returns an INDEXED geometry carrying position + normal + uv + our 'color'.
// That is correct and lower-vertex; InstancedMesh renders indexed geometry fine
// (vehicles3d.js only writes instanceMatrix/instanceColor, never the index). Do
// NOT add .toNonIndexed() — it would inflate the buffer for zero benefit. The
// merge requires matching attributes; every section carries position + normal
// (from the box/cylinder primitives) + 'color' (from paint()), so it succeeds.
function merge(sections) {
  const merged = mergeGeometries(sections, false);
  sections.forEach((s) => s.dispose());
  return merged;
}

// Spread N bogie centers evenly along a car of length `len` centered at `cx`,
// inset from the ends by `inset`. Returns an array of x positions.
function axleXs(cx, len, n, inset) {
  if (n === 1) return [cx];
  const span = len - inset * 2;
  const step = span / (n - 1);
  const start = cx - span / 2;
  return Array.from({ length: n }, (_, i) => start + i * step);
}

// --- per-mode procedural geometry (built once) ------------------------------
// All dimensions in meters. Convention: wheels rest on z=0; `floor` = body
// bottom height (it floats above the wheels on the undercarriage). The dark
// raked cab nose is at the +X (forward) end.

// --- per-CAR builders (ARTICULATED modes) -----------------------------------
// Each builds ONE car centred at the origin (+X forward). vehicles3d.js places
// `cars` of them at successive points ALONG the track polyline, so the vehicle
// bends through curves and the cars visibly separate — instead of one rigid bar.
// A single car is short enough that its own rigidity is invisible on real curves.

function carTram() {
  // one ~9 m articulated low-floor section (Škoda 14T / 15T ForCity). LIVERY: the
  // modern Prague tram is RED with a light-grey roof, a dark glass band and a dark
  // lower skirt. Bogies are SEPARATE pivoting instances (bogieUnit/BOGIES.tram)
  // placed + yawed by the 3D layer at each truck's own track point.
  const wid = 2.5, floor = 0.42, bodyH = 2.55, roofTop = floor + bodyH;
  return merge([
    boxSection(9.0, wid, bodyH, 0, floor, LIVERY.red),
    ...sideBand(8.8, 0, wid, floor + 0.02, 0.34, LIVERY.skirt),   // dark lower skirt
    ...windowBand(8.2, 0, wid, floor + 1.0, 1.0, LIVERY.glass),   // dark glass band
    roofRidge(8.6, 0, wid, roofTop, 0.22, LIVERY.roof),
  ]);
}

function carTramT3() {
  // classic Tatra T3: ONE short ~14 m HIGH-FLOOR car. ICONIC TWO-TONE LIVERY — red
  // lower body, cream/ivory upper body around the windows, dark glass band. The
  // silhouette + paint that reads instantly as "old Prague tram".
  const wid = 2.5, floor = 0.9, bodyH = 2.4, roofTop = floor + bodyH;
  const winBot = floor + 0.95;
  return merge([
    box(14.0, wid, winBot - floor, 0, 0, floor, LIVERY.red),     // lower body: red
    box(14.0, wid, roofTop - winBot, 0, 0, winBot, LIVERY.cream),// upper body: cream
    ...windowBand(12.2, 0, wid, winBot + 0.06, 0.82, LIVERY.glass),
    roofRidge(12.8, 0, wid, roofTop, 0.2, LIVERY.cream),
  ]);
}

function carTramKT8() {
  // Tatra KT8D5: high-floor articulated tram, rendered as 3 sections (the real
  // KT8D5 is a 3-part body ~30 m). Red livery with a cream window surround (more
  // cream than a modern 15T) + grey roof — reads as the boxy classic-era artic.
  const wid = 2.5, floor = 0.78, bodyH = 2.5, roofTop = floor + bodyH;
  const winBot = floor + 0.95;
  return merge([
    boxSection(9.0, wid, bodyH, 0, floor, LIVERY.red),
    ...sideBand(8.4, 0, wid, winBot, 1.0, LIVERY.cream),         // cream window surround
    ...windowBand(8.0, 0, wid, winBot + 0.18, 0.66, LIVERY.glass),
    roofRidge(8.4, 0, wid, roofTop, 0.22, LIVERY.roof),
  ]);
}

function carTram14t() {
  // Škoda 14T: modern low-floor tram built from FIVE short modules (~30 m over 5
  // parts). Same red livery as the 15T but rendered as more, shorter sections so
  // the consist reads as the multi-articulated 14T rather than the 3-part 15T.
  const wid = 2.5, floor = 0.42, bodyH = 2.5, roofTop = floor + bodyH;
  return merge([
    boxSection(5.4, wid, bodyH, 0, floor, LIVERY.red),
    ...sideBand(5.2, 0, wid, floor + 0.02, 0.32, LIVERY.skirt),
    ...windowBand(4.8, 0, wid, floor + 1.0, 0.98, LIVERY.glass),
    roofRidge(5.0, 0, wid, roofTop, 0.2, LIVERY.roof),
  ]);
}

function carMetro() {
  // one ~17.5 m metro car. LIVERY: silver-grey body (M1-ish) with a red band at
  // the window line + grey roof. Bogies are SEPARATE pivoting instances.
  const wid = 2.55, floor = 0.55, bodyH = 2.9, roofTop = floor + bodyH;
  return merge([
    boxSection(17.5, wid, bodyH, 0, floor, LIVERY.metro),
    ...sideBand(16.4, 0, wid, floor + 0.85, 0.42, LIVERY.metroRed), // red accent stripe
    ...windowBand(16.0, 0, wid, floor + 1.32, 0.95, LIVERY.glass),
    roofRidge(16.0, 0, wid, roofTop, 0.24, LIVERY.roof),
  ]);
}

function carTrain() {
  // one ~15.5 m EMU car (Esko / CityElefant family). LIVERY: white body with a
  // blue band along the window line + grey roof. Bogies are SEPARATE instances.
  const wid = 3.0, floor = 0.6, bodyH = 3.3, roofTop = floor + bodyH;
  return merge([
    boxSection(15.5, wid, bodyH, 0, floor, LIVERY.trainW),
    ...sideBand(14.4, 0, wid, floor + 0.9, 0.5, LIVERY.trainBlue),  // blue band
    ...windowBand(14.0, 0, wid, floor + 1.45, 1.0, LIVERY.glass),
    roofRidge(14.0, 0, wid, roofTop, 0.26, LIVERY.roof),
  ]);
}

function busGeo() {
  // ~12 x 2.55 x 3.2 city bus: body, window band, 2 axles, roof ridge, cab.
  // Tyres sit just outboard of the body sides (halfTrack ≈ wid/2 - tread/2),
  // i.e. flush road wheels, unlike a tram's proud bogies.
  const wid = 2.55, R = 0.5, tread = 0.3, ht = wid / 2 - tread / 2;
  const floor = 0.42, bodyH = 2.55, roofTop = floor + bodyH;
  const winBot = floor + 0.9, winH = 1.05;
  const len = 12;
  return merge([
    boxSection(len, wid, bodyH, 0, floor, LIVERY.busIvory),
    ...sideBand(len - 1.2, 0, wid, floor + 0.02, 0.42, LIVERY.busSkirt), // dark skirt
    ...windowBand(len - 1.6, 0, wid, winBot, winH, LIVERY.glass),
    roofRidge(len - 1.2, 0, wid, roofTop, 0.22, LIVERY.roof),
    ...cabNose(wid, bodyH, floor, len / 2),
    // 2 axles: front inset, rear near the back (4 wheels visible from a flank)
    ...bogie(R, tread, 3.7, ht, 0),    // front axle
    ...bogie(R, tread, -3.7, ht, 0),   // rear axle
  ]);
}

function trolleybusGeo() {
  // bus body + two roof poles angled back to the overhead wire + wheels.
  const tilt = (30 * Math.PI) / 180;
  const wid = 2.55, R = 0.5, tread = 0.3, ht = wid / 2 - tread / 2;
  const floor = 0.42, bodyH = 2.55, roofTop = floor + bodyH;
  const winBot = floor + 0.9, winH = 1.05;
  const len = 12;
  return merge([
    boxSection(len, wid, bodyH, 0, floor, LIVERY.busIvory),
    ...sideBand(len - 1.2, 0, wid, floor + 0.02, 0.42, LIVERY.busSkirt),
    ...windowBand(len - 1.6, 0, wid, winBot, winH, LIVERY.glass),
    roofRidge(len - 1.2, 0, wid, roofTop, 0.22, LIVERY.roof),
    ...cabNose(wid, bodyH, floor, len / 2),
    ...bogie(R, tread, 3.7, ht, 0),
    ...bogie(R, tread, -3.7, ht, 0),
    // two trolley poles from the rear roof, leaning back to the wire (~5.6m up)
    pole(0.045, 3.0, -3.0,  0.25 + roofTop, tilt),
    pole(0.045, 3.0, -3.4, -0.0 + roofTop, tilt),
  ]);
}

function ferryGeo() {
  // ~22 x 6 x 2.7 — long hull, raised deckhouse, tapered dark bow read.
  // No wheels: the hull bottom sits on z=0 (the water plane).
  const wid = 6.0;
  const parts = [
    boxSection(20, wid, 1.5, 0, 0, BODY),             // hull
    boxSection(2.4, wid * 0.55, 1.5, 9.6, 0, NOSE),   // bow (tapered, dark)
    boxSection(9, wid * 0.78, 1.2, -2.5, 1.5, BODY),  // deckhouse
  ];
  // cabin window band on the deckhouse flanks
  parts.push(...windowBand(8, -2.5, wid * 0.78, 1.5 + 0.4, 0.6));
  parts.push(roofRidge(8, -2.5, wid * 0.78, 1.5 + 1.2, 0.25));
  return merge(parts);
}

function funicularGeo() {
  // Petřín-style stepped car ~15 x 3 x 3.2 on an incline. Wheels on z=0.
  const wid = 3.0, R = 0.3, tread = 0.24, ht = 1.1;
  const floor = 0.34, bodyH = 2.7, roofTop = floor + bodyH;
  const winBot = floor + 1.05, winH = 1.05;
  const len = 14;
  return merge([
    boxSection(len, wid, bodyH, 0, floor, BODY),
    ...windowBand(len - 1, 0, wid, winBot, winH),
    roofRidge(len - 1, 0, wid, roofTop, 0.22),
    ...cabNose(wid, bodyH, floor, len / 2),
    ...bogie(R, tread, 4.5, ht, 1.4),
    ...bogie(R, tread, -4.5, ht, 1.4),
  ]);
}

function cableCarGeo() {
  // cablecar / gondola: a small suspended cabin under a hanger + a haul-rope
  // grip on top. ~5 x 2.2 x 2.6. No ground wheels; cabin floats on its hanger.
  const wid = 2.2, len = 5;
  const floor = 0.6, bodyH = 2.2, roofTop = floor + bodyH;
  const parts = [
    boxSection(len, wid, bodyH, 0, floor, BODY),
    ...windowBand(len - 0.6, 0, wid, floor + 0.5, 1.1),
    roofRidge(len - 0.6, 0, wid, roofTop, 0.2),
  ];
  // hanger arm + grip up to the cable line (grey rig)
  parts.push(box(0.14, 0.14, 1.0, 0, 0, roofTop, RIG));       // hanger post
  parts.push(box(1.4, 0.18, 0.18, 0, 0, roofTop + 1.0, RIG)); // grip clamp
  return merge(parts);
}

function genericGeo() {
  // 'other': tidy generic short box ~10 x 2.5 x 3.0 with a window band + cab.
  const wid = 2.5, len = 9, R = 0.34, tread = 0.24, ht = wid / 2 - 0.2;
  const floor = 0.45, bodyH = 2.5, roofTop = floor + bodyH;
  return merge([
    boxSection(len, wid, bodyH, 0, floor, BODY),
    ...windowBand(len - 1, 0, wid, floor + 0.85, 1.05),
    roofRidge(len - 1, 0, wid, roofTop, 0.2),
    ...cabNose(wid, bodyH, floor, len / 2),
    ...bogie(R, tread, 3.0, ht, 0),
    ...bogie(R, tread, -3.0, ht, 0),
  ]);
}

// Per-mode layout: how many cars and their centre-to-centre spacing (m) along the
// track. Multi-car modes (tram/metro/train) are ARTICULATED — each car placed at
// its own point on the shape. Single-unit modes (bus/etc.) are one rigid mesh
// (short enough that a curve never bends them visibly). `build` makes ONE unit.
// `truckHalf` = distance (m) from a car's CENTRE to each of its two trucks
// (bogies / axles), matching the bogie X-offsets in the builders above. The 3D
// layer orients each car body by the CHORD between its two trucks (front + rear
// sampled along the track), so the body rotates gently through a curve like a
// real rail car — the trucks absorb the angle, the body never snaps to the
// instantaneous tangent. Mirrors the ±bogie positions in each car builder.
// `cars` here is the model's REAL section/unit count — NOT a global constant.
// classifyModel() routes each vehicle to the class matching its rolling-stock
// model, so a 1-body Tatra T3, a 3-section 15T, a 5-module 14T and a 3-part KT8
// each render with the right number of bodies. (Train consist length isn't in the
// PID feed, so train uses a representative EMU length; metro is a genuinely-fixed
// 5-car train on every Prague line.)
const LAYOUT = {
  tram:       { cars: 3, spacing: 10.0, truckHalf: 2.9, build: carTram },     // Škoda 15T — 3 sections
  tram_t3:    { cars: 1, spacing: 0,    truckHalf: 2.6, build: carTramT3 },    // Tatra T3 — 1 car
  tram_kt8:   { cars: 3, spacing: 9.3,  truckHalf: 2.9, build: carTramKT8 },   // Tatra KT8D5 — 3 sections
  tram_14t:   { cars: 5, spacing: 5.9,  truckHalf: 1.9, build: carTram14t },   // Škoda 14T — 5 modules
  metro:      { cars: 5, spacing: 19.5, truckHalf: 5.5, build: carMetro },     // 5-car train (fixed in Prague)
  train:      { cars: 3, spacing: 17.5, truckHalf: 4.5, build: carTrain },     // representative EMU (consist not in feed)
  bus:        { cars: 1, spacing: 0,    truckHalf: 3.7, build: busGeo },
  trolleybus: { cars: 1, spacing: 0,    truckHalf: 3.7, build: trolleybusGeo },
  ferry:      { cars: 1, spacing: 0,    truckHalf: 7.0, build: ferryGeo },
  funicular:  { cars: 1, spacing: 0,    truckHalf: 4.5, build: funicularGeo },
  cablecar:   { cars: 1, spacing: 0,    truckHalf: 1.2, build: cableCarGeo },
  gondola:    { cars: 1, spacing: 0,    truckHalf: 1.2, build: cableCarGeo },
  other:      { cars: 1, spacing: 0,    truckHalf: 3.0, build: genericGeo },
};

// footprintMeters mirrors the modeled body envelope (incl. roof rig / poles in
// height where they dominate the silhouette). Metadata for the consumer.
const FOOTPRINTS = {
  tram: { len: 31, wid: 2.5, hgt: 3.9 },
  tram_t3: { len: 14, wid: 2.5, hgt: 3.3 },
  tram_kt8: { len: 30, wid: 2.5, hgt: 3.5 },
  tram_14t: { len: 30, wid: 2.5, hgt: 3.5 },
  metro: { len: 80, wid: 2.55, hgt: 3.6 },
  train: { len: 79, wid: 3.0, hgt: 4.3 },
  bus: { len: 12, wid: 2.55, hgt: 3.2 },
  trolleybus: { len: 12, wid: 2.55, hgt: 6.1 },
  ferry: { len: 22, wid: 6.0, hgt: 2.7 },
  funicular: { len: 15, wid: 3.0, hgt: 3.2 },
  cablecar: { len: 5, wid: 2.2, hgt: 3.8 },
  gondola: { len: 5, wid: 2.2, hgt: 3.8 },
  other: { len: 10, wid: 2.5, hgt: 3.0 },
};

// The canonical mode list vehicles3d.js iterates to build one InstancedMesh each.
export const MODES = Object.keys(LAYOUT);

// classifyModel(props) -> a LAYOUT key (a "silhouette class"), so vehicles of the
// same MODE but different real models can render distinct shapes. Today only the
// classic Tatra T3 family splits off (short single high-floor car) from the modern
// low-floor artics; every other vehicle maps straight to its mode (unchanged). The
// model string comes from the feed (worker getModel / seznam); null -> default.
export function classifyModel(props) {
  const mode = (props && props.mode) || 'other';
  if (mode === 'tram') {
    const m = (props && props.model) || '';
    if (/KT8/i.test(m)) return 'tram_kt8';                       // 3-section high-floor artic
    if (/14\s*T/i.test(m)) return 'tram_14t';                    // Škoda 14T — 5 short modules
    if (/\bT3\b|T3R|T3M|T3SU|\bT1\b|\bT6/i.test(m)) return 'tram_t3'; // classic short single car
    return 'tram';                                               // Škoda 15T (default modern low-floor)
  }
  return mode;
}

// Modes whose geometry bakes a REAL livery (full RGB vertex colors). vehicles3d.js
// renders these with a WHITE instanceColor so the baked paint shows exactly (not
// tinted by the line color). Every other mode stays line-color-tinted (white body
// vertices × instanceColor = line color).
const LIVERIED = new Set(['tram', 'tram_t3', 'tram_kt8', 'tram_14t', 'metro', 'train', 'bus', 'trolleybus']);
export function isLiveried(mode) { return LIVERIED.has(mode); }

/**
 * proceduralMeshProvider() — v1 mesh source.
 * Geometries/materials are built lazily on first getModeAsset(mode) and cached,
 * so unused modes cost nothing. One shared MeshLambertMaterial per mode
 * (vertexColors=true so the baked window/wheel/nose shades read; per-instance
 * instanceColor tints the body — applied by vehicles3d.js, never here).
 */
export function proceduralMeshProvider() {
  const cache = new Map();
  const bogieCache = new Map();   // mode -> { geometry, material } | null  (rail modes only)
  let lightAsset = null;          // shared head/tail emissive asset (lazy)
  let haloAsset = null;           // shared ground punctuality-halo disc (lazy)
  return {
    getModeAsset(mode) {
      const key = LAYOUT[mode] ? mode : 'other';
      let asset = cache.get(key);
      if (!asset) {
        const geometry = LAYOUT[key].build();
        const material = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
        asset = {
          geometry,
          material,
          layout: { cars: LAYOUT[key].cars, spacing: LAYOUT[key].spacing, truckHalf: LAYOUT[key].truckHalf },
          footprintMeters: FOOTPRINTS[key],
          liveried: LIVERIED.has(key),  // bake-true livery -> render with white instanceColor
        };
        cache.set(key, asset);
      }
      return asset;
    },

    // OPTIONAL (additive to the swap seam): a standalone pivoting-bogie asset for
    // rail modes, or null for road/water/cable modes that don't get separate
    // bogies. vehicles3d.js feature-detects this — a glTF provider may implement
    // it (real bogie node) or omit it (falls back to no separate bogie). Same
    // {geometry, material} shape as a sub-asset; the bogie material is its OWN
    // MeshLambertMaterial (vertexColors:true) and is rendered with WHITE
    // instanceColor so the baked-dark frame/wheels stay near-black on any livery.
    getBogieAsset(mode) {
      if (!BOGIES[mode]) return null;
      if (bogieCache.has(mode)) return bogieCache.get(mode);
      const b = BOGIES[mode];
      const asset = {
        geometry: bogieUnit(b.track, b.len, b.R, b.tread),
        material: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      };
      bogieCache.set(mode, asset);
      return asset;
    },

    // OPTIONAL (additive): a shared night-mode light asset. headMaterial /
    // tailMaterial are MeshBasicMaterial (UNLIT — always full-bright, so they read
    // as glowing emissive lamps with zero light cost) with vertexColors:true so
    // vehicles3d.js's per-instance instanceColor sets the actual glow tint
    // (warm-white head, dim red tail). ONE quad geometry shared by both.
    getLightAsset() {
      if (lightAsset) return lightAsset;
      // AdditiveBlending so the warm quad reads as an actual GLOW against the dark
      // night basemap (a plain translucent quad just looked like a grey panel and
      // was easy to miss). Additive on the light day basemap would wash out, but
      // lights are only drawn at night — so additive is exactly right here.
      lightAsset = {
        geometry: lightQuad(),
        headMaterial: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending }),
        tailMaterial: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }),
      };
      return lightAsset;
    },

    // Shared ground "halo" disc: a flat translucent circle laid on the ground under
    // each vehicle, tinted per-instance (by vehicles3d) to the SAME punctuality
    // color the 2D dots use — so the 3D fleet carries the on-time/late read the 2D
    // view has. CircleGeometry is authored in XY facing +Z = lies flat on the
    // ground in our frame. ~9 m radius (scaled by the meter→mercator transform).
    getHaloAsset() {
      if (haloAsset) return haloAsset;
      const g = new THREE.CircleGeometry(9, 36);
      g.translate(0, 0, 0.4); // lift a touch off the ground to avoid z-fighting the basemap
      paint(g, BODY); // white base; per-instance instanceColor supplies the tint
      haloAsset = {
        geometry: g,
        material: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.34, depthWrite: false, side: THREE.DoubleSide }),
      };
      return haloAsset;
    },

    dispose() {
      for (const a of cache.values()) { a.geometry.dispose(); a.material.dispose(); }
      cache.clear();
      for (const a of bogieCache.values()) { if (a) { a.geometry.dispose(); a.material.dispose(); } }
      bogieCache.clear();
      if (lightAsset) {
        lightAsset.geometry.dispose();
        lightAsset.headMaterial.dispose();
        lightAsset.tailMaterial.dispose();
        lightAsset = null;
      }
      if (haloAsset) { haloAsset.geometry.dispose(); haloAsset.material.dispose(); haloAsset = null; }
    },
  };
}

// ---------------------------------------------------------------------------
// PHASE-glTF (NOT used in v1, ships zero new packages):
//
//   import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
//
//   export function gltfMeshProvider({ base }) {
//     // manifest absorbs arbitrary export axes WITHOUT touching curState:
//     const MANIFEST = {
//       tram: { glb: 'models/tram.glb', scale: 1, fwdAxisFixDeg: 0 },
//       ... per mode ...
//     };
//     const loader = new GLTFLoader();
//     const fallback = proceduralMeshProvider();
//     const cache = new Map();
//     async function load(mode) {
//       const m = MANIFEST[mode]; if (!m || !base) return fallback.getModeAsset(mode);
//       try {
//         const gltf = await loader.loadAsync(`${base}/${m.glb}`);
//         const geos = []; gltf.scene.traverse(o => o.isMesh && geos.push(o.geometry.clone()));
//         const geometry = mergeGeometries(geos, false); // single geometry => instancing-ready
//         geometry.rotateZ((m.fwdAxisFixDeg * Math.PI) / 180);
//         if (m.scale !== 1) geometry.scale(m.scale, m.scale, m.scale);
//         return { geometry, material: new THREE.MeshLambertMaterial({ vertexColors: true }),
//                  footprintMeters: FOOTPRINTS[mode] || FOOTPRINTS.other };
//       } catch { return fallback.getModeAsset(mode); } // 404/slow => never a blank fleet
//     }
//     // getModeAsset stays synchronous by returning the procedural asset first,
//     // then hot-swapping the InstancedMesh geometry when the glb resolves.
//     // The interface (getModeAsset) is IDENTICAL => one-line swap in main.js.
//     //
//     // getBogieAsset(mode) / getLightAsset() are OPTIONAL on the seam: a glTF
//     // provider may implement them (e.g. a real bogie node split out of the GLB,
//     // a glowing lamp mesh) or simply omit them — vehicles3d.js feature-detects
//     // both (typeof provider.getBogieAsset === 'function' && it returns non-null),
//     // so an asset provider that ships only whole-vehicle GLBs still renders
//     // correctly (body-only, no separate pivoting bogies / lights). Procedural
//     // and glTF stay interchangeable.
//   }
// ---------------------------------------------------------------------------
