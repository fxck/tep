import React from 'react';
import { X, MapPin, Accessibility } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { useSlice, stop as stopSlice, bridge } from '../lib/bridge.js';
import { LineBadge } from './LineBadge.jsx';

// StopCard — click a station → its name + a LIVE departure board (Golemio PID
// departureboards, proxied by /api/departures). Left-side floating sheet so it
// clears the app bar (top) and the Insights sheet (right). Auto-refreshes.
function fmtMin(minutes, predicted) {
  if (minutes != null && minutes !== '') return minutes === '<1' ? 'now' : `${minutes} min`;
  if (predicted) {
    const m = Math.round((Date.parse(predicted) - Date.now()) / 60000);
    return m <= 0 ? 'now' : `${m} min`;
  }
  return '—';
}

export default function StopCard() {
  const s = useSlice(stopSlice);
  const [deps, setDeps] = React.useState(null); // null = loading, [] = none, [...] = list
  const [err, setErr] = React.useState(false);
  const name = s && s.name;

  React.useEffect(() => {
    if (!name) return undefined;
    setDeps(null);
    setErr(false);
    const ctrl = new AbortController();
    const base = bridge.helpers.apiBase || '';
    const load = () => {
      fetch(`${base}/api/departures?name=${encodeURIComponent(name)}&limit=12`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => { setDeps(Array.isArray(d.departures) ? d.departures : []); if (d.error || d.disabled) setErr(true); })
        .catch((e) => { if (e.name !== 'AbortError') { setDeps([]); setErr(true); } });
    };
    load();
    const id = setInterval(load, 20000);
    return () => { ctrl.abort(); clearInterval(id); };
  }, [name]);

  if (!name) return null;

  return (
    <div
      className="surface pointer-events-auto fixed left-3 top-[68px] z-30 w-[300px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-2xl"
      style={{ boxShadow: 'var(--shadow-2)' }}
    >
      <div className="flex items-start gap-2 px-4 pt-3.5">
        <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-caption uppercase tracking-wide text-muted-foreground">Station</div>
          <div className="truncate text-title font-semibold leading-tight">{name}</div>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={() => bridge.actions.closeStop?.()}
          className="-mr-1 -mt-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-1 mt-2 max-h-[52vh] overflow-y-auto px-3 pb-3">
        <div className="px-1 pb-1 text-caption uppercase tracking-[0.12em] text-muted-foreground">Departures</div>
        {deps == null && <div className="px-1 py-3 text-body text-muted-foreground">Loading…</div>}
        {deps && deps.length === 0 && (
          <div className="px-1 py-3 text-body text-muted-foreground">
            {err ? 'Arrivals unavailable.' : 'No departures in the next 2 h.'}
          </div>
        )}
        {deps && deps.map((d, i) => (
          <div key={i} className="flex items-center gap-2 rounded-lg px-1 py-1.5 transition-colors hover:bg-surface-2">
            <LineBadge line={d.line} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-body font-medium">{d.headsign || '—'}</div>
              {d.platform && <div className="text-caption text-muted-foreground">platform {d.platform}</div>}
            </div>
            {d.wheel && <Accessibility className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Wheelchair accessible" />}
            <div className="shrink-0 text-right">
              <div className={cn('tnum text-body font-semibold', d.canceled && 'text-destructive line-through')}>
                {d.canceled ? 'cancelled' : fmtMin(d.minutes, d.predicted)}
              </div>
              {!d.canceled && d.delaySec != null && Math.abs(d.delaySec) >= 60 && (
                <div className={cn('tnum text-caption', d.delaySec > 0 ? 'text-warn' : 'text-live')}>
                  {d.delaySec > 0 ? '+' : ''}{Math.round(d.delaySec / 60)}m
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
