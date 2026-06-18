// Analytics.jsx — the flagship right-side analytics drawer for the PID live map.
// A premium React port of the legacy vanilla src/dashboard.js: it mirrors that
// module's exact API calls, window presets, metrics and aggregation, but renders
// a Google-Maps-grade, dense-but-breathable analytics surface.
//
// Lifecycle: opens when useSlice(panels).insights is true; fetches all endpoints
// on open + on window change + every 30s; aborts/clears on close. Zero traffic
// while closed. Each section degrades gracefully (disabled / error -> placeholder),
// never crashing the panel.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Activity, Gauge, Clock, Route, RefreshCw, CalendarClock,
  TrendingUp, Bus, Train, TramFront, Anchor, Layers,
} from 'lucide-react';

import { cn } from '../lib/cn.js';
import { useSlice, panels, stats } from '../lib/bridge.js';
import { MODE_LABELS, MODE_COLORS, fmtInt } from '../lib/format.js';

import { Card, CardHeader, CardTitle, CardContent } from '../ui/card.jsx';
import { Button } from '../ui/button.jsx';
import { Badge } from '../ui/badge.jsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs.jsx';
import { ScrollArea } from '../ui/scroll-area.jsx';
import { Separator } from '../ui/separator.jsx';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
const REFRESH_MS = 30000;

// --- window presets (exactly mirror dashboard.js WIN_PRESETS, API caps applied) -
const WIN_PRESETS = {
  '15m': { winMin: 15, hours: 6, bucketMin: 15 },
  '1h': { winMin: 60, hours: 6, bucketMin: 15 },
  '6h': { winMin: 360, hours: 6, bucketMin: 30 },
  '24h': { winMin: 1440, hours: 24, bucketMin: 60 },
  '7d': { winMin: 1440, hours: 168, bucketMin: 360 },
};
const WIN_KEYS = ['15m', '1h', '6h', '24h', '7d'];

// --- status (attention) scale — aligned to the two-axis system tokens so the
// whole app reads ONE green/amber/red and "early" is azure (red == LATE only).
// Hex (not var()) because these also feed SVG fill attributes. ---------------
const C_EARLY = '#3b9eff';   // azure — running early (matches --status-early)
const C_ONTIME = '#2ec27a';  // green  (matches --status-ontime / --live)
const C_AMBER = '#f0b100';   // amber  (matches --status-late / --warn)
const C_LATE = '#e5484d';    // red    (matches --status-verylate / --destructive)
const C_NEUTRAL = '#7a8290'; // neutral (matches --mode-other) — unknown / inactive

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const modeColor = (m, fallback) => MODE_COLORS[m] || fallback || C_NEUTRAL;
const modeLabel = (m) => MODE_LABELS[m] || m || '—';

function delayColor(sec) {
  if (sec == null) return C_NEUTRAL;
  if (sec < -120) return C_EARLY;
  const a = Math.abs(sec);
  if (a <= 120) return C_ONTIME;
  if (a <= 300) return C_AMBER;
  return C_LATE;
}
function rateColor(r) {
  if (r == null) return C_NEUTRAL;
  if (r >= 0.85) return C_ONTIME;
  if (r >= 0.6) return C_AMBER;
  return C_LATE;
}
function fmtDelay(sec) {
  if (sec == null) return '—';
  if (Math.abs(sec) <= 120) return 'on time';
  const late = sec > 0;
  const a = Math.abs(sec);
  const m = Math.floor(a / 60);
  const s = a % 60;
  const body = m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
  return `${late ? '+' : '−'}${body} ${late ? 'late' : 'early'}`;
}
function fmtDelayShort(sec) {
  if (sec == null) return '—';
  const late = sec >= 0;
  const a = Math.abs(sec);
  const sign = late ? '+' : '−';
  if (a >= 60) return `${sign}${Math.round(a / 60)}m`;
  return `${sign}${a}s`;
}
const pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);

// lucide icon per mode for chips (purely decorative)
const MODE_ICON = {
  tram: TramFront, metro: Train, train: Train, bus: Bus,
  trolleybus: Bus, ferry: Anchor,
};

