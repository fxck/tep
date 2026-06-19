import React from 'react';

// Open-source / Made-on-Zerops attribution. Shown in TWO places: a persistent
// pill (bottom-left, the <Credit/> default export) and as rows in the AppBar
// "More" popover (<CreditLinks/>).
//
// Inline marks instead of lucide imports: avoids depending on brand-icon exports
// that lucide has churned across versions, and lets us use the real Zerops logo.
function GitHubMark({ className }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

// The official Zerops mark — the two-tone isometric cube, rendered inline so it
// stays crisp at any size and needs no asset fetch. `__main` faces in brand yellow,
// `__secondary` faces a shade deeper for the lit-cube depth. Sized by HEIGHT with a
// proportional width (the artwork is taller than wide, 42.27 × 50.48).
function ZeropsMark({ className, size = 15 }) {
  const w = +(size * 42.27 / 50.48).toFixed(2);
  return (
    <svg viewBox="0 0 42.27 50.48" width={w} height={size} aria-hidden="true" className={className}>
      <path fill="#F4C400" d="M20.19.7L3 7.27A4 4 0 0 0 .46 11v16.54L8.36 23v-9.3L21.6 8.62V.44a4 4 0 0 0-1.41.26z" transform="translate(-.46 -.44)" />
      <path fill="#F4C400" d="M8.5 37.74l13.1-7.55v-9.12L1.36 32.74a1.82 1.82 0 0 0-.9 1.56v6.11A4 4 0 0 0 3 44.1l17.19 6.57a4 4 0 0 0 1.41.26v-8.18z" transform="translate(-.46 -.44)" />
      <path fill="#FFDA2D" d="M41.9 18.47a1.67 1.67 0 0 0 .84-1.47v-6a4 4 0 0 0-2.54-3.73L23 .7a4 4 0 0 0-1.4-.26v8.18l13 5-13 7.49v9.12z" transform="translate(-.46 -.44)" />
      <path fill="#FFDA2D" d="M23 50.67l17.2-6.57a4 4 0 0 0 2.54-3.69V23.7l-7.9 4.56v9.43L21.6 42.75v8.18a4 4 0 0 0 1.4-.26z" transform="translate(-.46 -.44)" />
    </svg>
  );
}

// Floating pill — bottom-left, always visible.
export default function Credit() {
  return (
    <div className="surface fixed bottom-3 left-3 z-10 flex items-center gap-2 rounded-full px-3 py-1.5 text-xs text-muted-foreground shadow-[var(--shadow-1)]">
      <a
        href="https://github.com/fxck/tep"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 font-medium transition-colors hover:text-foreground"
        title="Tep is open source on GitHub"
      >
        <GitHubMark />
        Open source
      </a>
      <span aria-hidden="true" className="opacity-40">·</span>
      <a
        href="https://zerops.io"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
        title="Built and hosted on Zerops"
      >
        <ZeropsMark size={13} />
        Made on <span className="font-semibold text-foreground">Zerops</span>
      </a>
    </div>
  );
}

// Same attribution as rows for the AppBar "More" popover.
export function CreditLinks() {
  return (
    <>
      <div aria-hidden className="my-1 h-px bg-border/60" />
      <a
        href="https://github.com/fxck/tep"
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-body hover:bg-muted/60"
      >
        <GitHubMark className="h-4 w-4 shrink-0" /> Open source
      </a>
      <a
        href="https://zerops.io"
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-body hover:bg-muted/60"
      >
        <ZeropsMark size={16} className="shrink-0" /> Made on <span className="font-semibold text-foreground">Zerops</span>
      </a>
    </>
  );
}
