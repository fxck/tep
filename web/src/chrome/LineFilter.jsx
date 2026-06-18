import React from 'react';
import { X } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { useSlice, filters, bridge } from '../lib/bridge.js';
import LineBadge from './LineBadge.jsx';

// Multi-value line filter: type to autocomplete from the live line list, Enter or
// click to add a chip, Backspace on an empty field removes the last chip. Matches
// ANY of the picked lines (engine ui.lines). Suggestions come from
// bridge.helpers.getLines() (mode-ordered, with live counts).
export default function LineFilter() {
  const f = useSlice(filters);
  const active = f.lines || [];
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [hi, setHi] = React.useState(0);
  const inputRef = React.useRef(null);

  // Re-pull the line list when the field is focused or the query changes (cheap;
  // the fleet is ~650). Keeps suggestions fresh without a per-frame subscription.
  const all = React.useMemo(
    () => (bridge.helpers && bridge.helpers.getLines ? bridge.helpers.getLines() : []),
    [open, q]
  );
  const colorOf = (key) => (all.find((e) => e.key === key) || {}).color || '#7A8290';

  const sugg = React.useMemo(() => {
    const qq = q.trim().toUpperCase();
    const activeSet = new Set(active);
    let pool = all.filter((e) => !activeSet.has(e.key));
    if (qq) {
      pool = pool.filter((e) => e.key.startsWith(qq) || e.key.includes(qq));
      pool.sort((a, b) => (a.key.startsWith(qq) ? 0 : 1) - (b.key.startsWith(qq) ? 0 : 1));
    }
    return pool.slice(0, 8);
  }, [all, q, active]);

  React.useEffect(() => { setHi(0); }, [q]);

  const add = (key) => {
    if (!key) return;
    bridge.actions.addLine?.(key);
    setQ('');
    inputRef.current?.focus();
  };
  const remove = (key) => bridge.actions.removeLine?.(key);

  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = sugg[hi] || (q.trim() ? { key: q.trim().toUpperCase() } : null);
      if (pick) add(pick.key);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHi((h) => Math.min(h + 1, Math.max(sugg.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Backspace' && !q && active.length) {
      remove(active[active.length - 1]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-input bg-surface-2/60 p-1.5 focus-within:ring-2 focus-within:ring-ring">
        {active.map((key) => (
          <span key={key} className="inline-flex items-center gap-1 rounded-lg bg-surface-2 py-0.5 pl-0.5 pr-1">
            <LineBadge line={key} color={colorOf(key)} size="sm" />
            <button
              type="button"
              onClick={() => remove(key)}
              aria-label={`Remove line ${key}`}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 130)}
          onKeyDown={onKey}
          aria-label="Filter by line"
          placeholder={active.length ? 'Add line…' : 'Filter lines — 22, 9, A, S7…'}
          className="min-w-[96px] flex-1 bg-transparent px-1 py-0.5 text-label outline-none placeholder:text-muted-foreground"
        />
        {active.length ? (
          <button
            type="button"
            onClick={() => bridge.actions.clearLines?.()}
            className="ml-auto rounded-md px-1.5 py-0.5 text-caption text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            Clear
          </button>
        ) : null}
      </div>

      {open && sugg.length ? (
        <div
          className="absolute left-0 right-0 top-full z-10 mt-1 max-h-60 overflow-auto rounded-xl border border-border/60 bg-surface p-1"
          style={{ boxShadow: 'var(--shadow-1)' }}
        >
          {sugg.map((e, i) => (
            <button
              key={e.key}
              type="button"
              onMouseDown={(ev) => { ev.preventDefault(); add(e.key); }}
              onMouseEnter={() => setHi(i)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left',
                i === hi ? 'bg-muted' : 'hover:bg-muted/50'
              )}
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