// =============================================================================
// Data fetching: a single hook keyed on [open, win] mirrors dashboard.js's
// parallel refresh + 30s interval, with one AbortController per cycle.
// =============================================================================
function useAnalytics(open, win) {
  const [data, setData] = useState({});
  const [updatedAt, setUpdatedAt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [punctOrder, setPunctOrder] = useState('worst');

  // keep the latest punctOrder available to the fetch loop without re-keying it
  const orderRef = useRef(punctOrder);
  orderRef.current = punctOrder;

  useEffect(() => {
    if (!open) return undefined;
    const preset = WIN_PRESETS[win] || WIN_PRESETS['1h'];
    const winMin = Math.min(1440, preset.winMin);
    const hours = Math.min(168, preset.hours);
    const bucketMin = preset.bucketMin;

    let ctrl;
    let timer;
    let alive = true;

    const getJSON = async (q, signal) => {
      if (!API_BASE) return null;
      const r = await fetch(`${API_BASE}${q}`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };

    const cycle = async () => {
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      const sig = ctrl.signal;
      setLoading(true);

      const jobs = {
        overview: `/api/analytics/overview`,
        vehicles: `/api/vehicles`,
        punctuality: `/api/analytics/punctuality?window=${winMin}&order=${orderRef.current}&limit=12&minSamples=200`,
        modes: `/api/analytics/modes?window=${winMin}`,
        trend: `/api/analytics/trend?hours=${hours}&bucketMin=${bucketMin}`,
        bunching: `/api/analytics/bunching?window=${winMin}`,
        speed: `/api/analytics/speed?window=${winMin}`,
        stops: `/api/analytics/stop-reliability?window=${winMin}&limit=12`,
        patterns: `/api/analytics/patterns?days=28`,   // temporal baseline (independent of the window)
      };

      const entries = await Promise.all(
        Object.entries(jobs).map(async ([k, q]) => {
          try {
            return [k, { ok: true, d: await getJSON(q, sig) }];
          } catch (err) {
            if (err && err.name === 'AbortError') return [k, null];
            return [k, { ok: false, d: null }];
          }
        })
      );
      if (!alive || sig.aborted) return;
      const next = {};
      for (const [k, v] of entries) if (v) next[k] = v;
      setData(next);
      setUpdatedAt(Date.now());
      setLoading(false);
    };

    cycle();
    timer = setInterval(cycle, REFRESH_MS);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      if (ctrl) ctrl.abort();
    };
    // re-run on open, window, and punctuality order toggle (snappy re-fetch)
  }, [open, win, punctOrder]);

  return { data, updatedAt, loading, punctOrder, setPunctOrder };
}

// =============================================================================
// Small presentational primitives
// =============================================================================
function SectionTitle({ icon: Icon, children, sub }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <div className="flex items-center gap-2">
        {Icon ? <Icon className="h-3.5 w-3.5 text-accent" /> : null}
        <span className="text-sm font-semibold text-foreground">{children}</span>
      </div>
      {sub ? (
        <span className="text-caption uppercase tracking-wide text-muted-foreground">{sub}</span>
      ) : null}
    </div>
  );
}

const LABEL = 'text-caption uppercase tracking-wide text-muted-foreground';

function Warming({ label = 'Analytics warming up…' }) {
  return (
    <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
      <RefreshCw className="mx-auto mb-1.5 h-4 w-4 animate-spin opacity-50" />
      {label}
    </div>
  );
}

