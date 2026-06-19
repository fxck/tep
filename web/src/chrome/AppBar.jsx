import React from 'react';
import {
  Search, Command as CommandIcon, Layers as LayersIcon, Box, SlidersHorizontal,
  BarChart3, History, MoreHorizontal, Share2, Check, RotateCcw, HelpCircle,
} from 'lucide-react';
import { cn } from '../lib/cn.js';
import { useSlice, stats, view, panels, filters, layers, bridge } from '../lib/bridge.js';
import { fmtAge, fmtInt, FILTER_MODES } from '../lib/format.js';
import { useTicker } from '../lib/useTicker.js';
import { LogoMark } from './Logo.jsx';
import LineFilter from './LineFilter.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import { CreditLinks } from './Credit.jsx';
import { Switch } from '../ui/switch.jsx';
import { Slider } from '../ui/slider.jsx';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover.jsx';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '../ui/tooltip.jsx';

function srcMeta(src, conn) {
  if (src === 'golemio') return { word: 'LIVE', source: 'Golemio', tone: 'text-live', live: true };
  if (src === 'demo') return { word: 'DEMO', tone: 'text-warn' };
  return conn
    ? { word: 'connecting…', tone: 'text-muted-foreground' }
    : { word: 'offline', tone: 'text-destructive' };
}

// A thin vertical hairline separating the bar's clusters.
const Divider = ({ className }) => <span aria-hidden className={cn('mx-0.5 h-5 w-px shrink-0 bg-border/70', className)} />;

// Compact 2D / 3D segmented control with a sliding highlight (the active segment
// pill glides between the two). 3D disables-with-tooltip when WebGL2 is absent.
function DimToggle() {
  const v = useSlice(view);
  const is3d = v.render3D;
  const can3d = v.supports3D;
  const seg = (active, label, onClick, disabled) => (
    <button
      type="button"
      aria-pressed={active}
      aria-label={`${label} map`}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'relative z-10 h-7 w-9 rounded-md text-label font-semibold transition-colors duration-200',
        active ? 'text-background' : 'text-muted-foreground hover:text-foreground',
        disabled && 'cursor-not-allowed opacity-40 hover:text-muted-foreground'
      )}
    >
      {label}
    </button>
  );
  const threeD = seg(is3d, '3D', () => bridge.actions.set3D?.(), !can3d);
  return (
    <div role="group" aria-label="Map dimension" className="relative flex items-center rounded-lg bg-surface-2 p-0.5">
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute bottom-0.5 left-0.5 top-0.5 w-9 rounded-md bg-foreground shadow-sm transition-transform duration-200 ease-out',
          is3d ? 'translate-x-9' : 'translate-x-0'
        )}
      />
      {seg(!is3d, '2D', () => bridge.actions.set2D?.(), false)}
      {can3d ? threeD : (
        <Tooltip>
          <TooltipTrigger asChild>{threeD}</TooltipTrigger>
          <TooltipContent>3D needs WebGL2</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

// Icon action button (h-8 w-8). Tooltip-labelled; azure when active; optional badge.
const IconBtn = React.forwardRef(function IconBtn(
  { icon: Icon, label, active, badge, onClick, className, ...rest }, ref
) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label={label}
          aria-pressed={active != null ? !!active : undefined}
          onClick={onClick}
          className={cn(
            'relative grid h-8 w-8 place-items-center rounded-lg transition-all duration-150 active:scale-90',
            active
              ? 'bg-accent text-accent-foreground shadow-sm'
              : 'text-foreground/80 hover:bg-surface-2 hover:text-foreground data-[state=open]:bg-surface-2 data-[state=open]:text-foreground',
            className
          )}
          {...rest}
        >
          <Icon className="h-[18px] w-[18px]" />
          {badge ? (
            <span className="absolute -right-1 -top-1 grid h-4 min-w-[1rem] place-items-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-foreground ring-2 ring-[hsl(var(--surface))]">
              {badge}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
});

function ModeChip({ m, on, onToggle }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => onToggle(!on)}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-label transition-colors',
        on ? 'border-border bg-surface-2 text-foreground' : 'border-transparent text-muted-foreground/50 hover:text-muted-foreground'
      )}
    >
      <i className={cn('h-2 w-2 rounded-full', !on && 'opacity-40')} style={{ background: m.color }} />
      {m.label}
    </button>
  );
}

function LayerRow({ label, checked, onChange, disabled, hint }) {
  return (
    <label className={cn('flex items-center justify-between gap-3 py-1.5 text-body', disabled ? 'cursor-not-allowed opacity-45' : 'cursor-pointer text-foreground/90')}>
      <span className="flex items-center gap-1.5">{label}{disabled && hint ? <span className="text-caption text-muted-foreground">{hint}</span> : null}</span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  );
}

