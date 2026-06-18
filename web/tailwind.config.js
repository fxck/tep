/** @type {import('tailwindcss').Config} */
export default {
  // Preflight OFF: this app coexists with MapLibre's own DOM/CSS and a legacy
  // style.css. A global reset would break map controls/popups. We scope a minimal
  // reset to .pid-ui in globals.css instead.
  corePlugins: { preflight: false },
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter var', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Semantic type scale — type IS the hierarchy. Use text-display/title/body/
      // label/caption instead of hand-rolled arbitrary sizes. 13px body / 12px
      // caption floor (no more text-[10px]/[11px]).
      fontSize: {
        display: ['2rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em', fontWeight: '600' }],
        title: ['1.25rem', { lineHeight: '1.75rem', fontWeight: '600' }],
        body: ['0.9375rem', { lineHeight: '1.375rem' }],
        label: ['0.8125rem', { lineHeight: '1rem', fontWeight: '500' }],
        caption: ['0.75rem', { lineHeight: '1rem', fontWeight: '500' }],
      },
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        surface: { DEFAULT: 'hsl(var(--surface))', 2: 'hsl(var(--surface-2))' },
        primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
        secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
        muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
        accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
        destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
        card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
        popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
        live: 'hsl(var(--live))',
        warn: 'hsl(var(--warn))',
        // two-axis system: mode = identity, status = attention (red == late only)
        mode: {
          tram: 'var(--mode-tram)', metro: 'var(--mode-metro)', bus: 'var(--mode-bus)',
          train: 'var(--mode-train)', trolley: 'var(--mode-trolley)', other: 'var(--mode-other)',
        },
        status: {
          ontime: 'var(--status-ontime)', late: 'var(--status-late)',
          verylate: 'var(--status-verylate)', early: 'var(--status-early)',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
        xl: 'calc(var(--radius) + 4px)',
      },
      boxShadow: {
        glass: '0 8px 40px -8px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04)',
        panel: '0 12px 48px -12px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.05)',
      },
      keyframes: {
        'accordion-down': { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
        'accordion-up': { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-in-left': { from: { opacity: '0', transform: 'translateX(-8px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'slide-in-right': { from: { opacity: '0', transform: 'translateX(8px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'slide-in-up': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        pulse: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.45' } },
      },
      animation: {
        'fade-in': 'fade-in 0.18s ease-out',
        'slide-in-left': 'slide-in-left 0.22s cubic-bezier(0.22,1,0.36,1)',
        'slide-in-right': 'slide-in-right 0.22s cubic-bezier(0.22,1,0.36,1)',
        'slide-in-up': 'slide-in-up 0.22s cubic-bezier(0.22,1,0.36,1)',
        'pulse-dot': 'pulse 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
