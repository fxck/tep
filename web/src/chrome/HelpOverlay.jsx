// HelpOverlay.jsx — keyboard-shortcuts help dialog.
//
// React port of the legacy shortcuts.js "?" overlay. Open state is the `help`
// panel slice (toggled by useShortcuts via "?"/Esc). Renders a clean two-column
// grid of every binding, each row pairing a human description with its <Kbd>
// keycap(s).

import { useSlice, panels } from '../lib/bridge.js';
import { cn } from '../lib/cn.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog.jsx';
import { Kbd } from '../ui/kbd.jsx';
import { SHORTCUTS } from '../lib/shortcuts.js'; // single source — shared with useShortcuts

function Row({ keys, desc }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 transition-colors hover:bg-muted/40">
      <span className="min-w-0 truncate text-[13px] text-muted-foreground">
        {desc}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {keys.map((k, i) => (
          <Kbd
            key={i}
            className="border-border/60 bg-background/60 px-1.5 py-1 text-[11px] font-semibold text-foreground shadow-sm"
          >
            {k}
          </Kbd>
        ))}
      </span>
    </div>
  );
}

export default function HelpOverlay() {
  const open = useSlice(panels).help;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => panels.set((s) => ({ ...s, help: v }))}
    >
      <DialogContent className="max-w-xl border-border/60 shadow-glass">
        <DialogHeader>
          <DialogTitle className="text-[15px] font-bold tracking-tight">
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription className="sr-only">
            A list of every keyboard shortcut and the key that triggers it.
          </DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            'grid grid-cols-1 gap-2 sm:grid-cols-2',
          )}
        >
          {SHORTCUTS.map((s, i) => (
            <Row key={i} keys={s.keys} desc={s.desc} />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
