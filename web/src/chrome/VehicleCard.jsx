import React from 'react';
import { X, Crosshair, Navigation, Snowflake, Usb, Accessibility, MapPin, Gauge, Hash, ExternalLink } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { useSlice, selected, panels, bridge } from '../lib/bridge.js';
import { MODE_LABELS, fmtDelay, fmtEta } from '../lib/format.js';
import { Button } from '../ui/button.jsx';
import { Badge } from '../ui/badge.jsx';
import { Separator } from '../ui/separator.jsx';
import LineBadge from './LineBadge.jsx';

const toneClass = { live: 'text-live', warn: 'text-warn', amber: 'text-warn', muted: 'text-muted-foreground' };
const badgeVariant = { live: 'live', warn: 'warn', amber: 'warn', muted: 'muted' };

function Amenity({ ok, Icon, label }) {
  if (!ok) return null;
  return (
    <span className="flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-1 text-caption text-muted-foreground" title={label}>
      <Icon className="h-3 w-3" />
    </span>
  );
}

// Speech-bubble pointer: a small glass diamond straddling a card edge. `dir`
// 'down' sits on the bottom edge (card floats above the vehicle); 'up' sits on
// the top edge (card flipped below). Only its two outer faces carry a border so
// it reads as a tail, not a full square.
const TAIL = 13;
function Tail({ tailRef, dir }) {
  const down = dir === 'down';
  return (
    <div
      ref={tailRef}
      aria-hidden
      className="pointer-events-none absolute h-[13px] w-[13px] -translate-x-1/2 rotate-45"
      style={{
        left: '50%',
        [down ? 'bottom' : 'top']: -(TAIL / 2),
        background: 'hsl(var(--surface) / 0.95)',
        borderRight: down ? '1px solid hsl(var(--border))' : 'none',
        borderBottom: down ? '1px solid hsl(var(--border))' : 'none',
        borderLeft: down ? 'none' : '1px solid hsl(var(--border))',
        borderTop: down ? 'none' : '1px solid hsl(var(--border))',
      }}
    />
  );
}

