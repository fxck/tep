// Narration.jsx — the "ride-along" status rail (bottom-centre). Renders only when
// a vehicle is selected. Shows the line, destination, rolling-stock MODEL, next
// stop + ETA, delay, speed, fleet #/operator, and a Follow toggle that STOPS
// following when it's active. Re-renders on the `selected` slice; a 1s tick keeps
// ETA/delay fresh.

import { useEffect, useState } from 'react';
import { Navigation, Hash, Snowflake, Usb, Accessibility } from 'lucide-react';

import { useSlice, selected, bridge } from '../lib/bridge.js';
import { fmtEta, fmtDelay } from '../lib/format.js';
import { cn } from '../lib/cn.js';
import { Badge } from '../ui/badge.jsx';
import LineBadge from './LineBadge.jsx';

const TONE_VARIANT = { live: 'live', warn: 'warn', amber: 'warn', muted: 'muted' };

function Amenity({ ok, Icon, label }) {
  if (!ok) return null;
  return <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-label={label} />;
}

export default function Narration() {
  const sel = useSlice(selected);
  const [, setTick] = useState(0);
  const props = sel && sel.props ? sel.props : null;

  useEffect(() => {
    if (!props) return undefined;
    const id = setInterval(() => setTick((t) => (t + 1) % 1000000), 1000);
    return () => clearInterval(id);
  }, [props]);

  if (!props) return null;

  const ns = props.ns;
  const delay = fmtDelay(props.dl);
  const showDelay = delay && delay.text !== '—';
  // Derived motion (km/h) — reported spd is null for rail, and Golemio's
  // state_position over-reports 'at_stop' for trams, so trust our velocity estimate.
  const kmh = props.kmh != null ? props.kmh : (props.spd != null && props.spd !== '' ? Number(props.spd) : null);
  const stopped = props.moving === false || (props.moving == null && kmh != null && kmh < 3);
  const showSpeed = !stopped && kmh != null && Number.isFinite(kmh) && kmh >= 3;
  const following = !!sel.follow;
  const hasAmenity = props.ac || props.usb || props.wheel;

  const Sep = () => <span className="select-none text-muted-foreground/40">·</span>;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'surface fixed bottom-6 left-1/2 z-20 -translate-x-1/2 animate-slide-in-up',
        'flex max-w-[min(95vw,900px)] items-center gap-2.5 whitespace-nowrap rounded-full py-1.5 pl-1.5 pr-1.5',
        'text-body leading-tight text-foreground'
      )}
      style={{ boxShadow: 'var(--shadow-2)' }}
    >
      <LineBadge line={props.line} color={props.color} size="md" />

      <span className="min-w-0 shrink truncate font-semibold">
        Line {props.line}
        {props.hdsg ? <span className="font-normal text-muted-foreground"> → {props.hdsg}</span> : null}
      </span>

      {props.model ? (
        <><Sep /><span className="hidden shrink-0 truncate text-muted-foreground sm:inline">{props.model}</span></>
      ) : null}

      {ns && ns.name ? (
        <>
          <Sep />
          <span className="min-w-0 truncate">
            {stopped ? 'At' : 'Approaching'} <span className="font-semibold">{ns.name}</span>
            {!stopped && ns.eta != null ? <span className="font-semibold text-status-late"> {fmtEta(ns.eta)}</span> : null}
          </span>
        </>
      ) : null}

      {showDelay ? (
        <><Sep /><Badge variant={TONE_VARIANT[delay.tone] || 'muted'} className="tnum shrink-0">{delay.text}</Badge></>
      ) : null}

      {showSpeed ? (
        <><Sep /><span className="tnum hidden shrink-0 text-muted-foreground md:inline">{Math.round(kmh)} km/h</span></>
      ) : null}

      {hasAmenity ? (
        <>
          <Sep />
          <span className="hidden shrink-0 items-center gap-1.5 md:inline-flex">
            <Amenity ok={props.ac} Icon={Snowflake} label="Air conditioned" />
            <Amenity ok={props.usb} Icon={Usb} label="USB charging" />
            <Amenity ok={props.wheel} Icon={Accessibility} label="Wheelchair accessible" />
          </span>
        </>
      ) : null}

      {props.reg || props.op ? (
        <>
          <Sep />
          <span className="hidden shrink-0 items-center gap-1 text-caption text-muted-foreground lg:inline-flex">
            {props.reg ? <><Hash className="h-3 w-3" />{props.reg}</> : null}
            {props.op ? <span className="ml-1">{props.op}</span> : null}
          </span>
        </>
      ) : null}

      <button
        type="button"
        onClick={() => bridge.actions.toggleFollow?.()}
        aria-pressed={following}
        title={following ? 'Stop following' : 'Follow this vehicle'}
        className={cn(
          'ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-label transition-colors',
          following ? 'bg-accent text-accent-foreground hover:brightness-110' : 'bg-surface-2 text-foreground hover:bg-muted'
        )}
      >
        <Navigation className={cn('h-3.5 w-3.5', following && 'fill-current')} />
        {following ? 'Following' : 'Follow'}
      </button>
    </div>
  );
}