function Tile({ label, value, valueColor, bar, barColor, sub, subColor, className, hero }) {
  return (
    <div className={cn('rounded-xl border border-border/50 bg-surface-2/60 p-3.5', className)}>
      <div className={LABEL}>{label}</div>
      <div
        className={cn('mt-1 font-semibold tnum leading-tight', hero ? 'text-display' : 'text-2xl')}
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </div>
      {bar != null ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${clamp01(bar) * 100}%`, background: barColor || C_ONTIME }}
          />
        </div>
      ) : null}
      {sub ? (
        <div className="mt-1.5 text-caption tnum" style={{ color: subColor || C_NEUTRAL }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

// horizontal proportional bar used by fleet + leaderboards
function Bar({ ratio, color }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
      <div
        className="h-full rounded-full"
        style={{ width: `${clamp01(ratio) * 100}%`, background: color }}
      />
    </div>
  );
}

// line "pill" badge using the line's own color as background
function LinePill({ line, color }) {
  return (
    <span
      className="inline-flex min-w-[34px] items-center justify-center rounded-md px-1.5 py-0.5 text-caption font-bold leading-none text-white tnum"
      style={{ background: color || C_NEUTRAL }}
    >
      {line}
    </span>
  );
}

// =============================================================================
// Inline SVG trend sparkline (no chart lib) — p50 line, p90 ghost, ±band, avg
// =============================================================================
function TrendChart({ buckets, onTimeBandSec = 120 }) {
  const W = 360;
  const H = 120;
  const path = useMemo(() => {
    const padL = 4, padR = 4, padT = 8, padB = 16;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    if (!buckets || !buckets.length) return null;

    const xs = buckets.map((b) => b.t);
    const xMin = xs[0];
    const xMax = xs[xs.length - 1];
    const xSpan = (xMax - xMin) || 1;
    const X = (t) => padL + ((t - xMin) / xSpan) * innerW;

    let yLo = -120, yHi = 120;
    for (const b of buckets) {
      for (const v of [b.avgDelaySec, b.p50, b.p90]) {
        if (v == null) continue;
        if (v < yLo) yLo = v;
        if (v > yHi) yHi = v;
      }
    }
    const padY = Math.max(20, (yHi - yLo) * 0.08);
    yLo -= padY; yHi += padY;
    const ySpan = (yHi - yLo) || 1;
    const Y = (v) => padT + (1 - (v - yLo) / ySpan) * innerH;

    const line = (key) =>
      buckets
        .filter((b) => b[key] != null)
        .map((b, i) => `${i ? 'L' : 'M'}${X(b.t).toFixed(1)} ${Y(b[key]).toFixed(1)}`)
        .join(' ');

    const p50Path = line('p50');
    const bandTop = Y(Math.min(onTimeBandSec, yHi));
    const bandBot = Y(Math.max(-onTimeBandSec, yLo));
    const zeroY = Y(0);
    const areaPath = `${p50Path} L${X(xMax).toFixed(1)} ${Y(yLo).toFixed(1)} L${X(xMin).toFixed(1)} ${Y(yLo).toFixed(1)} Z`;

    const tick = (t) => {
      const d = new Date(t);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    const tickPts = [buckets[0], buckets[Math.floor(buckets.length / 2)], buckets[buckets.length - 1]];

    return {
      avg: line('avgDelaySec'),
      p50: p50Path,
      p90: line('p90'),
      area: areaPath,
      band: { x: padL, y: bandTop, w: innerW, h: Math.max(0, bandBot - bandTop) },
      zeroY,
      ticks: tickPts.map((b, i) => ({
        x: X(b.t),
        anchor: i === 0 ? 'start' : i === 2 ? 'end' : 'middle',
        label: tick(b.t),
      })),
    };
  }, [buckets, onTimeBandSec]);

  if (!path) return null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="delay trend" className="block">
      <rect x={path.band.x} y={path.band.y} width={path.band.w} height={path.band.h} fill={C_ONTIME} opacity="0.08" />
      <line x1="4" y1={path.zeroY} x2={W - 4} y2={path.zeroY} stroke={C_NEUTRAL} strokeWidth="1" opacity="0.35" strokeDasharray="3 3" />
      <path d={path.area} fill={C_ONTIME} opacity="0.1" />
      <path d={path.p90} fill="none" stroke={C_AMBER} strokeWidth="1.2" opacity="0.5" />
      <path d={path.avg} fill="none" stroke={C_NEUTRAL} strokeWidth="1" opacity="0.55" strokeDasharray="2 2" />
      <path d={path.p50} fill="none" stroke={C_ONTIME} strokeWidth="2" />
      {path.ticks.map((t, i) => (
        <text key={i} x={t.x} y={H - 3} fill={C_NEUTRAL} fontSize="9" textAnchor={t.anchor}>{t.label}</text>
      ))}
    </svg>
  );
}

// On-time RATE over time (0–100%) + service VOLUME (samples) as faint bars behind.
// The dashed line is the window average, so you read each bucket as above/below the
// period's own norm. Same inline-SVG approach as TrendChart (no chart lib).
function RateChart({ buckets }) {
  const W = 360;
  const H = 104;
  const path = useMemo(() => {
    const padL = 4, padR = 4, padT = 10, padB = 16;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    if (!buckets || !buckets.length) return null;
    const xs = buckets.map((b) => b.t);
    const xMin = xs[0], xMax = xs[xs.length - 1];
    const xSpan = (xMax - xMin) || 1;
    const X = (t) => padL + ((t - xMin) / xSpan) * innerW;
    const Y = (v) => padT + (1 - Math.max(0, Math.min(1, v))) * innerH;

    const rateB = buckets.filter((b) => b.onTimeRate != null);
    const rateLine = rateB.map((b, i) => `${i ? 'L' : 'M'}${X(b.t).toFixed(1)} ${Y(b.onTimeRate).toFixed(1)}`).join(' ');
    const area = rateB.length
      ? `${rateLine} L${X(rateB[rateB.length - 1].t).toFixed(1)} ${Y(0).toFixed(1)} L${X(rateB[0].t).toFixed(1)} ${Y(0).toFixed(1)} Z`
      : '';
    const maxN = Math.max(1, ...buckets.map((b) => b.samples || 0));
    const bw = Math.max(1, innerW / buckets.length - 1.5);
    const bars = buckets.map((b) => {
      const h = ((b.samples || 0) / maxN) * (innerH * 0.55);
      return { x: X(b.t) - bw / 2, y: padT + innerH - h, w: bw, h };
    });
    const avg = rateB.length ? rateB.reduce((s, b) => s + b.onTimeRate, 0) / rateB.length : 0;
    const last = rateB.length ? rateB[rateB.length - 1].onTimeRate : null;
    const tick = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    const tp = [buckets[0], buckets[Math.floor(buckets.length / 2)], buckets[buckets.length - 1]];
    return {
      rateLine, area, bars, avgY: Y(avg), avg, last,
      ticks: tp.map((b, i) => ({ x: X(b.t), anchor: i === 0 ? 'start' : i === 2 ? 'end' : 'middle', label: tick(b.t) })),
    };
  }, [buckets]);

  if (!path) return null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="on-time rate over time" className="block">
      {path.bars.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={C_NEUTRAL} opacity="0.16" />
      ))}
      <line x1="4" y1={path.avgY} x2={W - 4} y2={path.avgY} stroke={C_NEUTRAL} strokeWidth="1" opacity="0.4" strokeDasharray="3 3" />
      <path d={path.area} fill={C_ONTIME} opacity="0.12" />
      <path d={path.rateLine} fill="none" stroke={C_ONTIME} strokeWidth="2" />
      {path.ticks.map((t, i) => (
        <text key={i} x={t.x} y={H - 3} fill={C_NEUTRAL} fontSize="9" textAnchor={t.anchor}>{t.label}</text>
      ))}
    </svg>
  );
}

// =============================================================================
// Fleet aggregation (mirrors dashboard.js tallyBy / ledRows behavior)
// =============================================================================
function tallyBy(list, key) {
  const m = new Map();
  for (const v of list) {
    let raw = v && v[key];
    if (raw == null || raw === '') raw = null;
    const k = raw == null ? ' unknown' : String(raw);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()]
    .map(([k, n]) => ({ key: k === ' unknown' ? null : k, n }))
    .sort((a, b) => b.n - a.n);
}

function LedList({ entries, total, topN, colorFn }) {
  const top = entries.slice(0, topN);
  const rest = entries.slice(topN).reduce((s, e) => s + e.n, 0);
  return (
    <div className="space-y-1.5">
      {top.map((e, i) => {
        const ratio = total ? e.n / total : 0;
        const col = (colorFn && colorFn(e)) || C_NEUTRAL;
        const label = e.key == null ? 'Unknown / other' : e.key;
        return (
          <div key={i} className="rounded-md bg-muted/30 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-foreground">
                <i className="h-2 w-2 flex-none rounded-full" style={{ background: col }} />
                <span className="truncate">{label}</span>
              </span>
              <span className="flex-none text-xs font-bold text-foreground tnum">
                {fmtInt(e.n)} <span className="font-medium text-muted-foreground">{pct(ratio)}</span>
              </span>
            </div>
            <div className="mt-1.5">
              <Bar ratio={ratio} color={col} />
            </div>
          </div>
        );
      })}
      {rest > 0 ? (
        <div className="flex items-center justify-between px-2 text-xs text-muted-foreground">
          <span>+{entries.length - topN} more</span>
          <span className="font-semibold tnum">{fmtInt(rest)}</span>
        </div>
      ) : null}
    </div>
  );
}

// =============================================================================
// Section components
// =============================================================================
const NO_CELLS = [];
const DOW_LABELS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];      // 1=Mon … 7=Sun
const DOW_FULL = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Current Prague hour (0–23) + ISO day-of-week (1=Mon … 7=Sun) for the "vs typical".
function pragueNow() {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date());
    const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10) % 24;
    const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    return { hour, dow: map[parts.find((p) => p.type === 'weekday').value] || 1 };
  } catch { const x = new Date(); return { hour: x.getHours(), dow: ((x.getDay() + 6) % 7) + 1 }; }
}

// PATTERNS — the signature temporal view. A 24×7 (hour × weekday) heatmap of the
// on-time rate over the last 28 days + a "now vs a typical <weekday> <hour>"
// comparison (live rate vs this cell's historical baseline). Answers "WHEN does the
// network struggle?" — the thing a live-only readout can't.
function PatternsSection({ res, live }) {
  const d = (res && res.ok && res.d && !res.d.disabled) ? res.d : null;
  const cells = d ? (d.cells || NO_CELLS) : NO_CELLS;
  const grid = useMemo(() => {
    const g = {};
    for (const c of cells) (g[c.dow] || (g[c.dow] = {}))[c.hour] = c;
    return g;
  }, [cells]);

  if (!d) {
    return (
      <div className="space-y-2">
        <SectionTitle icon={CalendarClock} sub="28-day pattern">Patterns</SectionTitle>
        <Warming label="Patterns build from history — warming up" />
      </div>
    );
  }

  const now = pragueNow();
  const typicalCell = grid[now.dow] && grid[now.dow][now.hour];
  const typical = typicalCell ? typicalCell.onTimeRate : null;
  const liveRate = live && live.ok && live.d ? live.d.onTimeRate : null;
  const deltaPP = (typical != null && liveRate != null) ? Math.round((liveRate - typical) * 100) : null;

  return (
    <div className="space-y-3">
      <SectionTitle icon={CalendarClock} sub={`last ${d.days || 28} days`}>Patterns</SectionTitle>

      {deltaPP != null && (
        <Tile
          label={`vs a typical ${DOW_FULL[now.dow]} ${String(now.hour).padStart(2, '0')}:00`}
          value={`${deltaPP > 0 ? '+' : ''}${deltaPP} pp`}
          valueColor={deltaPP >= 0 ? C_ONTIME : C_LATE}
          sub={`now ${pct(liveRate)} on-time · typical ${pct(typical)}`}
        />
      )}

      <div>
        <div className={cn(LABEL, 'mb-1.5')}>On-time rate · hour × weekday</div>
        <div className="space-y-[2px]">
          {[1, 2, 3, 4, 5, 6, 7].map((dow) => (
            <div key={dow} className="grid items-center gap-[2px]" style={{ gridTemplateColumns: '22px repeat(24, 1fr)' }}>
              <span className="text-[10px] tabular-nums text-muted-foreground">{DOW_LABELS[dow]}</span>
              {Array.from({ length: 24 }, (_, h) => {
                const c = grid[dow] && grid[dow][h];
                const isNow = dow === now.dow && h === now.hour;
                return (
                  <div
                    key={h}
                    title={c
                      ? `${DOW_FULL[dow]} ${String(h).padStart(2, '0')}:00 · ${pct(c.onTimeRate)} on-time · ${fmtDelay(c.avgDelaySec)} avg · ${fmtInt(c.samples)} samples`
                      : `${DOW_FULL[dow]} ${String(h).padStart(2, '0')}:00 · no data`}
                    className={cn('h-3 rounded-[2px]', isNow && 'ring-1 ring-foreground')}
                    style={{
                      background: c ? rateColor(c.onTimeRate) : 'hsl(var(--surface-2))',
                      opacity: c ? Math.max(0.2, Math.min(1, c.samples / 800)) : 1,
                    }}
                  />
                );
              })}
            </div>
          ))}
          <div className="grid gap-[2px] pt-0.5" style={{ gridTemplateColumns: '22px repeat(24, 1fr)' }}>
            <span />
            {Array.from({ length: 24 }, (_, h) => (
              <span key={h} className="text-center text-[8px] leading-none text-muted-foreground/70">{h % 6 === 0 ? h : ''}</span>
            ))}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span>worse</span>
          <span className="h-2 w-5 rounded-sm" style={{ background: C_LATE }} />
          <span className="h-2 w-5 rounded-sm" style={{ background: C_AMBER }} />
          <span className="h-2 w-5 rounded-sm" style={{ background: C_ONTIME }} />
          <span>better · faint = few samples</span>
        </div>
      </div>
    </div>
  );
}

function OverviewSection({ res }) {
  if (!res || !res.ok || !res.d || res.d.disabled) {
    return (
      <div className="space-y-2">
        <SectionTitle icon={Activity} sub="live">Overview</SectionTitle>
        <Warming label="Analytics warming up — history not yet available" />
      </div>
    );
  }
  const d = res.d;
  return (
    <div className="space-y-3">
      <SectionTitle icon={Activity} sub={`last ${d.windowMin || 15}m`}>Overview</SectionTitle>
      {/* HERO: punctuality is the emotional headline. (The canonical LIVE vehicle
          count lives once in the Wisp; it is intentionally NOT repeated here — the
          old "Vehicles now" tile showed a different 60s-window metric and read as a
          bug next to the header count.) */}
      <Tile
        hero
        label="On-time rate"
        value={pct(d.onTimeRate)}
        valueColor={rateColor(d.onTimeRate)}
        bar={d.onTimeRate}
        barColor={rateColor(d.onTimeRate)}
        sub={d.delaySamples != null ? `${fmtInt(d.delaySamples)} samples · ±${d.onTimeBandSec || 120}s band · last ${d.windowMin || 15}m` : ''}
      />
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Avg delay" value={fmtDelay(d.avgDelaySec)} valueColor={delayColor(d.avgDelaySec)} />
        <Tile label="Median delay" value={fmtDelay(d.medianDelaySec)} valueColor={delayColor(d.medianDelaySec)} />
        <Tile label="Active lines" value={fmtInt(d.activeLines)} sub={`${fmtInt(d.activeModes)} modes`} />
        <Tile label="Position pings today" value={fmtInt(d.fixesToday)} sub={d.fixesTotal != null ? `${fmtInt(d.fixesTotal)} banked total` : ''} />
      </div>
    </div>
  );
}

function FleetSection({ res }) {
  const list = res && res.ok && res.d && Array.isArray(res.d.v) ? res.d.v : null;
  const agg = useMemo(() => {
    if (!list || !list.length) return null;
    // Model is only known for trams (fleet-number bands); tallying it over the
    // whole fleet made "Unknown / other" ~78% and buried the real models. Scope
    // the model breakdown to trams, where it's meaningful.
    const trams = list.filter((v) => v.mode === 'tram');
    return {
      byModel: tallyBy(trams, 'model'),
      byOp: tallyBy(list, 'op'),
      byMode: tallyBy(list, 'mode'),
      total: list.length,
      tramTotal: trams.length,
    };
  }, [list]);

  if (!agg) {
    return (
      <div className="space-y-2">
        <SectionTitle icon={Layers} sub="live snapshot">Fleet spotter</SectionTitle>
        <Warming label="No live fleet snapshot yet…" />
      </div>
    );
  }
  const { byModel, byOp, byMode, total, tramTotal } = agg;
  const modelColorFn = () => modeColor('tram');
  const distinctModels = byModel.filter((e) => e.key != null).length;

  return (
    <div className="space-y-3">
      <SectionTitle icon={Layers} sub="by model">Fleet spotter</SectionTitle>
      {/* proportional mode split bar */}
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted/60">
        {byMode.map((e, i) => {
          const col = e.key ? modeColor(e.key) : C_NEUTRAL;
          const w = total ? (e.n / total) * 100 : 0;
          return <i key={i} title={`${modeLabel(e.key)} ${e.n}`} className="h-full" style={{ width: `${w}%`, background: col }} />;
        })}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {byMode.map((e, i) => {
          const col = e.key ? modeColor(e.key) : C_NEUTRAL;
          return (
            <span key={i} className="inline-flex items-center gap-1.5 rounded-full border bg-background/40 px-2 py-0.5 text-caption font-medium" style={{ borderColor: col }}>
              <i className="h-2 w-2 rounded-full" style={{ background: col }} />
              {modeLabel(e.key)}
              <b className="tnum text-foreground">{fmtInt(e.n)}</b>
            </span>
          );
        })}
      </div>
      <div className={LABEL}>Tram fleet by model</div>
      <LedList entries={byModel} total={tramTotal} topN={6} colorFn={modelColorFn} />
      <div className={LABEL}>Operators</div>
      <LedList entries={byOp} total={total} topN={5} colorFn={() => '#7f8fa6'} />
      <div className="text-caption text-muted-foreground">
        <b className="tnum text-foreground">{fmtInt(total)}</b> vehicles live ·{' '}
        <b className="tnum text-foreground">{fmtInt(distinctModels)}</b> tram models
      </div>
    </div>
  );
}

function PunctualitySection({ res, order, setOrder, winMin }) {
  const lines = res && res.ok && res.d && !res.d.disabled && Array.isArray(res.d.lines) ? res.d.lines : null;
  const head = (
    <div className="flex items-center justify-between gap-2">
      <SectionTitle icon={Gauge} sub={`${winMin}m`}>Punctuality</SectionTitle>
      <div className="inline-flex overflow-hidden rounded-md border border-border/60 text-caption">
        {['worst', 'best'].map((o) => (
          <button
            key={o}
            type="button"
            onClick={() => setOrder(o)}
            className={cn(
              'px-2 py-0.5 font-semibold capitalize transition-colors',
              order === o ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/50'
            )}
          >
            {o}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <div className="space-y-2">
      {head}
      {!lines || !lines.length ? (
        <Warming />
      ) : (
        <div className="space-y-1">
          {lines.map((l, i) => {
            const c = modeColor(l.mode, l.color);
            const rc = rateColor(l.onTimeRate);
            return (
              <div key={i} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/30">
                <LinePill line={l.line} color={c} />
                <div className="min-w-0">
                  <Bar ratio={l.onTimeRate} color={rc} />
                  <div className="mt-0.5 truncate text-caption text-muted-foreground tnum">
                    {modeLabel(l.mode)} · p90 {fmtDelayShort(l.p90DelaySec)} · {fmtInt(l.samples)} obs
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs font-bold tnum" style={{ color: rc }}>{pct(l.onTimeRate)}</div>
                  <div className="text-caption font-semibold tnum" style={{ color: delayColor(l.medianDelaySec) }}>
                    {fmtDelayShort(l.medianDelaySec)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModesSection({ res, winMin }) {
  const modes = res && res.ok && res.d && !res.d.disabled && Array.isArray(res.d.modes) ? res.d.modes : null;
  return (
    <div className="space-y-2">
      <SectionTitle icon={TrendingUp} sub={`${winMin}m`}>By mode</SectionTitle>
      {!modes || !modes.length ? (
        <Warming />
      ) : (
        <div className="space-y-1.5">
          {modes.map((m, i) => {
            const c = modeColor(m.mode, m.color);
            return (
              <div key={i} className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2 py-1.5">
                <span className="flex items-center gap-1.5 text-xs font-semibold">
                  <i className="h-2 w-2 rounded-full" style={{ background: c }} />
                  {modeLabel(m.mode)}
                </span>
                <span className="text-caption text-muted-foreground tnum">
                  <b className="text-foreground">{fmtInt(m.vehiclesNow)}</b> now ·{' '}
                  <span style={{ color: rateColor(m.onTimeRate) }}>{pct(m.onTimeRate)}</span> ·{' '}
                  <span style={{ color: delayColor(m.medianDelaySec) }}>{fmtDelayShort(m.medianDelaySec)}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TrendSection({ res, hours }) {
  const d = res && res.ok && res.d && !res.d.disabled ? res.d : null;
  const hasBuckets = d && Array.isArray(d.buckets) && d.buckets.length;
  const rateStats = useMemo(() => {
    if (!hasBuckets) return null;
    const rb = d.buckets.filter((b) => b.onTimeRate != null);
    if (!rb.length) return null;
    const avg = rb.reduce((s, b) => s + b.onTimeRate, 0) / rb.length;
    return { avg, now: rb[rb.length - 1].onTimeRate };
  }, [d, hasBuckets]);
  return (
    <div className="space-y-2">
      <SectionTitle icon={TrendingUp} sub={`last ${hours}h`}>Trends over time</SectionTitle>
      {!hasBuckets ? (
        <Warming />
      ) : (
        <div className="space-y-3">
          {/* On-time rate over time — the headline metric as history, not a snapshot. */}
          <div className="rounded-lg border border-border/50 bg-muted/30 p-2">
            <div className="mb-1 flex items-center justify-between px-0.5">
              <span className="text-caption font-medium text-foreground">On-time rate over time</span>
              {rateStats ? (
                <span className="tnum text-caption text-muted-foreground">
                  now <b className="text-foreground">{Math.round(rateStats.now * 100)}%</b> · avg {Math.round(rateStats.avg * 100)}%
                </span>
              ) : null}
            </div>
            <RateChart buckets={d.buckets} />
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
              <span className="flex items-center gap-1"><i className="h-1.5 w-3 rounded" style={{ background: C_ONTIME }} />on-time %</span>
              <span className="flex items-center gap-1"><i className="h-1.5 w-3 rounded" style={{ background: C_NEUTRAL, opacity: 0.5 }} />service volume</span>
              <span className="ml-auto">dashed = period avg</span>
            </div>
          </div>

          {/* Delay distribution over time (median / p90 / avg). */}
          <div className="rounded-lg border border-border/50 bg-muted/30 p-2">
            <div className="mb-1 px-0.5 text-caption font-medium text-foreground">Delay over time</div>
            <TrendChart buckets={d.buckets} onTimeBandSec={d.onTimeBandSec || 120} />
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
              <span className="flex items-center gap-1"><i className="h-1.5 w-3 rounded" style={{ background: C_ONTIME }} />median</span>
              <span className="flex items-center gap-1"><i className="h-1.5 w-3 rounded" style={{ background: C_AMBER, opacity: 0.7 }} />p90</span>
              <span className="flex items-center gap-1"><i className="h-1.5 w-3 rounded" style={{ background: C_NEUTRAL }} />avg</span>
              <span className="ml-auto">band = on time (±{d.onTimeBandSec || 120}s)</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BunchingSection({ res, winMin }) {
  const raw = res && res.ok && res.d && !res.d.disabled && Array.isArray(res.d.lines) ? res.d.lines : null;
  const lines = useMemo(() => {
    if (!raw) return null;
    return raw.filter((l) => l && l.bunchingScore != null).sort((a, b) => b.bunchingScore - a.bunchingScore).slice(0, 12);
  }, [raw]);
  const maxScore = lines && lines.length ? Math.max(...lines.map((l) => l.bunchingScore)) || 1 : 1;
  return (
    <div className="space-y-2">
      <SectionTitle icon={Route} sub={`worst · ${winMin}m`}>Bunching</SectionTitle>
      {!lines || !lines.length ? (
        <Warming label="No bunching data yet…" />
      ) : (
        <div className="space-y-1">
          {lines.map((l, i) => {
            const c = modeColor(l.mode, l.color);
            const ratio = clamp01(l.bunchingScore / maxScore);
            const sc = l.bunchingScore >= maxScore * 0.66 ? C_LATE : l.bunchingScore >= maxScore * 0.33 ? C_AMBER : C_ONTIME;
            return (
              <div key={i} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 px-1 py-0.5">
                <LinePill line={l.line} color={c} />
                <div className="min-w-0">
                  <Bar ratio={ratio} color={sc} />
                  <div className="mt-0.5 text-caption text-muted-foreground tnum">{modeLabel(l.mode)} · {fmtInt(l.vehicles)} veh</div>
                </div>
                <div className="text-right text-xs font-bold tnum" style={{ color: sc }}>
                  {Math.round(l.bunchingScore * 100) / 100}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SpeedSection({ res, winMin }) {
  const d = res && res.ok && res.d && !res.d.disabled && Array.isArray(res.d.cells) ? res.d : null;
  const summary = useMemo(() => {
    if (!d || !d.cells.length) return null;
    const speeds = d.cells.map((c) => c.speedKmh).filter((s) => s != null);
    const avg = speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null;
    const max = speeds.length ? Math.round(Math.max(...speeds)) : null;
    return { avg, max, cells: d.cells.length };
  }, [d]);
  return (
    <div className="space-y-2">
      <SectionTitle icon={Gauge} sub={`${winMin}m`}>Speed corridors</SectionTitle>
      {!summary ? (
        <Warming label="No speed data yet…" />
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <Tile label="Mean km/h" value={summary.avg != null ? summary.avg : '—'} />
          <Tile label="Peak km/h" value={summary.max != null ? summary.max : '—'} />
          <Tile label="Cells" value={fmtInt(summary.cells)} />
          <div className="col-span-3">
            <div className="h-1.5 w-full rounded-full" style={{ background: 'linear-gradient(90deg,#c0392b 0%,#f0b100 45%,#2ecc71 100%)' }} />
            <div className="mt-1 flex justify-between text-caption text-muted-foreground"><span>slow</span><span>fast</span></div>
          </div>
        </div>
      )}
    </div>
  );
}

function StopsSection({ res, winMin }) {
  const stops = res && res.ok && res.d && !res.d.disabled && Array.isArray(res.d.stops) ? res.d.stops : null;
  const ranked = useMemo(() => {
    if (!stops) return null;
    return [...stops].filter((s) => s && s.onTimeRate != null).sort((a, b) => a.onTimeRate - b.onTimeRate).slice(0, 12);
  }, [stops]);
  const disabled = res && res.ok && res.d && res.d.disabled;
  return (
    <div className="space-y-2">
      <SectionTitle icon={Clock} sub={`least reliable · ${winMin}m`}>Stop reliability</SectionTitle>
      {disabled ? (
        <Warming label="No stop data yet…" />
      ) : !ranked || !ranked.length ? (
        <Warming label="Accruing per-stop history…" />
      ) : (
        <div className="space-y-0.5">
          {ranked.map((s, i) => {
            const rc = rateColor(s.onTimeRate);
            return (
              <div key={i} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-1 py-1 text-xs">
                <span className="min-w-0 truncate font-semibold text-foreground">
                  {s.stopId} <span className="text-caption font-medium text-muted-foreground tnum">{fmtInt(s.samples)} obs</span>
                </span>
                <span className="text-right font-bold tnum" style={{ color: rc }}>{pct(s.onTimeRate)}</span>
                <span className="text-right font-semibold tnum" style={{ color: delayColor(s.avgDelaySec) }}>{fmtDelayShort(s.avgDelaySec)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// "updated Ns ago" ticker
// =============================================================================
function useAgo(updatedAt) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!updatedAt) return 'idle';
  const s = Math.round((Date.now() - updatedAt) / 1000);
  return s <= 1 ? 'updated just now' : `updated ${s}s ago`;
}

// =============================================================================
// Root component
// =============================================================================
export default function Analytics() {
  const p = useSlice(panels);
  const live = useSlice(stats);
  const open = !!p.insights;
  const [win, setWin] = useState('1h');

  const { data, updatedAt, punctOrder, setPunctOrder } = useAnalytics(open, win);
  const ago = useAgo(updatedAt);

  const preset = WIN_PRESETS[win] || WIN_PRESETS['1h'];
  const winMin = Math.min(1440, preset.winMin);
  const hours = Math.min(168, preset.hours);

  const close = () => panels.set((s) => ({ ...s, insights: false }));

  // Esc to close while open
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <aside
      className={cn(
        'pid-ui surface animate-slide-in-right',
        'fixed right-3 top-[68px] bottom-3 z-30 flex w-[400px] max-w-[94vw] flex-col overflow-hidden rounded-2xl',
        'pointer-events-auto'
      )}
      style={{ boxShadow: 'var(--shadow-2)' }}
      role="complementary"
      aria-label="Insights"
    >
      {/* Header — title + data freshness only. The live VEHICLE count is canonical
          in the Wisp and intentionally not repeated here (it was a third, differing
          number before). */}
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-5 py-3.5">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-accent" />
            <h2 className="text-title leading-none text-foreground">Insights</h2>
          </div>
          <span className="mt-1 text-caption text-muted-foreground tnum">{ago}</span>
        </div>
        <Button variant="ghost" size="icon" onClick={close} aria-label="Close insights" title="Close (Esc)">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Window selector */}
      <div className="border-b border-border/60 px-4 py-2.5">
        <Tabs value={win} onValueChange={setWin}>
          <TabsList className="grid w-full grid-cols-5">
            {WIN_KEYS.map((k) => (
              <TabsTrigger key={k} value={k} className="text-xs">{k}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* Body */}
      <ScrollArea className="flex-1">
        <div className="space-y-4 px-4 py-4">
          {!API_BASE ? (
            <Warming label="No API configured" />
          ) : (
            <>
              <OverviewSection res={data.overview} />
              <Separator />
              <PatternsSection res={data.patterns} live={data.overview} />
              <Separator />
              <FleetSection res={data.vehicles} />
              <Separator />
              <PunctualitySection res={data.punctuality} order={punctOrder} setOrder={setPunctOrder} winMin={winMin} />
              <Separator />
              <BunchingSection res={data.bunching} winMin={winMin} />
              <Separator />
              <ModesSection res={data.modes} winMin={winMin} />
              <Separator />
              <SpeedSection res={data.speed} winMin={winMin} />
              <Separator />
              <TrendSection res={data.trend} hours={hours} />
              <Separator />
              <StopsSection res={data.stops} winMin={winMin} />
            </>
          )}
        </div>
      </ScrollArea>
    </aside>
  );
}