export default function VehicleCard() {
  const sel = useSlice(selected);
  const pnl = useSlice(panels);
  const [, tick] = React.useReducer((x) => x + 1, 0);
  React.useEffect(() => { const t = setInterval(tick, 1000); return () => clearInterval(t); }, []);

  const wrapRef = React.useRef(null);
  const tailDownRef = React.useRef(null);
  const tailUpRef = React.useRef(null);

  const selected_ = sel && sel.props;
  // Anchor the card over the live vehicle. We rAF-poll getSelScreen (fresh against
  // the current camera + motion) and write transform/visibility straight to the
  // DOM — no React re-render per frame. Prefers floating ABOVE the vehicle; flips
  // BELOW when there's no room; hides when the vehicle scrolls off-viewport.
  React.useEffect(() => {
    if (!selected_) return undefined;
    const GAP = 16; // px between the tail tip and the vehicle dot
    const M = 8;    // viewport margin
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const el = wrapRef.current;
      if (!el) return;
      const scr = bridge.helpers.getSelScreen ? bridge.helpers.getSelScreen() : null;
      const vw = window.innerWidth, vh = window.innerHeight;
      const off = !scr || !scr.onScreen || scr.x < -40 || scr.x > vw + 40 || scr.y < -40 || scr.y > vh + 40;
      if (off) { el.style.opacity = '0'; el.style.pointerEvents = 'none'; return; }
      const w = el.offsetWidth, h = el.offsetHeight;
      let below = false;
      let top = scr.y - h - GAP;
      if (top < M) { top = scr.y + GAP; below = true; }
      let left = scr.x - w / 2;
      left = Math.max(M, Math.min(left, vw - w - M));
      el.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`;
      el.style.opacity = '1';
      el.style.pointerEvents = 'auto';
      // tails: show the one on the side facing the vehicle, aligned to its real x
      const tx = Math.max(16, Math.min(scr.x - left, w - 16));
      const dn = tailDownRef.current, up = tailUpRef.current;
      if (dn) { dn.style.display = below ? 'none' : 'block'; dn.style.left = `${Math.round(tx)}px`; }
      if (up) { up.style.display = below ? 'block' : 'none'; up.style.left = `${Math.round(tx)}px`; }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [selected_]);

  // Lazy seznam-autobusu vehicle card (model + photos), keyed on operator+fleet#.
  // The api resolves+scrapes+caches; we just fetch and render when found. Aborts
  // on selection change; failures/misses simply render no extra section.
  const reg = selected_ ? selected_.reg : null;
  const op = selected_ ? selected_.op : null;
  const [card, setCard] = React.useState(null); // null | {found:false} | {found:true,...}
  React.useEffect(() => {
    setCard(null);
    if (!reg || !op) return undefined;
    const base = (bridge.helpers && bridge.helpers.apiBase) || '';
    const ctrl = new AbortController();
    fetch(`${base}/api/vehicle-card/${encodeURIComponent(reg)}?op=${encodeURIComponent(op)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setCard(d); })
      .catch(() => { /* aborted or network error — stay silent */ });
    return () => ctrl.abort();
  }, [reg, op]);

  if (!sel || !sel.props) return null;
  if (pnl && pnl.cardHidden) return null;   // closed while following — card hidden, follow lives on
  const p = sel.props;
  const delay = fmtDelay(p.dl);
  // Speed/at-stop from our OWN derived motion (p.kmh / p.moving), NOT Golemio's
  // state_position — that field over-reports 'at_stop' for trams (which also report
  // no speed), so a moving tram used to read "at stop" forever.
  const kmh = p.kmh != null ? p.kmh : (p.spd != null && p.spd !== '' ? Number(p.spd) : null);
  const stopped = p.moving === false || (p.moving == null && kmh != null && kmh < 3);

  return (
    <div
      ref={wrapRef}
      className="pointer-events-auto fixed left-0 top-0 z-30 w-[260px] opacity-0 will-change-transform"
    >
      <Tail tailRef={tailDownRef} dir="down" />
      <Tail tailRef={tailUpRef} dir="up" />
      <div className="glass overflow-hidden rounded-2xl shadow-glass">
        {/* header */}
        <div className="flex items-start gap-3 px-4 pt-3.5">
          <LineBadge line={p.line} color={p.color} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-caption font-medium text-muted-foreground">
              <span>{MODE_LABELS[p.mode] || p.mode}</span>
              <span className={cn('font-semibold', toneClass[delay.tone])}>· {delay.text}</span>
            </div>
            {p.hdsg && <div className="truncate text-body font-semibold">→ {p.hdsg}</div>}
          </div>
          <button
            type="button"
            title={sel.follow ? 'Hide card (keeps following)' : 'Close'}
            onClick={() => (sel.follow ? bridge.actions.hideCard?.() : bridge.actions.clearSelection?.())}
            className="-mr-1 -mt-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* metrics */}
        <div className="mt-3 grid grid-cols-2 gap-2 px-4">
          <div className="rounded-lg bg-muted/40 px-2.5 py-2">
            <div className="text-caption uppercase tracking-wide text-muted-foreground">Delay</div>
            <div className={cn('tnum text-sm font-semibold', toneClass[delay.tone])}>{delay.text}</div>
          </div>
          <div className="rounded-lg bg-muted/40 px-2.5 py-2">
            <div className="text-caption uppercase tracking-wide text-muted-foreground">Speed</div>
            <div className="tnum flex items-center gap-1 text-sm font-semibold">
              <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
              {kmh == null ? '—' : (stopped ? 'stopped' : `${Math.round(kmh)} km/h`)}
            </div>
          </div>
        </div>

        {/* next stop */}
        {p.ns && p.ns.name && (
          <div className="mt-2 px-4">
            <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2.5 py-2">
              <MapPin className={cn('h-4 w-4 shrink-0', stopped ? 'text-live' : 'text-primary')} />
              <div className="min-w-0 flex-1">
                <div className="text-caption uppercase tracking-wide text-muted-foreground">Next stop</div>
                <div className="truncate text-sm font-medium">{p.ns.name}</div>
              </div>
              {p.ns.eta != null && <Badge variant="secondary" className="tnum shrink-0">{fmtEta(p.ns.eta)}</Badge>}
            </div>
          </div>
        )}

        {/* badges: dwell / canceled / amenities */}
        {(stopped || p.canc || p.ac || p.usb || p.wheel) && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 px-4">
            {p.canc && <Badge variant="warn">Cancelled</Badge>}
            {stopped && !p.canc && <Badge variant="secondary">At stop</Badge>}
            <Amenity ok={p.ac} Icon={Snowflake} label="Air conditioned" />
            <Amenity ok={p.usb} Icon={Usb} label="USB charging" />
            <Amenity ok={p.wheel} Icon={Accessibility} label="Wheelchair accessible" />
          </div>
        )}

        {/* meta: fleet # / operator / train # */}
        {(p.reg || p.op || p.tnum) && (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 text-caption text-muted-foreground">
            {p.reg && <span className="flex items-center gap-1"><Hash className="h-3 w-3" />{p.reg}</span>}
            {p.op && <span className="font-medium">{p.op}</span>}
            {p.tnum && <span>Train #{p.tnum}</span>}
          </div>
        )}

        {/* Seznam-autobusu vehicle card: photo strip + model + attribution link */}
        {card && card.found && (
          <div className="mt-2.5 px-4">
            {card.photos && card.photos.length ? (
              <div className="-mx-0.5 flex gap-1.5 overflow-x-auto px-0.5 pb-1">
                {card.photos.slice(0, 8).map((ph, i) => (
                  <a
                    key={i}
                    href={ph.full}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block shrink-0"
                    title="Open full photo (seznam-autobusu.cz)"
                  >
                    <img
                      src={ph.thumb}
                      alt=""
                      loading="lazy"
                      className="h-14 w-[84px] rounded-md object-cover ring-1 ring-border/60 transition-transform hover:scale-[1.03]"
                    />
                  </a>
                ))}
              </div>
            ) : null}
            <a
              href={card.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1.5 flex items-center gap-2 text-caption text-muted-foreground transition-colors hover:text-foreground"
            >
              {card.type ? <span className="truncate font-medium text-foreground/80">{card.type}</span> : null}
              <span className="ml-auto inline-flex shrink-0 items-center gap-0.5">
                seznam-autobusu.cz <ExternalLink className="h-3 w-3" />
              </span>
            </a>
          </div>
        )}

        <Separator className="mt-3" />

        {/* actions */}
        <div className="flex items-center gap-2 p-3">
          <Button
            variant={sel.follow ? 'default' : 'outline'}
            size="sm"
            className="flex-1 gap-2"
            onClick={() => bridge.actions.toggleFollow?.()}
          >
            <Navigation className={cn('h-3.5 w-3.5', sel.follow && 'fill-current')} />
            {sel.follow ? 'Following' : 'Follow'}
          </Button>
          <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => bridge.actions.flyToVehicle?.(p.id)}>
            <Crosshair className="h-3.5 w-3.5" /> Center
          </Button>
        </div>
      </div>
    </div>
  );
}
