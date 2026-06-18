// CommandPalette.jsx — a cmdk spotlight palette over the map.
//
// React port of the legacy commandPalette.js. Open state is the `palette` panel
// slice (driven by useShortcuts via "/" and ⌘/Ctrl-K). Each time it opens we
// build candidates fresh from the live bridge helpers (getFleet / getStops) and
// the engine's registered actions, then let cmdk handle filtering/ranking.
//
// Groups: Actions / Lines / Stops / Vehicles. Empty query shows all actions plus
// the first ~8 lines; cmdk filters the full pool as the user types. Selecting an
// item invokes the relevant bridge action (defensively) and closes the palette.

import { useMemo, useState, useEffect } from 'react';
import {
  Box,
  Map as MapIcon,
  Layers,
  MapPin,
  BarChart3,
  Share2,
  XCircle,
  Compass,
  Crosshair,
  Route,
  Navigation,
  Bus,
} from 'lucide-react';

import { useSlice, panels, bridge } from '../lib/bridge.js';
import { MODE_LABELS } from '../lib/format.js';
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from '../ui/command.jsx';
import { Kbd } from '../ui/kbd.jsx';

// Defensive action invoker.
function call(name, ...args) {
  const fn = bridge.actions && bridge.actions[name];
  if (typeof fn === 'function') {
    try { fn(...args); } catch { /* host action must not break palette */ }
  }
}

// Iterate a fleet that may be a Map or a plain iterable; yield vehicle props.
function* fleetProps() {
  let fleet = null;
  try { fleet = bridge.helpers.getFleet ? bridge.helpers.getFleet() : null; } catch { fleet = null; }
  if (!fleet) return;
  const iter = fleet.values ? fleet.values() : fleet;
  for (const v of iter) {
    const p = v && v.props ? v.props : v;
    if (p) yield p;
  }
}

function getStops() {
  try {
    const s = bridge.helpers.getStops ? bridge.helpers.getStops() : null;
    return Array.isArray(s) ? s : [];
  } catch { return []; }
}

// A colored line badge (line color comes from the engine, not the theme).
function LineBadge({ line, color }) {
  return (
    <span
      className="inline-flex min-w-[24px] items-center justify-center rounded-md px-1.5 py-0.5 text-[11px] font-extrabold text-white"
      style={{ backgroundColor: color || '#7A8290' }}
    >
      {line}
    </span>
  );
}

// Result caps. The whole point: NEVER mount the full ~1500-vehicle / ~19k-stop
// pools into the DOM. We filter by the live query in plain JS and render at most
// this many of each — cmdk's own filtering is turned OFF (shouldFilter=false) so
// it never holds the full set either.
const MAX_VEH = 30;
const MAX_STOPS = 30;
const MAX_LINES = 10;

// Does a haystack contain every whitespace-separated token of the query?
function matchesTokens(hay, tokens) {
  for (let i = 0; i < tokens.length; i++) if (hay.indexOf(tokens[i]) === -1) return false;
  return true;
}

// Static action set. `kw` is the searchable keyword string; `run` uses the
// module-level bridge/panels and is invoked through runAction (which closes first).
const ACTIONS = [
  { kw: 'toggle 3d view', label: 'Toggle 3D', Icon: Box, run: () => call('toggle3D') },
  { kw: '2d view flat map', label: '2D view', Icon: MapIcon, run: () => call('set2D') },
  { kw: '3d view tilt', label: '3D view', Icon: Box, run: () => call('set3D') },
  { kw: 'toggle route lines layer', label: 'Toggle route lines', Icon: Route, run: () => call('setLayer', 'routes', !(bridge.layers.get()?.routes)) },
  { kw: 'toggle stops layer', label: 'Toggle stops', Icon: MapPin, run: () => call('setLayer', 'stops', !(bridge.layers.get()?.stops)) },
  { kw: 'open insights dashboard analytics', label: 'Open insights', Icon: BarChart3, run: () => panels.set((s) => ({ ...s, insights: true })) },
  { kw: 'share view copy link', label: 'Share view', Icon: Share2, run: () => call('share') },
  { kw: 'clear selection', label: 'Clear selection', Icon: XCircle, run: () => call('clearSelection') },
  { kw: 'reset view camera north flat', label: 'Reset view', Icon: Compass, run: () => call('resetView') },
  { kw: 'follow selected vehicle', label: 'Follow vehicle', Icon: Crosshair, run: () => call('toggleFollow') },
];

