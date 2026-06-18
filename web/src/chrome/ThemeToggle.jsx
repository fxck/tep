// ThemeToggle.jsx — Day / Night / Auto chrome theme control.
//
// Purely presentational: theme state + application now live in lib/theme.js (a
// module store) so the theme applies on app load whether or not this control —
// which lives inside the AppBar's "More" popover — is currently mounted. This
// reads the mode reactively and writes via setMode(); all DOM/engine side effects
// happen in the store.

import { useSyncExternalStore } from 'react';
import { Sun, Moon, SunMoon } from 'lucide-react';

import { cn } from '../lib/cn.js';
import { getMode, setMode, subscribe } from '../lib/theme.js';

const SEGMENTS = [
  { mode: 'auto', label: 'Auto theme', Icon: SunMoon },
  { mode: 'day', label: 'Day theme', Icon: Sun },
  { mode: 'night', label: 'Night theme', Icon: Moon },
];

export default function ThemeToggle() {
  const mode = useSyncExternalStore(subscribe, getMode, getMode);

  return (
    <div
      role="group"
      aria-label="Theme"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-muted/30 p-0.5 shadow-glass"
    >
      {SEGMENTS.map(({ mode: m, label, Icon }) => {
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={active}
            onClick={() => setMode(m)}
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'bg-foreground text-background shadow-sm'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}
