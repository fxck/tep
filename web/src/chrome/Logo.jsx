import React from 'react';

// Tep — "pulse" (Czech). The mark is a single ECG/heartbeat stroke that spikes
// once and ends in a beating dot: the city's live pulse. The line takes
// currentColor (so it inherits foreground); the beat dot is live-green and gently
// pulses when `live` is set (it doubles as the feed-alive signal).
export function LogoMark({ size = 22, live = false, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M1.5 17 H8.5 L12 8.5 L16 24 L19.5 14 H23.5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="27" cy="16" r="3" fill="hsl(var(--live))" className={live ? 'animate-pulse-dot' : undefined} />
    </svg>
  );
}

// Full lockup: mark + "Tep" wordmark. Used in the Wisp.
export function Logo({ size = 22, live = false, className }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className || ''}`}>
      <LogoMark size={size} live={live} />
      <span className="text-label font-extrabold tracking-tight text-foreground">Tep</span>
    </span>
  );
}

export default Logo;