export default function CommandPalette() {
  const open = useSlice(panels).palette;
  const [query, setQuery] = useState('');

  const close = () => panels.set((s) => ({ ...s, palette: false }));
  const setOpen = (v) => panels.set((s) => ({ ...s, palette: v }));

  // Reset the query whenever the palette opens, so a stale query never forces a
  // big re-render on the next open.
  useEffect(() => { if (open) setQuery(''); }, [open]);

  // Build candidate pools fresh on every open. We keep a precomputed lowercase
  // search string per item so filtering each keystroke is a cheap substring scan,
  // not a re-derive. Pools are NOT rendered wholesale — they feed the filter below.
  const { lines, stops, vehicles } = useMemo(() => {
    if (!open) return { lines: [], stops: [], vehicles: [] };

    const byLine = new Map();
    const veh = [];
    for (const p of fleetProps()) {
      if (p.line != null && p.line !== '') {
        const key = String(p.line);
        let agg = byLine.get(key);
        if (!agg) {
          agg = { line: p.line, color: p.color, mode: p.mode, n: 0 };
          byLine.set(key, agg);
        }
        agg.n++;
        if (!agg.color && p.color) agg.color = p.color;
      }
      if (p.id != null) {
        const line = p.line == null ? '?' : p.line;
        const hdsg = p.hdsg || '';
        veh.push({
          id: p.id, line, color: p.color, mode: p.mode, hdsg, reg: p.reg,
          _s: `${line} ${hdsg} ${MODE_LABELS[p.mode] || p.mode || ''} ${p.reg || ''}`.toLowerCase(),
        });
      }
    }
    for (const l of byLine.values()) {
      l._s = `line ${l.line} ${MODE_LABELS[l.mode] || l.mode || ''}`.toLowerCase();
    }

    const stopList = [];
    for (const st of getStops()) {
      if (!Array.isArray(st) || st.length < 3) continue;
      const lon = Number(st[0]);
      const lat = Number(st[1]);
      const name = st[2];
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || !name) continue;
      stopList.push({ lon, lat, name: String(name), _s: String(name).toLowerCase() });
    }

    return { lines: Array.from(byLine.values()), stops: stopList, vehicles: veh };
  }, [open]);

  // Manual, capped filtering keyed on the live query. Empty query → a tidy default
  // (just the first few lines; NO vehicles/stops mounted). As the user types we scan
  // the full pools but only ever render up to MAX_* matches each.
  const { linesShown, stopsShown, vehShown } = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return { linesShown: lines.slice(0, MAX_LINES), stopsShown: [], vehShown: [] };
    const tokens = q.split(/\s+/);
    const linesShown = [];
    for (let i = 0; i < lines.length && linesShown.length < MAX_LINES; i++) {
      if (matchesTokens(lines[i]._s, tokens)) linesShown.push(lines[i]);
    }
    const stopsShown = [];
    for (let i = 0; i < stops.length && stopsShown.length < MAX_STOPS; i++) {
      if (matchesTokens(stops[i]._s, tokens)) stopsShown.push(stops[i]);
    }
    const vehShown = [];
    for (let i = 0; i < vehicles.length && vehShown.length < MAX_VEH; i++) {
      if (matchesTokens(vehicles[i]._s, tokens)) vehShown.push(vehicles[i]);
    }
    return { linesShown, stopsShown, vehShown };
  }, [query, lines, stops, vehicles]);

  // Actions are a tiny static set; filter them by the same token match so the
  // Actions group also narrows as you type (cmdk filtering is off).
  const actionsShown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ACTIONS;
    const tokens = q.split(/\s+/);
    return ACTIONS.filter((a) => matchesTokens(a.kw, tokens));
  }, [query]);

  const runAction = (fn) => {
    close();
    // Defer the action a tick so the dialog close animation isn't janky.
    setTimeout(() => { try { fn(); } catch { /* swallow */ } }, 0);
  };

  const nothing = !actionsShown.length && !linesShown.length && !stopsShown.length && !vehShown.length;

  return (
    <CommandDialog open={open} onOpenChange={setOpen} shouldFilter={false}>
      <CommandInput value={query} onValueChange={setQuery} placeholder="Search lines, stops, vehicles, commands…" />
      <CommandList>
        <div className="sr-only" role="status" aria-live="polite">
          {nothing ? 'No matches' : `${actionsShown.length + linesShown.length + stopsShown.length + vehShown.length} results`}
        </div>
        {nothing ? (
          <div className="py-6 text-center text-sm text-muted-foreground">No matches.</div>
        ) : null}

        {actionsShown.length ? (
          <CommandGroup heading="Actions">
            {actionsShown.map((a) => {
              const Icon = a.Icon;
              return (
                <CommandItem
                  key={a.kw}
                  value={a.kw}
                  onSelect={() => runAction(a.run)}
                >
                  <Icon className="text-muted-foreground" />
                  <span>{a.label}</span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}

        {linesShown.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Lines">
              {linesShown.map((l) => {
                const modeLabel = MODE_LABELS[l.mode] || l.mode || '';
                return (
                  <CommandItem
                    key={`line-${l.line}`}
                    value={`line ${l.line} ${modeLabel}`}
                    onSelect={() => runAction(() => call('onPickLine', l.line))}
                  >
                    <LineBadge line={l.line} color={l.color} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">Line {l.line}</span>
                      {(modeLabel || l.n) ? (
                        <span className="truncate text-[11px] text-muted-foreground tnum tabular-nums">
                          {modeLabel}{modeLabel && l.n ? ' · ' : ''}{l.n ? `${l.n} active` : ''}
                        </span>
                      ) : null}
                    </span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        ) : null}

        {stopsShown.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Stops">
              {stopsShown.map((st, i) => (
                <CommandItem
                  key={`stop-${i}-${st.name}`}
                  value={`stop ${st.name}`}
                  onSelect={() => runAction(() => call('flyToStop', st.lon, st.lat))}
                >
                  <MapPin className="text-muted-foreground" />
                  <span className="min-w-0 truncate">{st.name}</span>
                  <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-foreground">Stop</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        ) : null}

        {vehShown.length ? (
          <>
            <CommandSeparator />
            <CommandGroup heading="Vehicles">
              {vehShown.map((v) => {
                const modeLabel = MODE_LABELS[v.mode] || v.mode || 'vehicle';
                return (
                  <CommandItem
                    key={`veh-${v.id}`}
                    value={`vehicle ${v.line} ${v.hdsg} ${modeLabel} ${v.reg || ''}`}
                    onSelect={() => runAction(() => {
                      call('selectVehicle', v.id);
                      call('flyToVehicle', v.id);
                    })}
                  >
                    <LineBadge line={v.line} color={v.color} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">
                        Line {v.line}{v.hdsg ? ` → ${v.hdsg}` : ''}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {modeLabel}{v.reg ? ` · #${v.reg}` : ''}
                      </span>
                    </span>
                    <Navigation className="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        ) : null}
      </CommandList>

      {/* Footer hint row */}
      <div className="flex items-center gap-4 border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd><Kbd>↓</Kbd> navigate
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> select
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd> close
        </span>
        <Bus className="ml-auto h-3.5 w-3.5 opacity-60" />
      </div>
    </CommandDialog>
  );
}
