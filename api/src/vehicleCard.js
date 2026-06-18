// vehicleCard.js — resolve a PID vehicle (operator + evidence number) to its
// seznam-autobusu.cz page and scrape model + photos, cached hard in Valkey.
//
// WHY this is non-trivial: seznam-autobusu.cz keys vehicles by an INTERNAL id,
// NOT the fleet/evidence number we have from the feed (e.g. fleet #9375 lives at
// /vuz/59701). The whole site is a JS-rendered Nette app with no public API; the
// only clean, scriptable resolver is their quick-search GET:
//
//   GET /seznam?dopravce={operatorName}&evc={fleetNumber}&zapujcka=2
//
// On a UNIQUE match it 303-redirects to /vuz/{id}; on an ambiguous fleet number
// (the same number reused across vehicle generations) it lands on a list page.
// We TRUST ONLY the unique case — an ambiguous result returns found:false rather
// than risk showing the wrong vehicle's photos.
//
// Politeness toward a hobby third-party site: identified UA, hard caching
// (30d hits / 2d misses — vehicle identity is static), in-flight dedupe, a small
// concurrency cap, and a per-request timeout. This module NEVER throws to the
// caller; every failure degrades to { found:false }.

const UA = 'PIDLiveMapBot/1.0 (+https://pid.cz; live transit map; non-commercial)';
const ORIGIN = 'https://seznam-autobusu.cz';
const FOTO_HOST = 'foto-busy.eu-central-1.linodeobjects.com';
const TTL_HIT = 2592000;   // 30 days — vehicle identity/photos change rarely
const TTL_MISS = 172800;   // 2 days  — re-probe misses occasionally (new coverage)
const FETCH_TIMEOUT_MS = 6000;
const MAX_CONCURRENT = 3;  // never hammer seznam with more than a few at once
const MAX_PHOTOS = 12;

// Our feed's operator label -> seznam 'dopravce' search name. Only CONFIDENT
// mappings live here; unmapped operators fall back to the raw label (best-effort,
// seznam's operator field is fuzzy). A non-unique / not-found result is graceful.
// DP PRAHA alone is ~57% of vehicles (all trams + metro + many buses).
const OPERATOR_MAP = {
  'DP PRAHA': 'Dopravní podnik hl. m. Prahy',
};

let inflightCount = 0;
const inflight = new Map(); // key -> Promise<result>

const cacheKey = (op, reg) => `seznam:v1:${op}:${reg}`;

// Parse the /vuz/{id} vehicle page: model + operator + fleet from the <title>,
// photo ids from the foto-busy gallery (thumb {id}n.jpg, full {id}.jpg).
function parseVehiclePage(html, finalUrl) {
  const idM = finalUrl.match(/\/vuz\/(\d+)/);
  if (!idM) return null; // not a unique vehicle page
  const id = idM[1];

  let type = null, operator = null, fleet = null;
  const t = html.match(/<title>([^<]*)<\/title>/);
  if (t) {
    // "Vůz {operator} #{fleet} ({type}) | seznam-autobusu.cz"
    const m = t[1].match(/^Vůz\s+(.*?)\s+#(\S+)\s*\(([^)]*)\)/);
    if (m) { operator = m[1].trim(); fleet = m[2].trim(); type = m[3].trim(); }
  }

  const photos = [];
  const seen = new Set();
  const re = new RegExp(FOTO_HOST.replace(/\./g, '\\.') + '\\/(\\d+)n\\.jpg', 'g');
  let pm;
  while ((pm = re.exec(html)) && photos.length < MAX_PHOTOS) {
    const pid = pm[1];
    if (seen.has(pid)) continue;
    seen.add(pid);
    photos.push({ thumb: `https://${FOTO_HOST}/${pid}n.jpg`, full: `https://${FOTO_HOST}/${pid}.jpg` });
  }

  return { id, type, operator, fleet, url: finalUrl, photos };
}

async function fetchFromSeznam(opName, reg) {
  const u = `${ORIGIN}/seznam?dopravce=${encodeURIComponent(opName)}&evc=${encodeURIComponent(reg)}&zapujcka=2`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(u, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'cs' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    if (!res.ok) return { found: false };
    const finalUrl = res.url || '';
    if (!/\/vuz\/\d+/.test(finalUrl)) return { found: false }; // ambiguous list / no match
    const html = await res.text();
    const parsed = parseVehiclePage(html, finalUrl);
    if (!parsed) return { found: false };
    return { found: true, source: 'seznam-autobusu.cz', ...parsed };
  } catch {
    return { found: false };
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/vehicle-card/{reg}?op={operatorLabel}
// reader = ioredis client (cache). Never 5xx; sendJson(res, status, body, cacheSec).
export async function handleVehicleCard(reg, op, reader, sendJson, res) {
  reg = String(reg || '').trim();
  if (!reg || !/^[\w./-]{1,16}$/.test(reg)) return sendJson(res, 400, { error: 'invalid reg' });

  const opName = OPERATOR_MAP[op] || (op ? String(op).trim() : '');
  if (!opName) return sendJson(res, 200, { found: false, reason: 'no-operator' }, 3600);

  const key = cacheKey(opName, reg);

  // 1) cache hit
  try {
    const cached = await reader.get(key);
    if (cached) return sendJson(res, 200, cached, 3600);
  } catch (e) {
    console.error('[api] vehicle-card cache get error:', e.message);
  }

  // 2) coalesce concurrent identical requests
  if (inflight.has(key)) {
    const data = await inflight.get(key);
    return sendJson(res, 200, data, 3600);
  }

  // 3) shed load past the concurrency cap (client can retry; nothing cached yet)
  if (inflightCount >= MAX_CONCURRENT) {
    return sendJson(res, 200, { found: false, reason: 'busy' });
  }

  inflightCount++;
  const p = fetchFromSeznam(opName, reg).finally(() => { inflightCount--; inflight.delete(key); });
  inflight.set(key, p);
  const data = await p;

  // 4) cache (positive long, negative short)
  try {
    await reader.set(key, JSON.stringify(data), 'EX', data.found ? TTL_HIT : TTL_MISS);
  } catch (e) {
    console.error('[api] vehicle-card cache set error:', e.message);
  }

  return sendJson(res, 200, data, 3600);
}
