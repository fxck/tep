// daterange.jsx — a compact date+time RANGE picker (no external dep).
//
// A trigger button shows the current window summary; clicking opens a Popover with
// quick presets, a single-month calendar for picking the start→end DAYS (range
// highlight), and two time-of-day fields. "Apply" commits {from,to} as unix ms.
// Built for the Time Machine replay window (recent history), but generic.

import React from 'react';
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../lib/cn.js';
import { Popover, PopoverTrigger, PopoverContent } from './popover.jsx';

const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

const atMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// Combine a day Date (midnight) + "HH:MM" -> unix ms in local tz.
function combine(day, time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time || '00:00');
  const hh = m ? Math.min(23, +m[1]) : 0;
  const mm = m ? Math.min(59, +m[2]) : 0;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hh, mm, 0, 0).getTime();
}

function fmtSummary(from, to) {
  const f = new Date(from), t = new Date(to);
  const fd = `${MONTHS[f.getMonth()]} ${f.getDate()}`;
  const td = `${MONTHS[t.getMonth()]} ${t.getDate()}`;
  if (sameDay(f, t)) return `${fd} · ${pad(f.getHours())}:${pad(f.getMinutes())} – ${pad(t.getHours())}:${pad(t.getMinutes())}`;
  return `${fd} ${pad(f.getHours())}:${pad(f.getMinutes())} → ${td} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

// Month grid (Mon-first) for the given view Date; returns weeks of Date|null cells.
function monthGrid(view) {
  const y = view.getFullYear(), m = view.getMonth();
  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7; // Mon=0
  const days = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(new Date(y, m, d));
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

const PRESETS = [
  { label: '15 min', min: 15 },
  { label: '30 min', min: 30 },
  { label: '1 h', min: 60 },
  { label: '3 h', min: 180 },
];

export default function DateRangePicker({ from, to, onChange, className }) {
  const [open, setOpen] = React.useState(false);
  // Draft state, seeded from props each time the popover opens.
  const [startDay, setStartDay] = React.useState(() => atMidnight(new Date(from)));
  const [endDay, setEndDay] = React.useState(() => atMidnight(new Date(to)));
  const [startTime, setStartTime] = React.useState(() => hhmm(from));
  const [endTime, setEndTime] = React.useState(() => hhmm(to));
  const [view, setView] = React.useState(() => atMidnight(new Date(to)));
  const [pickingEnd, setPickingEnd] = React.useState(false);

  const seed = () => {
    setStartDay(atMidnight(new Date(from)));
    setEndDay(atMidnight(new Date(to)));
    setStartTime(hhmm(from));
    setEndTime(hhmm(to));
    setView(atMidnight(new Date(to)));
    setPickingEnd(false);
  };

  const pickDay = (d) => {
    if (!pickingEnd) { setStartDay(d); setEndDay(d); setPickingEnd(true); return; }
    if (d < startDay) { setStartDay(d); setEndDay(d); return; } // clicked before start → restart
    setEndDay(d); setPickingEnd(false);
  };

  const applyPreset = (min) => {
    const now = Date.now();
    onChange?.({ from: now - min * 60000, to: now });
    setOpen(false);
  };

  const apply = () => {
    let f = combine(startDay, startTime);
    let t = combine(endDay, endTime);
    if (t <= f) t = f + 60000; // guard: ensure To > From
    onChange?.({ from: f, to: t });
    setOpen(false);
  };

  const weeks = monthGrid(view);
  const today = atMidnight(new Date());
  const inRange = (d) => d && d >= startDay && d <= endDay;

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) seed(); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2 rounded-xl border border-input bg-surface-2/60 px-3 py-2 text-left text-label transition-colors hover:bg-surface-2',
            className,
          )}
        >
          <CalendarIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="tnum truncate">{fmtSummary(from, to)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[288px] p-3" align="start">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.min}
              type="button"
              onClick={() => applyPreset(p.min)}
              className="rounded-full border border-border/60 bg-surface-2/50 px-2.5 py-1 text-caption font-semibold text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              Last {p.label}
            </button>
          ))}
        </div>

        {/* month nav */}
        <div className="mb-1.5 flex items-center justify-between px-1">
          <button type="button" aria-label="Previous month" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))} className="rounded-md p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"><ChevronLeft className="h-4 w-4" /></button>
          <span className="text-label font-semibold">{MONTHS[view.getMonth()]} {view.getFullYear()}</span>
          <button type="button" aria-label="Next month" onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))} className="rounded-md p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"><ChevronRight className="h-4 w-4" /></button>
        </div>

        <div className="grid grid-cols-7 gap-0.5 text-center">
          {DOW.map((d) => <div key={d} className="py-1 text-[10px] font-semibold uppercase text-muted-foreground">{d}</div>)}
          {weeks.flat().map((d, i) => {
            if (!d) return <div key={i} />;
            const isStart = sameDay(d, startDay), isEnd = sameDay(d, endDay);
            const within = inRange(d);
            const future = d > today;
            return (
              <button
                key={i}
                type="button"
                disabled={future}
                onClick={() => pickDay(d)}
                className={cn(
                  'tnum aspect-square rounded-md text-caption transition-colors',
                  future && 'cursor-not-allowed opacity-30',
                  !within && !future && 'hover:bg-muted/60',
                  within && !(isStart || isEnd) && 'bg-accent/15 text-foreground',
                  (isStart || isEnd) && 'bg-accent font-bold text-accent-foreground',
                  sameDay(d, today) && !(isStart || isEnd) && 'ring-1 ring-inset ring-accent/50',
                )}
              >
                {d.getDate()}
              </button>
            );
          })}
        </div>

        {/* time-of-day */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">From</span>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="rounded-lg border border-input bg-surface-2/60 px-2 py-1.5 text-label outline-none focus:ring-2 focus:ring-ring" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">To</span>
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="rounded-lg border border-input bg-surface-2/60 px-2 py-1.5 text-label outline-none focus:ring-2 focus:ring-ring" />
          </label>
        </div>

        <button
          type="button"
          onClick={apply}
          className="mt-3 w-full rounded-lg bg-accent px-3 py-2 text-label font-semibold text-accent-foreground transition-opacity hover:opacity-90"
        >
          Apply range
        </button>
      </PopoverContent>
    </Popover>
  );
}