export default function AppBar() {
  const s = useSlice(stats);
  const p = useSlice(panels);
  const f = useSlice(filters);
  const l = useSlice(layers);
  const v = useSlice(view);
  useTicker();
  const m = srcMeta(s.src, s.conn);
  const isLive = m.live && s.conn && !s.stale;   // false while a backgrounded tab catches up, or SSE dropped
  const is3D = v.render3D;

  const [shared, setShared] = React.useState(false);
  const doShare = () => bridge.actions.share?.((ok) => { setShared(ok); setTimeout(() => setShared(false), 1600); });

  const modesOff = FILTER_MODES.filter((mm) => !f.modes[mm.key]).length;
  const filterCount = (f.lines ? f.lines.length : 0) + (modesOff > 0 ? 1 : 0);

  return (
    <TooltipProvider delayDuration={350}>
      {/* A COMPACT floating island — content-width, centred, never a full-width
          strip. Controls collapse to tooltip'd icon buttons so it stays small. */}
      <div
        role="toolbar"
        aria-label="Tep controls"
        className="pointer-events-auto fixed left-1/2 top-3 z-20 flex max-w-[calc(100vw-1.5rem)] -translate-x-1/2 items-center gap-1 rounded-2xl px-2 py-1.5 surface animate-slide-in-up"
        style={{ boxShadow: 'var(--shadow-2)' }}
      >
        {/* Brand + live pulse (count visible; source/age on hover) */}
        <div className="flex shrink-0 items-center gap-2 pl-1.5">
          <button
            type="button"
            aria-label="Reset view"
            onClick={() => (bridge.actions.home || bridge.actions.resetView)?.()}
            className="flex items-center gap-1.5 rounded-lg transition-transform active:scale-95"
          >
            <LogoMark size={18} live={m.live} />
            <span className="text-[15px] font-bold leading-none tracking-tight text-foreground">Tep</span>
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => bridge.actions.goLive?.()}
                aria-label={isLive ? 'Live feed — tap to resync' : 'Paused — tap to go live'}
                className="hidden items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-surface-2 sm:flex"
              >
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', isLive ? 'animate-pulse-dot bg-live' : 'bg-warn')} />
                {isLive
                  ? <span className="tnum text-label font-semibold leading-none text-foreground">{fmtInt(s.count)}</span>
                  : <span className="text-label font-semibold leading-none text-warn">GO LIVE</span>}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {isLive ? (
                <>
                  <span className={cn('font-semibold', m.tone)}>{m.word}</span>
                  {m.source ? <span className="text-muted-foreground"> · {m.source}</span> : null}
                  <span className="text-muted-foreground"> · updated {fmtAge(s.ageMs)}</span>
                </>
              ) : (
                <span className="font-semibold text-warn">Paused — tap to go live</span>
              )}
            </TooltipContent>
          </Tooltip>
        </div>

        <Divider className="hidden sm:block" />

        {/* Search → command palette (compact: icon + label/kbd progressively shown) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => panels.set((st) => ({ ...st, palette: true }))}
              className="flex h-8 shrink-0 items-center gap-2 rounded-lg bg-surface-2 px-2.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <Search className="h-4 w-4 shrink-0" />
              <span className="hidden text-body md:inline">Search</span>
              <span className="hidden shrink-0 items-center gap-0.5 rounded border border-border bg-surface px-1.5 py-0.5 text-caption font-medium lg:inline-flex">
                <CommandIcon className="h-3 w-3" />K
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent>Search lines, stops, vehicles</TooltipContent>
        </Tooltip>

        <Divider className="hidden sm:block" />

        {/* Map controls — compact icon cluster */}
        <div className="flex shrink-0 items-center gap-1">
          <DimToggle />

          {/* Filters */}
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Filters"
                    className={cn(
                      'relative grid h-8 w-8 place-items-center rounded-lg transition-all duration-150 active:scale-90',
                      filterCount
                        ? 'bg-accent text-accent-foreground shadow-sm'
                        : 'text-foreground/80 hover:bg-surface-2 hover:text-foreground data-[state=open]:bg-surface-2 data-[state=open]:text-foreground'
                    )}
                  >
                    <SlidersHorizontal className="h-[18px] w-[18px]" />
                    {filterCount ? (
                      <span className="absolute -right-1 -top-1 grid h-4 min-w-[1rem] place-items-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-foreground ring-2 ring-[hsl(var(--surface))]">{filterCount}</span>
                    ) : null}
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Filters</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-[300px] p-4">
              <div className="mb-2 text-caption uppercase tracking-[0.12em] text-muted-foreground">Modes</div>
              <div className="flex flex-wrap gap-1.5">
                {FILTER_MODES.map((mm) => (
                  <ModeChip key={mm.key} m={mm} on={!!f.modes[mm.key]} onToggle={(on) => bridge.actions.setMode?.(mm.key, on)} />
                ))}
              </div>
              <div className="mb-2 mt-4 text-caption uppercase tracking-[0.12em] text-muted-foreground">Lines</div>
              <LineFilter />
            </PopoverContent>
          </Popover>

          {/* Layers */}
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="Layers"
                    className="grid h-8 w-8 place-items-center rounded-lg text-foreground/80 transition-all duration-150 hover:bg-surface-2 hover:text-foreground active:scale-90 data-[state=open]:bg-surface-2 data-[state=open]:text-foreground"
                  >
                    <LayersIcon className="h-[18px] w-[18px]" />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>Layers</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-[260px] p-4">
              <div className="mb-1 text-caption uppercase tracking-[0.12em] text-muted-foreground">Layers</div>
              <LayerRow label="Aerial photo" checked={l.aerial} hint="beta" onChange={(on) => bridge.actions.setLayer?.('aerial', on)} />
              <LayerRow label="Route lines" checked={l.routes} onChange={(on) => bridge.actions.setLayer?.('routes', on)} />
              <LayerRow label="Stops" checked={l.stops} onChange={(on) => bridge.actions.setLayer?.('stops', on)} />
              <LayerRow label="Delay heatmap" checked={l.heatmap} onChange={(on) => bridge.actions.setLayer?.('heatmap', on)} />
              <LayerRow label="3D buildings" checked={l.buildings && !l.aerial} disabled={!is3D || l.aerial} hint={l.aerial ? 'aerial' : '3D'} onChange={(on) => bridge.actions.setLayer?.('buildings', on)} />
              {is3D && l.buildings && !l.aerial && (
                <div className="mb-1 ml-0.5 mt-1 flex items-center gap-2">
                  <span className="w-[68px] shrink-0 text-caption text-muted-foreground">See-through</span>
                  <Slider
                    className="flex-1"
                    value={[Math.round((l.buildingOpacity ?? 0.30) * 100)]}
                    min={10} max={100} step={5}
                    onValueChange={(vv) => bridge.actions.setBuildingOpacity?.(vv[0] / 100)}
                  />
                  <span className="tnum w-8 shrink-0 text-right text-caption text-muted-foreground">{Math.round((l.buildingOpacity ?? 0.30) * 100)}%</span>
                </div>
              )}
              <LayerRow label="Line pins" checked={l.pins} disabled={!is3D} hint="3D" onChange={(on) => bridge.actions.setLayer?.('pins', on)} />
            </PopoverContent>
          </Popover>

          {/* Insights + Time Machine are both right-side sheets → keep them mutually
              exclusive so they never stack. */}
          <IconBtn
            icon={BarChart3}
            label="Insights"
            active={p.insights}
            onClick={() => {
              const opening = !p.insights;
              panels.set((st) => ({ ...st, insights: !st.insights }));
              if (opening && p.timeMachine) bridge.actions.toggleTimeMachine?.();
            }}
          />
          <IconBtn
            icon={History}
            label="Time Machine"
            active={p.timeMachine}
            onClick={() => {
              const opening = !p.timeMachine;
              bridge.actions.toggleTimeMachine?.();
              if (opening) panels.set((st) => ({ ...st, insights: false }));
            }}
          />

          {/* More */}
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-label="More"
                    className="grid h-8 w-8 place-items-center rounded-lg text-foreground/80 transition-all duration-150 hover:bg-surface-2 hover:text-foreground active:scale-90 data-[state=open]:bg-surface-2 data-[state=open]:text-foreground"
                  >
                    <MoreHorizontal className="h-[18px] w-[18px]" />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>More</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-[210px] p-2">
              <div className="flex items-center justify-between px-2 py-1.5 text-body">
                <span>Theme</span>
                <ThemeToggle />
              </div>
              <button type="button" onClick={doShare} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-body hover:bg-muted/60">
                {shared ? <Check className="h-4 w-4 text-live" /> : <Share2 className="h-4 w-4" />}
                {shared ? 'Link copied' : 'Share this view'}
              </button>
              <button type="button" onClick={() => bridge.actions.resetView?.()} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-body hover:bg-muted/60">
                <RotateCcw className="h-4 w-4" /> Reset bearing &amp; tilt
              </button>
              <button type="button" onClick={() => panels.set((st) => ({ ...st, help: true }))} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-body hover:bg-muted/60">
                <HelpCircle className="h-4 w-4" /> Keyboard shortcuts
              </button>
              <CreditLinks />
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </TooltipProvider>
  );
}
