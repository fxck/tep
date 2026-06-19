// TimeMachine.jsx — historical replay panel (React chrome over the vanilla replay
// ENGINE in timeMachine.js). Right-side sheet, opened by the AppBar History button
// (panels.timeMachine). Reads the `replay` bridge slice the engine patches and
// dispatches replay* actions back. Two inputs matching the rest of the chrome:
//   • a single-select LINE autocomplete (replay is per-line, server-side)
//   • a proper date+time RANGE picker (ui/daterange.jsx)
// then a transport (play/pause · scrub · speed) once a window is loaded.

import React from 'react';
import { X, Play, Pause, History, Loader2 } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { useSlice, panels, replay as replaySlice, bridge } from '../lib/bridge.js';
import { LineBadge } from './LineBadge.jsx';
import DateRangePicker from '../ui/daterange.jsx';

const pad = (n) => String(n).padStart(2, '0');
function fmtClock(ms) {
  if (!ms) return '--:--:--';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Single-select line autocomplete — same suggestion source + look as the live
// LineFilter, but holds ONE line (replay runs a single line at a time).
function LinePick({ value, onChange }) {
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [hi, setHi] = React.useState(0);
  const inputRef = React.useRef(null);

  const all = React.useMemo(
    () => (bridge.helpers && bridge.helpers.getLines ? bridge.helpers.getLines() : []),
    [open, q],
  );
  const colorOf = (key) => (all.find((e) => e.key === key) || {}).color || '#7A8290';

  const sugg = React.useMemo(() => {
    const qq = q.trim().toUpperCase();
    let pool = all;
    if (qq) {
      pool = pool.filter((e) => e.key.startsWith(qq) || e.key.includes(qq));
      pool.sort((a, b) => (a.key.startsWith(qq) ? 0 : 1) - (b.key.startsWith(qq) ? 0 : 1));
    }
    return pool.slice(0, 8);
  }, [all, q]);

  React.useEffect(() => { setHi(0); }, [q]);

  const pick = (key) => { if (!key) return; onChange(key); setQ(''); setOpen(false); };

  if (value) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-input bg-surface-2/60 p-1.5">
        <LineBadge line={value} color={colorOf(value)} size="sm" />
        <span className="text-label text-muted-foreground">replay this line</span>
        <button
          type="button"
          onClick={() => { onChange(null); setTimeout(() => inputRef.current?.focus(), 0); }}
          aria-label="Clear line"
          className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const p = sugg[hi] || (q.trim() ? { key: q.trim().toUpperCase() } : null); if (p) pick(p.key); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, Math.max(sugg.length - 1, 0))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Escape') { setOpen(false); }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 130)}
        onKeyDown={onKey}
        aria-label="Pick a line to replay"
        placeholder="Pick a line — 22, 9, A, S7…"
        className="w-full rounded-xl border border-input bg-surface-2/60 px-3 py-2 text-label outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
      />
      {open && sugg.length ? (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-60 overflow-auto rounded-xl border border-border/60 bg-surface p-1" style={{ boxShadow: 'var(--shadow-1)' }}>
          {sugg.map((e, i) => (
            <button
              key={e.key}
              type="button"
              onMouseDown={(ev) => { ev.preventDefault(); pick(e.key); }}
              onMouseEnter={() => setHi(i)}
              className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left', i === hi ? 'bg-muted' : 'hover:bg-muted/50')}
            >
              <LineBadge line={e.line} color={e.color} size="sm" />
              <span className="text-label capitalize text-muted-foreground">{e.mode}</span>
              <span className="ml-auto tnum text-caption text-muted-foreground">{e.n}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const SPEEDS = [30, 60, 120, 300];

// Whole-mode replay (replay accepts a `mode` instead of a `line`). Keys match the
// worker's mode strings; colors mirror the map legend so the chips read as "the
// red one = trams" etc.
const MODES = [
  { key: 'tram', label: 'Trams', color: '#D2192C' },
  { key: 'metro', label: 'Metro', color: '#00A562' },
  { key: 'bus', label: 'Buses', color: '#007DA8' },
  { key: 'train', label: 'Trains', color: '#1A66B0' },
  { key: 'trolleybus', label: 'Trolley', color: '#8E44AD' },
];

export default function TimeMachine() {
  const open = useSlice(panels).timeMachine;
  const r = useSlice(replaySlice);
  // Replay target: a single line OR a whole mode. { type:'line'|'mode', key } | null.
  const [sel, setSel] = React.useState(null);
  const [win, setWin] = React.useState(() => { const n = Date.now(); return { from: n - 30 * 60000, to: n }; });

  if (!open) return null;

  const frac = r.loaded && r.to > r.from ? Math.round(((r.vt - r.from) / (r.to - r.from)) * 1000) : 0;

  return (
    <div
      className="surface pointer-events-auto fixed right-3 top-[68px] min-[1400px]:top-3 z-[31] flex w-[360px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl"
      style={{ maxHeight: 'calc(100vh - 84px)', boxShadow: 'var(--shadow-2)' }}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
        <History className="h-5 w-5 text-accent" />
        <div className="flex-1 text-title font-semibold leading-none">Time Machine</div>
        <button type="button" aria-label="Close" onClick={() => bridge.actions.toggleTimeMachine?.()} className="-mr-1 rounded-md p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto px-4 py-3.5">
        <div className="flex flex-col gap-1.5">
          <div className="text-caption uppercase tracking-[0.12em] text-muted-foreground">What to replay</div>
          {/* Whole-mode shortcuts: replay every tram / bus / metro / … at once. */}
          <div className="flex flex-wrap gap-1.5">
            {MODES.map((m) => {
              const active = sel && sel.type === 'mode' && sel.key === m.key;
              return (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setSel(active ? null : { type: 'mode', key: m.key })}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-caption font-semibold transition-colors',
                    active ? 'border-transparent text-white' : 'border-border/60 bg-surface-2/50 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                  style={active ? { backgroundColor: m.color } : undefined}
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: active ? '#fff' : m.color }} />
                  {m.label}
                </button>
              );
            })}
          </div>
          {/* …or a single line. Picking one clears any mode selection, and vice-versa. */}
          <LinePick
            value={sel && sel.type === 'line' ? sel.key : null}
            onChange={(key) => setSel(key ? { type: 'line', key } : null)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="text-caption uppercase tracking-[0.12em] text-muted-foreground">Window</div>
          <DateRangePicker from={win.from} to={win.to} onChange={setWin} />
        </div>

        <button
          type="button"
          disabled={!sel || r.loading}
          onClick={() => bridge.actions.replayLoad?.({
            line: sel && sel.type === 'line' ? sel.key : '',
            mode: sel && sel.type === 'mode' ? sel.key : '',
            from: win.from, to: win.to,
          })}
          className="flex items-center justify-center gap-2 rounded-xl bg-accent px-3 py-2.5 text-body font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {r.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {r.loading ? 'Loading…' : 'Load replay'}
        </button>

        {r.msg ? (
          <div className={cn('text-body', r.err ? 'text-destructive' : 'text-muted-foreground')}>{r.msg}</div>
        ) : null}

        {r.loaded ? (
          <div className="mt-1 flex flex-col gap-2.5 border-t border-border/60 pt-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label={r.playing ? 'Pause' : 'Play'}
                onClick={() => bridge.actions.replayPlayPause?.()}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-foreground transition-colors hover:bg-muted/60"
              >
                {r.playing ? <Pause className="h-4.5 w-4.5" /> : <Play className="h-4.5 w-4.5" />}
              </button>
              <div className="tnum text-title font-bold tracking-tight">{fmtClock(r.vt)}</div>
              <label className="ml-auto flex items-center gap-1.5 text-caption text-muted-foreground">
                speed
                <select
                  value={r.speed}
                  onChange={(e) => bridge.actions.replaySetSpeed?.(Number(e.target.value))}
                  className="rounded-md border border-input bg-surface-2/60 px-1.5 py-1 text-caption text-foreground outline-none"
                >
                  {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
                </select>
              </label>
            </div>

            <input
              type="range" min={0} max={1000} step={1} value={frac}
              onChange={(e) => bridge.actions.replayScrub?.(Number(e.target.value) / 1000)}
              aria-label="Scrub replay"
              className="w-full accent-accent"
            />
            <div className="flex justify-between text-caption tnum text-muted-foreground">
              <span>{fmtClock(r.from)}</span>
              <span>{r.count} of {r.total} active</span>
              <span>{fmtClock(r.to)}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
