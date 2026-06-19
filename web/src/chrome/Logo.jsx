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
        d="M2 16 H10 L12.5 7.5 L15.5 24.5 L17.5 13.5 L20 16 H22"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="26.5" cy="16" r="3.2" fill="hsl(var(--live))" className={live ? 'animate-pulse-dot' : undefined} />
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
