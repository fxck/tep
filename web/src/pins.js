// pins.js — floating line-number "pins" hovering above vehicles in 3D mode.
//
// MapLibre symbols sit ON the ground plane (no z-offset on a non-terrain map),
// so they'd overlap the 3D meshes instead of floating above them. Instead we use
// an HTML overlay: a POOLED set of <div> pins, each projected from the vehicle's
// map coordinate to screen via map.project() every frame and offset upward in
// screen space so it floats over the mesh. Crisp text, trivially styleable,
// clickable for select/follow. The pool is reused (no per-frame DOM churn); only
// transform/display/text are touched, all compositor-cheap.
//
// main.js owns WHICH vehicles get a pin (filtered + viewport-culled + capped) and
// calls update() with the already-prepared list each frame.

// Punctuality → hex (same ramp as the 2D veh-halo + the 3D ground halo): unknown
// grey · early azure · on-time green · late amber→orange→red.
function delayHex(dl) {
  if (dl == null) return '#7A8290';
  if (dl < -30) return '#3b9eff';
  if (dl <= 90) return '#2ee68a';
  if (dl <= 210) return '#f5d90a';
  if (dl <= 330) return '#f0820a';
  return '#d2192c';
}
const SHADOW = '0 1px 3px rgba(0,0,0,0.4)';

export function initPins({ map, onSelect, onHover }) {
  const container = document.createElement('div');
  container.id = 'pins';                 // pointer-events:none; pins re-enable it
  (document.getElementById('map') || document.body).appendChild(container);

  const pool = [];
  let activeCount = 0;

  // Place a pin element at its vehicle's CURRENT projected screen position.
  function place(el, d) {
    const p = map.project([d.lon, d.lat]);     // map coord -> screen px
    el.style.transform = `translate(-50%,-100%) translate(${p.x}px, ${p.y - 16}px)`;
  }

  // Reproject every active pin against the map's CURRENT transform. Bound to the
  // map 'render' event (fires synchronously with each canvas paint during pan/zoom/
  // inertia) so pins stay glued to the map instead of lagging the rAF loop — that
  // desync was the jitter. Touches only transforms (compositor-cheap).
  function reproject() {
    for (let i = 0; i < activeCount; i++) { const el = pool[i]; if (el && el._d) place(el, el._d); }
  }
  map.on('render', reproject);

  function acquire(i) {
    let el = pool[i];
    if (!el) {
      el = document.createElement('div');
      el.className = 'pin';
      el.innerHTML = '<b></b>';
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        if (el._id != null && onSelect) onSelect(el._id);
      });
      el.addEventListener('mouseenter', () => { if (onHover) onHover(el._id); });
      el.addEventListener('mouseleave', () => { if (onHover) onHover(null); });
      container.appendChild(el);
      pool[i] = el;
    }
    return el;
  }

  // list: [{ id, lon, lat, line, color, selected }] — already filtered/culled/capped.
  function update(list) {
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const d = list[i];
      const el = acquire(i);
      el._id = d.id;
      el._d = d;                                 // remembered so reproject() can re-place on map render
      place(el, d);
      el.style.display = '';
      if (el._bg !== d.color) { el.style.background = d.color; el.style.setProperty('--pc', d.color); el._bg = d.color; }
      if (el._sel !== d.selected) { el.classList.toggle('sel', !!d.selected); el._sel = d.selected; }
      // Punctuality RING (line color bg + white border + delay-colored outer ring) —
      // the same color language as the 2D dot's halo and the 3D ground halo. Cached
      // by ring color so it only repaints on a punctuality-class change (not /frame).
      const ring = d.selected ? '#ffd400' : delayHex(d.dl);
      if (el._ring !== ring) { el.style.boxShadow = `0 0 0 2px ${ring}, ${SHADOW}`; el._ring = ring; }
      const b = el.firstChild;
      const line = d.line == null ? '' : String(d.line);
      if (b.textContent !== line) b.textContent = line;
    }
    for (let i = n; i < activeCount; i++) pool[i].style.display = 'none';
    activeCount = n;
  }

  function clear() {
    for (let i = 0; i < activeCount; i++) pool[i].style.display = 'none';
    activeCount = 0;
  }

  return { update, clear };
}
