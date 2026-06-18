import React from 'react';
import { cn } from '../lib/cn.js';

// Pick a readable text color (ink or white) for a given line/mode background using
// WCAG relative luminance — fixes white-on-light-livery contrast bugs (e.g. metro
// green, or any pale line color). Memoized by the caller via the hex.
function inkOn(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length < 6) return '#ffffff';
  const toLin = (c) => { const x = parseInt(c, 16) / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * toLin(h.slice(0, 2)) + 0.7152 * toLin(h.slice(2, 4)) + 0.0722 * toLin(h.slice(4, 6));
  return L > 0.5 ? '#0b0e14' : '#ffffff';
}

const SIZES = {
  sm: 'h-6 min-w-[1.5rem] px-1.5 text-caption',
  md: 'h-7 min-w-[1.75rem] px-2 text-label',
  lg: 'h-9 min-w-[2.5rem] px-2.5 text-base',
};

// ONE shared line/route chip. background = the mode/line color; text auto-contrasts.
// Defaults to neutral grey when no color is supplied.
export function LineBadge({ line, color, size = 'md', className, ...rest }) {
  const bg = color || '#7A8290';
  const fg = React.useMemo(() => inkOn(bg), [bg]);
  return (
    <span
      className={cn('inline-grid place-items-center rounded-lg font-extrabold tnum leading-none', SIZES[size] || SIZES.md, className)}
      style={{ background: bg, color: fg }}
      {...rest}
    >
      {line}
    </span>
  );
}

export default LineBadge;
