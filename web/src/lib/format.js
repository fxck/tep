// Shared labels, colors and formatters for the React chrome. Mirrors the engine's
// MODE_LABELS / FILTER_MODES / LEGEND so every surface renders identically.

export const MODE_LABELS = {
  tram: 'Tram', metro: 'Metro', train: 'Train', bus: 'Bus',
  trolleybus: 'Trolleybus', ferry: 'Ferry', funicular: 'Funicular',
  cablecar: 'Cable car', gondola: 'Gondola', other: 'Other',
};

// Filter groups (the 5 primary modes + an "other" long-tail bucket).
export const FILTER_MODES = [
  { key: 'tram', label: 'Tram', color: '#D2192C' },
  { key: 'metro', label: 'Metro', color: '#00A562' },
  { key: 'bus', label: 'Bus', color: '#007DA8' },
  { key: 'train', label: 'Train', color: '#1A66B0' },
  { key: 'trolleybus', label: 'Trolleybus', color: '#8E44AD' },
  { key: 'other', label: 'Other', color: '#7A8290' },
];

export const MODE_COLORS = Object.fromEntries(FILTER_MODES.map((m) => [m.key, m.color]));

// Delay in seconds -> compact human string. Returns { text, tone }.
export function fmtDelay(sec) {
  if (sec == null || sec === '') return { text: '—', tone: 'muted' };
  const n = Number(sec);
  if (!isFinite(n)) return { text: '—', tone: 'muted' };
  const m = Math.round(n / 60);
  if (m === 0) return { text: 'on time', tone: 'live' };
  if (m > 0) return { text: `+${m}m late`, tone: m >= 3 ? 'warn' : 'amber' };
  return { text: `${m}m early`, tone: 'amber' };
}

// ETA seconds -> "3 min" / "now" / "12:04".
export function fmtEta(sec) {
  if (sec == null || sec === '') return '';
  const n = Number(sec);
  if (!isFinite(n)) return '';
  if (n <= 30) return 'now';
  if (n < 3600) return `${Math.round(n / 60)} min`;
  return `${Math.round(n / 3600)} h`;
}

// "updated 3s ago" relative time from a ms-age.
export function fmtAge(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function fmtInt(n) {
  if (n == null || !isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('en-US');
}
