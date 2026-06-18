// shortcuts.js — the single canonical keyboard-binding list, shared by the handler
// (useShortcuts) and the help overlay (HelpOverlay) so they can never drift.
//
// Each entry: `keys` (display keycaps) + `desc` + `match(e)` predicate + `action(ctx)`.
// Flags: `global` runs even while typing / with a modifier held (Esc, ⌘K);
// `prevent:false` skips preventDefault (Esc). ctx = { run, togglePanel, openPalette, escape }.
export const SHORTCUTS = [
  { keys: ['?'], desc: 'Show / hide this help',
    match: (e) => e.key === '?', action: (c) => c.togglePanel('help') },
  { keys: ['2'], desc: 'Switch to 2D view',
    match: (e) => e.key === '2', action: (c) => c.run('set2D') },
  { keys: ['3'], desc: 'Switch to 3D view',
    match: (e) => e.key === '3', action: (c) => c.run('set3D') },
  { keys: ['F'], desc: 'Follow the selected vehicle',
    match: (e) => e.key === 'f' || e.key === 'F', action: (c) => c.run('toggleFollow') },
  { keys: ['C'], desc: 'Clear the current selection',
    match: (e) => e.key === 'c' || e.key === 'C', action: (c) => c.run('clearSelection') },
  { keys: ['I'], desc: 'Toggle the insights dashboard',
    match: (e) => e.key === 'i' || e.key === 'I', action: (c) => c.togglePanel('insights') },
  { keys: ['/'], desc: 'Open the command palette',
    match: (e) => e.key === '/', action: (c) => c.openPalette() },
  { keys: ['⌘', 'K'], desc: 'Open the command palette', global: true,
    match: (e) => (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K'), action: (c) => c.openPalette() },
  { keys: ['Esc'], desc: 'Close overlays / clear selection', global: true, prevent: false,
    match: (e) => e.key === 'Escape', action: (c) => c.escape() },
];
